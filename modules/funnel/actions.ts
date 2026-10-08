"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { propose } from "@/lib/approvals/ledger";
import { UserError, messageFor } from "@/lib/errors";
import { fieldErrors, formAction, type FormState } from "@/lib/forms";
import { requireModule } from "@/lib/modules/server";
import { convertLead } from "./convert";
import { addEvent, announceLead, assignLead, BASE, createLead, deleteLead, getSettings, leadUrl, logContact, markReplied, MODULE_ID, P, saveForm, saveSettings, setStatus } from "./data";
import { describeLeadImport, MAX_IMPORT_ROWS, planLeadImport } from "./import";
import { formatMinutes } from "./logic";
import { assignForm, enrollRequest, formConfigForm, importForm, leadIdForm, logContactForm, manualLeadForm, sequenceForm, settingsForm, statusForm } from "./schemas";
import { proposeEnrollment, saveSequence, setSequenceActive } from "./sequences";

/** Every action starts with requireModule(): it checks the person, that Leads is on, and the permission. */

// ── Settings, forms and sequences (owners and admins) ───────────────────────

export const saveSettingsAction = formAction(settingsForm, async (input) => {
  const ctx = await requireModule(MODULE_ID, P.manage);
  await saveSettings(ctx, input);
  refresh();
  return { ok: input.postalAddress ? "Saved." : "Saved. Without a postal address, sequences stay switched off." };
});

export const saveFormAction = formAction(formConfigForm, async (input) => {
  const ctx = await requireModule(MODULE_ID, P.manage);
  const form = await saveForm(ctx, input);
  if (input.id) {
    refresh();
    return { ok: `Saved “${form.name}”.` };
  }
  redirect(`${BASE}/forms/${form.id}`);
});

export const saveSequenceAction = formAction(sequenceForm, async (input) => {
  const ctx = await requireModule(MODULE_ID, P.manage);
  const seq = await saveSequence(ctx, input);
  if (input.id) {
    refresh();
    return { ok: `Saved “${seq.name}”.` };
  }
  redirect(`${BASE}/sequences/${seq.id}`);
});

export const sequenceActiveAction = formAction(z.object({ sequenceId: z.string().uuid(), active: z.enum(["on", "off"]) }), async ({ sequenceId, active }) => {
  const ctx = await requireModule(MODULE_ID, P.manage);
  const seq = await setSequenceActive(ctx, sequenceId, active === "on");
  refresh();
  return { ok: seq.active ? `“${seq.name}” is on: leads can be enrolled.` : `“${seq.name}” is off: no more of its emails go out.` };
});

// ── Working leads (members) ─────────────────────────────────────────────────

export const addLeadAction = formAction(manualLeadForm, async (input) => {
  const ctx = await requireModule(MODULE_ID, P.work);
  const { alreadyContacted, ...values } = input;
  const lead = await createLead(ctx.db, { ...values, formId: null }, ctx.viewer, { alreadyContacted });
  if (!alreadyContacted) await announceLead(lead, (await getSettings(ctx.db)).targetMinutes, ctx.viewer.id);
  redirect(leadUrl(lead.id));
});

export const logContactAction = formAction(logContactForm, async ({ leadId, kind, note }) => {
  const ctx = await requireModule(MODULE_ID, P.work);
  const { first, minutes } = await logContact(ctx.db, leadId, kind, note, ctx.viewer);
  refresh();
  return { ok: first ? `Logged. Speed to lead: ${formatMinutes(minutes)}.` : "Logged." };
});

export const setStatusAction = formAction(statusForm, async ({ leadId, status, reason }) => {
  const ctx = await requireModule(MODULE_ID, P.work);
  const { changed } = await setStatus(ctx.db, leadId, status, reason, ctx.viewer);
  refresh();
  return { ok: changed ? "Status changed." : "The lead already has that status." };
});

export const assignAction = formAction(assignForm, async ({ leadId, assigneeId }) => {
  const ctx = await requireModule(MODULE_ID, P.work);
  await assignLead(ctx, leadId, assigneeId);
  refresh();
  return { ok: assigneeId ? "Assigned." : "Nobody is assigned now." };
});

export const markRepliedAction = formAction(leadIdForm, async ({ leadId }) => {
  const ctx = await requireModule(MODULE_ID, P.work);
  const stopped = await markReplied(ctx, leadId);
  refresh();
  return { ok: stopped ? "Noted. Their sequence emails have stopped." : "Noted." };
});

export const convertAction = formAction(leadIdForm, async ({ leadId }) => {
  const ctx = await requireModule(MODULE_ID, P.work);
  const outcome = await convertLead(ctx, leadId);
  refresh();
  return outcome.state === "waiting" && outcome.approvalId ? { ok: outcome.message, data: { link: `/approvals/${outcome.approvalId}`, linkLabel: "The approval" } } : { ok: outcome.message };
});

export const deleteLeadAction = formAction(leadIdForm, async ({ leadId }) => {
  const ctx = await requireModule(MODULE_ID, P.manage);
  await deleteLead(ctx, leadId);
  redirect(BASE);
});

/** One lead or many (ticked in the list): ONE approval, then the approval page to check and approve it. */
export async function enrollAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let approvalId: string | null = null;
  try {
    const ctx = await requireModule(MODULE_ID, P.work);
    const parsed = enrollRequest.safeParse({ sequenceId: formData.get("sequenceId"), leadIds: formData.getAll("leadId").filter((v) => typeof v === "string" && v) });
    if (!parsed.success) return { error: Object.values(fieldErrors(parsed.error))[0] ?? "Pick a sequence and at least one lead." };
    const result = await proposeEnrollment(ctx, parsed.data.sequenceId, parsed.data.leadIds);
    if (!result.approvalId) throw new UserError("Every one of these leads already waits for (or got) this sequence. Check Approvals.");
    for (const id of parsed.data.leadIds.slice(0, 50)) await addEvent(ctx.db, id, "sequence", `${ctx.viewer.name} asked to send a sequence; it waits in Approvals.`, ctx.viewer).catch(() => {});
    approvalId = result.approvalId;
  } catch (error) {
    unstable_rethrow(error);
    return { error: messageFor(error) };
  }
  redirect(`/approvals/${approvalId}`);
}

// ── Import ──────────────────────────────────────────────────────────────────

export const importLeadsAction = formAction(importForm, async ({ csv }, formData) => {
  const ctx = await requireModule(MODULE_ID, P.import);
  let text = csv;
  const file = formData.get("file");
  if (file instanceof File && file.size > 0) {
    if (file.size > 2_000_000) throw new UserError("The file is larger than 2 MB. Split it into smaller files.");
    text = await file.text();
  }
  if (!text.trim()) throw new UserError("Choose a CSV file or paste the CSV text.");
  const plan = await planLeadImport(ctx.db, text);
  if (plan.rows === 0) throw new UserError("The CSV has no rows under its header. The first row must name the columns (for example name, email, phone).");
  if (plan.rows > MAX_IMPORT_ROWS) throw new UserError(`One import can hold at most ${MAX_IMPORT_ROWS} rows; this file has ${plan.rows}. Split it and import each part.`);
  if (!plan.items.length) {
    throw new UserError(plan.invalid.length ? `No row could be used. First problem: row ${plan.invalid[0].row}: ${plan.invalid[0].error}` : "Every row matches a lead already here (same email or phone), so there is nothing to import.");
  }
  const result = await propose({
    action: `${MODULE_ID}.import_lead`,
    source: "import",
    requestedBy: ctx.viewer,
    title: `Import ${plan.items.length} lead${plan.items.length === 1 ? "" : "s"}`,
    note: describeLeadImport(plan, ctx.viewer.name),
    items: plan.items,
  });
  if (!result.approvalId) throw new UserError("Every row of this file already waits in an earlier import, so there is nothing new to approve. Check Approvals.");
  redirect(`/approvals/${result.approvalId}`);
});
