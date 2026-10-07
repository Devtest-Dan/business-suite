"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { propose } from "@/lib/approvals/ledger";
import { UserError } from "@/lib/errors";
import { formAction, type FormState } from "@/lib/forms";
import { requireModule } from "@/lib/modules/server";
import { createAgentAccess, revokeAgentAccess } from "./agents";
import { brain } from "./brain";
import { assistantTurn } from "./chat";
import { addFact, correctFact, syncPending, adoptFromBrain, withdrawFact } from "./facts";
import { MODULE_ID, P } from "./ids";
import { agentForm, ahlMemoryExport, chatForm, correctForm, importForm, limitsForm, rememberForm, revokeForm, withdrawForm, FACT_KINDS, type ImportFactInput } from "./schemas";
import { saveLimits } from "./usage";

const removedNote = (n: number) => (n ? ` ${n} personal detail${n === 1 ? " was" : "s were"} replaced with placeholders.` : "");

export const sendMessage = formAction(chatForm, async ({ conversationId, message }) => {
  const ctx = await requireModule(MODULE_ID, P.use);
  const id = await assistantTurn(ctx.viewer, conversationId, message);
  redirect(`/m/${MODULE_ID}?c=${id}`);
});

export const rememberFact = formAction(rememberForm, async (input) => {
  const ctx = await requireModule(MODULE_ID, P.remember);
  const { removed, push } = await ctx.db.transaction((tx) =>
    addFact(tx, { text: input.text, kind: input.kind, source: "person", sourceDetail: input.from, sourceUrl: input.url ?? null }, ctx.viewer, ctx.business),
  );
  const inBrain = await push();
  const brainNote = !inBrain && brain() ? " The brain did not take it yet; it is sent again on the next sync." : "";
  refresh();
  return { ok: `Remembered.${removedNote(removed)}${brainNote}` };
});

export const correctFactAction = formAction(correctForm, async ({ factId, text }) => {
  const ctx = await requireModule(MODULE_ID, P.curate);
  const { removed } = await correctFact(ctx, factId, text);
  refresh();
  return { ok: `Corrected. The assistant now recalls your wording.${removedNote(removed)}` };
});

export const withdrawFactAction = formAction(withdrawForm, async ({ factId, reason }) => {
  const ctx = await requireModule(MODULE_ID, P.curate);
  await withdrawFact(ctx, factId, reason);
  refresh();
  return { ok: "Withdrawn. The assistant and coding agents no longer recall it." };
});

export async function syncBrain(): Promise<FormState> {
  await requireModule(MODULE_ID, P.curate);
  try {
    const adopted = await adoptFromBrain();
    const { sent, failed } = await syncPending(200);
    refresh();
    const parts = [`${sent} fact${sent === 1 ? "" : "s"} sent to the brain`, `${adopted} found there that were new here`];
    if (failed) parts.push(`${failed} could not be sent (the reason is shown on each)`);
    return { ok: `${parts.join("; ")}.` };
  } catch (error) {
    if (error instanceof UserError) return { error: error.message };
    throw error;
  }
}

export const saveLimitsAction = formAction(limitsForm, async (input) => {
  const ctx = await requireModule(MODULE_ID, P.limits);
  await saveLimits(ctx.viewer, input);
  refresh();
  return { ok: "Saved. The limits apply from the next message anyone sends." };
});

/** The token is returned once, to the person who created it; only its hash is kept. */
export const createAgentAction = formAction(agentForm, async ({ label, days }) => {
  const ctx = await requireModule(MODULE_ID, P.agents);
  const r = await createAgentAccess(ctx.viewer, { label, days: Number(days) });
  refresh();
  return { ok: "Created. Copy the token now: it is shown once.", data: { token: r.token, url: r.url, expiresAt: r.expiresAt.toISOString() } };
});

export const revokeAgentAction = formAction(revokeForm, async ({ clientId }) => {
  const ctx = await requireModule(MODULE_ID, P.agents);
  await revokeAgentAccess(ctx.viewer, clientId);
  refresh();
  return { ok: "Revoked. That agent can no longer reach the brain." };
});

/**
 * Bring the brain home: an AHL business-memory export (format v1) becomes ONE
 * approval with a record per fact, keyed by the AHL fact id, so importing the
 * same export twice never adds a fact twice. Withdrawn facts are left out.
 */
export const importMemory = formAction(importForm, async ({ json }, formData) => {
  const ctx = await requireModule(MODULE_ID, P.import);
  let text = json;
  const file = formData.get("file");
  if (!text && file instanceof File && file.size > 0) {
    if (file.size > 5_000_000) throw new UserError("That file is larger than 5 MB. Ask for the export in parts.");
    text = await file.text();
  }
  if (!text.trim()) throw new UserError("Choose the export file, or paste its contents.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new UserError("That is not valid JSON. Use the file exactly as the AHL “Export my memory” button saved it.");
  }
  const parsed = ahlMemoryExport.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new UserError(`The export does not match the format this suite reads (${first.path.join(".") || "file"}: ${first.message}).`);
  }
  const current = parsed.data.facts.filter((f) => f.status !== "withdrawn");
  const withdrawn = parsed.data.facts.length - current.length;
  if (current.length === 0) throw new UserError("The export has no current facts to import (only withdrawn ones, or none).");
  const items: ImportFactInput[] = current.map((f) => ({
    externalId: f.id,
    text: f.text,
    kind: (FACT_KINDS as readonly string[]).includes(f.kind) ? (f.kind as ImportFactInput["kind"]) : "fact",
    originalSource: f.source,
    updatedAt: f.updatedAt,
    history: f.history,
  }));
  const from = parsed.data.business?.name ? ` from ${parsed.data.business.name}` : "";
  const result = await propose({
    action: `${MODULE_ID}.import_fact`,
    source: "import",
    requestedBy: ctx.viewer,
    title: `Import ${items.length} fact${items.length === 1 ? "" : "s"} into what the assistant knows`,
    note: `${ctx.viewer.name} imported an AHL business-memory export${from} (exported ${parsed.data.exportedAt.slice(0, 10)}).${withdrawn ? ` ${withdrawn} withdrawn fact${withdrawn === 1 ? " was" : "s were"} left out.` : ""}`,
    items,
    keys: items.map((i) => `ahl:${i.externalId}`),
  });
  if (!result.approvalId) {
    const why = result.invalid.length
      ? `No fact could be used. First problem: fact ${result.invalid[0].index + 1}: ${result.invalid[0].error}`
      : "Every fact in this export was imported (or proposed) before, so there is nothing new to approve.";
    throw new UserError(why);
  }
  redirect(`/approvals/${result.approvalId}`);
});
