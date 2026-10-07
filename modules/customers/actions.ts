"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { audit, userActor } from "@/lib/audit";
import { propose } from "@/lib/approvals/ledger";
import { UserError } from "@/lib/errors";
import { formAction, type FormState } from "@/lib/forms";
import { requireModule } from "@/lib/modules/server";
import { toCsv } from "./csv-out";
import {
  addActivity,
  BASE,
  deleteCompany,
  deleteContact,
  deleteDeal,
  deleteStage,
  formatMoney,
  listCompanies,
  listContacts,
  listDeals,
  listFields,
  listPeople,
  MODULE_ID,
  moveStage,
  P,
  saveCompany,
  saveContact,
  saveDeal,
  saveStage,
  setDealStage,
  setFollowUpStatus,
  todayIn,
} from "./data";
import { createFollowUpFromPage } from "./follow-ups";
import { describePlan, MAX_IMPORT_ROWS, planImport } from "./import";
import { customerFields, customerSavedFilters } from "./schema";
import {
  activityForm,
  checkCustomValues,
  companyForm,
  contactForm,
  dealForm,
  fieldForm,
  fieldKey,
  followUpForm,
  importForm,
  listFilter,
  MAX_FIELDS_PER_ENTITY,
  moveStageForm,
  savedFilterForm,
  stageForm,
} from "./schemas";

const id = z.string().uuid();

/** "custom.<key>" inputs, checked against the owner's field definitions. */
async function customFrom(formData: FormData, entity: "contact" | "company" | "deal", db: Parameters<typeof listFields>[0]) {
  const raw: Record<string, string> = {};
  for (const [k, v] of formData.entries()) if (k.startsWith("custom.") && typeof v === "string") raw[k.slice(7)] = v;
  const checked = checkCustomValues(await listFields(db, entity), raw);
  return checked;
}

function customErrors(errors: Record<string, string>): FormState | null {
  if (!Object.keys(errors).length) return null;
  return { error: "Some fields need attention. Check the messages below and try again.", fieldErrors: errors };
}

// ── Contacts ────────────────────────────────────────────────────────────────

export const saveContactAction = formAction(contactForm, async (input, formData) => {
  const ctx = await requireModule(MODULE_ID, P.edit);
  const custom = await customFrom(formData, "contact", ctx.db);
  const bad = customErrors(custom.errors);
  if (bad) return bad;
  const { id: existing, ...values } = input;
  const row = await saveContact(ctx.db, { ...values, custom: custom.values }, ctx.viewer, existing);
  redirect(`${BASE}/contacts/${row.id}`);
});

export async function deleteContactAction(contactId: string): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.delete);
  await deleteContact(ctx, id.parse(contactId));
  redirect(BASE);
}

// ── Companies ───────────────────────────────────────────────────────────────

export const saveCompanyAction = formAction(companyForm, async (input, formData) => {
  const ctx = await requireModule(MODULE_ID, P.edit);
  const custom = await customFrom(formData, "company", ctx.db);
  const bad = customErrors(custom.errors);
  if (bad) return bad;
  const { id: existing, ...values } = input;
  const row = await saveCompany(ctx.db, { ...values, custom: custom.values }, ctx.viewer, existing);
  redirect(`${BASE}/companies/${row.id}`);
});

export async function deleteCompanyAction(companyId: string): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.delete);
  await deleteCompany(ctx, id.parse(companyId));
  redirect(`${BASE}/companies`);
}

// ── Deals ───────────────────────────────────────────────────────────────────

export const saveDealAction = formAction(dealForm, async (input, formData) => {
  const ctx = await requireModule(MODULE_ID, P.edit);
  const custom = await customFrom(formData, "deal", ctx.db);
  const bad = customErrors(custom.errors);
  if (bad) return bad;
  const { id: existing, value, ...rest } = input;
  const row = await saveDeal(ctx.db, { ...rest, valueCents: value, custom: custom.values }, ctx.viewer, existing);
  redirect(`${BASE}/deals/${row.id}`);
});

export const moveDealAction = formAction(moveStageForm, async ({ dealId, stageId }) => {
  const ctx = await requireModule(MODULE_ID, P.edit);
  const { changed, stage, deal } = await setDealStage(ctx.db, dealId, stageId, ctx.viewer);
  refresh();
  return { ok: changed ? `Moved “${deal.title}” to ${stage.name}.` : `“${deal.title}” is already in ${stage.name}.` };
});

export async function deleteDealAction(dealId: string): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.delete);
  await deleteDeal(ctx, id.parse(dealId));
  redirect(`${BASE}/deals`);
}

// ── Timeline and follow-ups ─────────────────────────────────────────────────

export const addActivityAction = formAction(activityForm, async (input) => {
  const ctx = await requireModule(MODULE_ID, P.edit);
  // Today means now; an earlier day is logged at midday of that day.
  const today = todayIn(ctx.business.timezone);
  if (input.occurredOn > today) throw new UserError("That date is in the future. Log what already happened; use a follow-up for what is coming.");
  const occurredAt = input.occurredOn && input.occurredOn !== today ? new Date(`${input.occurredOn}T12:00:00Z`) : new Date();
  await addActivity(ctx.db, { ...input, occurredAt }, ctx.viewer);
  refresh();
  return { ok: "Added to the timeline." };
});

export const addFollowUpAction = formAction(followUpForm, async (input) => {
  const ctx = await requireModule(MODULE_ID, P.edit);
  const assigneeId = input.assigneeId ?? ctx.viewer.id;
  const people = await listPeople(ctx.db);
  const assignee = people.find((p) => p.id === assigneeId);
  if (!assignee) throw new UserError("That person is not an active member of the team. Pick someone else.");
  const outcome = await createFollowUpFromPage(ctx, { ...input, assigneeId }, assignee.email);
  refresh();
  return { ok: outcome.message };
});

export async function followUpStatusAction(followUpId: string, status: "open" | "done" | "cancelled"): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.edit);
  await setFollowUpStatus(ctx, id.parse(followUpId), z.enum(["open", "done", "cancelled"]).parse(status));
  refresh();
}

// ── Pipeline and custom fields (Settings) ───────────────────────────────────

export const saveStageAction = formAction(stageForm, async (input) => {
  const ctx = await requireModule(MODULE_ID, P.pipeline);
  await saveStage(ctx, input);
  refresh();
  return { ok: input.id ? `Saved “${input.name}”.` : `Added the stage “${input.name}”.` };
});

export async function moveStageAction(stageId: string, direction: "up" | "down"): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.pipeline);
  await moveStage(ctx, id.parse(stageId), z.enum(["up", "down"]).parse(direction));
  refresh();
}

export const deleteStageAction = formAction(z.object({ stageId: id }), async ({ stageId }) => {
  const ctx = await requireModule(MODULE_ID, P.pipeline);
  await deleteStage(ctx, stageId);
  refresh();
  return { ok: "Stage removed." };
});

export const addFieldAction = formAction(fieldForm, async (input) => {
  const ctx = await requireModule(MODULE_ID, P.pipeline);
  const existing = await listFields(ctx.db, input.entity);
  if (existing.length >= MAX_FIELDS_PER_ENTITY) throw new UserError(`Each kind of record can have at most ${MAX_FIELDS_PER_ENTITY} custom fields. Remove one first.`);
  const key = fieldKey(input.label);
  if (existing.some((f) => f.key === key)) throw new UserError(`There is already a field called “${input.label}”. Pick another label.`);
  await ctx.db.insert(customerFields).values({ entity: input.entity, key, label: input.label, type: input.type, options: input.options, position: existing.length });
  await audit({ actor: userActor(ctx.viewer), action: "customers.field_added", module: MODULE_ID, summary: `${ctx.viewer.name} added the custom field “${input.label}” to ${input.entity}s.` });
  refresh();
  return { ok: `Added “${input.label}”.` };
});

export async function deleteFieldAction(fieldId: string): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.pipeline);
  const [row] = await ctx.db.delete(customerFields).where(eq(customerFields.id, id.parse(fieldId))).returning({ label: customerFields.label });
  if (row) await audit({ actor: userActor(ctx.viewer), action: "customers.field_removed", module: MODULE_ID, summary: `${ctx.viewer.name} removed the custom field “${row.label}” (values already saved stay in the records).` });
  refresh();
}

// ── Saved filters ───────────────────────────────────────────────────────────

export const saveFilterAction = formAction(savedFilterForm, async (input) => {
  const ctx = await requireModule(MODULE_ID, P.access);
  const query = listFilter.parse(Object.fromEntries(new URLSearchParams(input.query)));
  const kept = Object.fromEntries(Object.entries(query).filter(([, v]) => v));
  if (!Object.keys(kept).length) throw new UserError("Set a filter first (a search, a tag or an owner), then save it.");
  if (input.shared && !ctx.can(P.edit)) throw new UserError("Your role cannot share filters with the team. Untick “Share with the team”.");
  await ctx.db.insert(customerSavedFilters).values({ entity: input.entity, name: input.name, query: kept, userId: ctx.viewer.id, shared: input.shared });
  refresh();
  return { ok: `Saved “${input.name}”.` };
});

export async function deleteFilterAction(filterId: string): Promise<void> {
  const ctx = await requireModule(MODULE_ID, P.access);
  const where = ctx.can(P.pipeline)
    ? eq(customerSavedFilters.id, id.parse(filterId))
    : and(eq(customerSavedFilters.id, id.parse(filterId)), eq(customerSavedFilters.userId, ctx.viewer.id));
  await ctx.db.delete(customerSavedFilters).where(where);
  refresh();
}

// ── Import and export ───────────────────────────────────────────────────────

/** The whole import is ONE approval: each row a new contact or a merge into an existing one. */
export const importContactsAction = formAction(importForm, async ({ csv }, formData) => {
  const ctx = await requireModule(MODULE_ID, P.import);
  let text = csv;
  const file = formData.get("file");
  if (file instanceof File && file.size > 0) {
    if (file.size > 2_000_000) throw new UserError("The file is larger than 2 MB. Split it into smaller files.");
    text = await file.text();
  }
  if (!text.trim()) throw new UserError("Choose a CSV file or paste the CSV text.");
  const plan = await planImport(ctx.db, text);
  if (plan.rows === 0) throw new UserError("The CSV has no rows under its header. The first row must name the columns (for example name, email, phone, company).");
  if (plan.rows > MAX_IMPORT_ROWS) throw new UserError(`One import can hold at most ${MAX_IMPORT_ROWS} rows; this file has ${plan.rows}. Split it and import each part.`);
  if (plan.items.length === 0) {
    const why = plan.invalid.length
      ? `No row could be used. First problem: row ${plan.invalid[0].row}: ${plan.invalid[0].error}`
      : "Every row matches a contact that already has everything in it, so there is nothing to import.";
    throw new UserError(why);
  }
  const result = await propose({
    action: `${MODULE_ID}.import_contact`,
    source: "import",
    requestedBy: ctx.viewer,
    title: `Import ${plan.items.length} contact${plan.items.length === 1 ? "" : "s"}`,
    note: describePlan(plan, ctx.viewer.name),
    items: plan.items,
  });
  if (!result.approvalId) throw new UserError("Every row of this file is already waiting in an earlier import, so there is nothing new to approve. Check Approvals.");
  redirect(`/approvals/${result.approvalId}`);
});

/** Returns the CSV text; the page turns it into a download. */
export async function exportCsvAction(entity: "contacts" | "companies" | "deals", query: string): Promise<{ filename: string; csv: string }> {
  const ctx = await requireModule(MODULE_ID, P.export);
  const which = z.enum(["contacts", "companies", "deals"]).parse(entity);
  const f = listFilter.parse(Object.fromEntries(new URLSearchParams(z.string().max(2000).parse(query))));
  const date = new Date().toISOString().slice(0, 10);
  let csv: string;
  let count: number;
  if (which === "contacts") {
    const fields = await listFields(ctx.db, "contact");
    const rows = await listContacts(ctx, f, 10_000);
    count = rows.length;
    csv = toCsv(
      ["name", "email", "phone", "company", "job_title", "address", "tags", "owner", "notes", ...fields.map((d) => d.key), "created_at"],
      rows.map((c) => [c.name, c.email, c.phone, c.companyName, c.jobTitle, c.address, c.tags, c.ownerName, c.notes, ...fields.map((d) => c.custom[d.key] ?? ""), c.createdAt.toISOString()]),
    );
  } else if (which === "companies") {
    const fields = await listFields(ctx.db, "company");
    const rows = await listCompanies(ctx, f, 10_000);
    count = rows.length;
    csv = toCsv(
      ["name", "website", "email", "phone", "address", "tags", "owner", "contacts", "notes", ...fields.map((d) => d.key), "created_at"],
      rows.map((c) => [c.name, c.website, c.email, c.phone, c.address, c.tags, c.ownerName, c.contactCount, c.notes, ...fields.map((d) => c.custom[d.key] ?? ""), c.createdAt.toISOString()]),
    );
  } else {
    const fields = await listFields(ctx.db, "deal");
    const rows = await listDeals(ctx, f, 10_000);
    count = rows.length;
    csv = toCsv(
      ["title", "stage", "status", "value", "expected_close", "contact", "company", "owner", "notes", ...fields.map((d) => d.key), "created_at", "closed_at"],
      rows.map((d) => [d.title, d.stageName, d.stageKind, formatMoney(d.valueCents).replace(/,/g, ""), d.expectedClose, d.contactName, d.companyName, d.ownerName, d.notes, ...fields.map((x) => d.custom[x.key] ?? ""), d.createdAt.toISOString(), d.closedAt?.toISOString() ?? ""]),
    );
  }
  await audit({ actor: userActor(ctx.viewer), action: "customers.exported", module: MODULE_ID, summary: `${ctx.viewer.name} exported ${count} ${which} as CSV.` });
  return { filename: `${which}-${date}.csv`, csv };
}

