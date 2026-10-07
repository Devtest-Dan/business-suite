import "server-only";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { audit, SYSTEM_ACTOR, userActor } from "@/lib/audit";
import { db, type Db, type DbTx } from "@/lib/db/client";
import { UserError } from "@/lib/errors";
import type { ModuleContext, SearchHit } from "@/lib/modules/contract";
import { redactCardNumbers, redactForMemory } from "@/lib/redact";
import { scanSecrets } from "@/lib/secret-scan";
import { BrainReplaceRefused, brain, type BrainFact } from "./brain";
import { MODULE_ID } from "./ids";
import { assistantFacts, assistantFactVersions, assistantSettings } from "./schema";
import type { FactKind } from "./schemas";

/**
 * What the assistant knows. The suite's database holds every fact (text,
 * source, history, status); when the brain is on, each fact is also written
 * to GBrain, which the assistant and coding agents recall from.
 */

export type Fact = Omit<typeof assistantFacts.$inferSelect, "search">;
export type FactSource = Fact["source"];
export type FactStatus = Fact["status"];

const factColumns = {
  id: assistantFacts.id,
  text: assistantFacts.text,
  kind: assistantFacts.kind,
  source: assistantFacts.source,
  sourceDetail: assistantFacts.sourceDetail,
  sourceUrl: assistantFacts.sourceUrl,
  status: assistantFacts.status,
  gbrainId: assistantFacts.gbrainId,
  agentClientId: assistantFacts.agentClientId,
  createdBy: assistantFacts.createdBy,
  createdByName: assistantFacts.createdByName,
  createdAt: assistantFacts.createdAt,
  updatedAt: assistantFacts.updatedAt,
  withdrawnReason: assistantFacts.withdrawnReason,
  brainError: assistantFacts.brainError,
  sourceKey: assistantFacts.sourceKey,
};

export const SOURCE_LABELS: Record<FactSource, string> = {
  person: "Added by a person",
  assistant: "Proposed by the assistant, approved",
  import: "Imported",
  agent: "Added by a coding agent",
  brain: "Found in the brain",
  demo: "Demo (invented)",
};

/** Settings row with defaults (it exists after the seed, but never rely on it). */
export async function assistantSettingsRow(dbOrTx: Db | DbTx = db()) {
  const [row] = await dbOrTx.select().from(assistantSettings).where(eq(assistantSettings.id, 1));
  return row ?? { id: 1, monthlyTokenCap: null, monthlySpendCap: null, pricePerMillionIn: null, pricePerMillionOut: null, currency: "USD", redactFacts: true, notifiedMonth: null, updatedBy: null, updatedAt: new Date(0) };
}

/**
 * What is stored. Secrets (keys, passwords) and card numbers are always
 * removed; names, emails, phones and addresses too unless the owner switched
 * that off. Returns how many things were replaced.
 */
export function cleanFactText(text: string, options: { redactPersonal: boolean; businessName: string }): { text: string; removed: number } {
  if (options.redactPersonal) {
    const r = redactForMemory(text, { protectedNames: [options.businessName] });
    return { text: r.text.trim(), removed: r.total };
  }
  let removed = 0;
  const { redacted } = scanSecrets("fact", text);
  let out = redacted.replace(/\[REDACTED [^\]]+\]/g, () => {
    removed += 1;
    return "[secret]";
  });
  out = redactCardNumbers(out).replace(/\[CARD\]/g, () => {
    removed += 1;
    return "[card number]";
  });
  return { text: out.trim(), removed };
}

function provenanceOf(source: FactSource, detail: string): string {
  return `business-suite ${source}${detail ? `: ${detail.slice(0, 200)}` : ""}`;
}

export interface NewFact {
  text: string;
  kind: FactKind;
  source: FactSource;
  sourceDetail?: string;
  sourceUrl?: string | null;
  sourceKey?: string | null;
}

/**
 * Stores one fact (cleaned first) and returns it with `push`, which sends it
 * to the brain; call `push` after the transaction commits. A failed push is
 * recorded on the fact and retried later ("Send to the brain").
 */
export async function addFact(
  tx: Db | DbTx,
  input: NewFact,
  by: { id: string; name: string } | null,
  business: { name: string },
): Promise<{ fact: Fact; removed: number; push: () => Promise<boolean> }> {
  const settings = await assistantSettingsRow(tx);
  const cleaned = cleanFactText(input.text, { redactPersonal: settings.redactFacts, businessName: business.name });
  if (!cleaned.text) throw new UserError("The fact is empty once secrets and personal details are removed. Write it in plain words.");
  const [fact] = await tx
    .insert(assistantFacts)
    .values({
      text: cleaned.text,
      kind: input.kind,
      source: input.source,
      sourceDetail: input.sourceDetail?.slice(0, 300) ?? "",
      sourceUrl: input.sourceUrl ?? null,
      sourceKey: input.sourceKey ?? null,
      createdBy: by?.id ?? null,
      createdByName: by?.name ?? "",
    })
    .returning(factColumns);
  await audit(
    {
      actor: by ? userActor(by) : SYSTEM_ACTOR,
      action: "assistant.fact_added",
      module: MODULE_ID,
      target: { type: "fact", id: fact.id },
      summary: `${by?.name ?? "The suite"} added a fact to what the assistant knows (${SOURCE_LABELS[input.source].toLowerCase()}).`,
    },
    tx,
  );
  return { fact, removed: cleaned.removed, push: () => pushToBrain(fact.id) };
}

/** Sends one fact to the brain if it is on and the fact is not there yet. Never throws. */
export async function pushToBrain(factId: string): Promise<boolean> {
  const b = brain();
  if (!b) return false;
  const [f] = await db().select(factColumns).from(assistantFacts).where(eq(assistantFacts.id, factId));
  if (!f || f.gbrainId || f.status === "withdrawn") return Boolean(f?.gbrainId);
  try {
    const r = await b.remember({ text: f.text, kind: f.kind, provenance: provenanceOf(f.source, f.sourceDetail) });
    await db().update(assistantFacts).set({ gbrainId: r.gbrainId, brainError: null }).where(and(eq(assistantFacts.id, f.id), isNull(assistantFacts.gbrainId)));
    return true;
  } catch (error) {
    await db()
      .update(assistantFacts)
      .set({ brainError: (error instanceof Error ? error.message : "unknown error").slice(0, 300) })
      .where(eq(assistantFacts.id, f.id));
    return false;
  }
}

/** Facts not yet in the brain (brain on), oldest first. */
export async function pendingForBrain(limit = 50): Promise<string[]> {
  const rows = await db()
    .select({ id: assistantFacts.id })
    .from(assistantFacts)
    .where(and(isNull(assistantFacts.gbrainId), ne(assistantFacts.status, "withdrawn")))
    .orderBy(assistantFacts.createdAt)
    .limit(limit);
  return rows.map((r) => r.id);
}

export async function countPendingForBrain(): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(assistantFacts)
    .where(and(isNull(assistantFacts.gbrainId), ne(assistantFacts.status, "withdrawn")));
  return row?.n ?? 0;
}

/** Sends up to `limit` waiting facts to the brain. Returns how many went. */
export async function syncPending(limit = 50): Promise<{ sent: number; failed: number }> {
  if (!brain()) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  for (const id of await pendingForBrain(limit)) {
    if (await pushToBrain(id)) sent += 1;
    else failed += 1;
  }
  return { sent, failed };
}

/**
 * Adopts facts the brain holds that the suite has no record of (written some
 * other way than the suite or its checked agent address), so the owner sees
 * and can withdraw them. Looks at the newest 100 (GBrain's recall window).
 */
export async function adoptFromBrain(): Promise<number> {
  const b = brain();
  if (!b) return 0;
  const facts = await b.recall({ limit: 100, includeExpired: false });
  if (facts.length === 0) return 0;
  const known = new Set(
    (
      await db()
        .select({ g: assistantFacts.gbrainId })
        .from(assistantFacts)
        .where(inArray(assistantFacts.gbrainId, facts.map((f) => f.gbrainId)))
    ).map((r) => r.g),
  );
  // Earlier wordings of facts we hold are recalled as superseded; skip them too.
  const fresh = facts.filter((f) => !known.has(f.gbrainId) && !f.supersededBy && f.text.trim());
  if (fresh.length === 0) return 0;
  await db()
    .insert(assistantFacts)
    .values(fresh.map((f) => ({ text: f.text, kind: kindOf(f.kind), source: "brain" as const, sourceDetail: f.provenance?.slice(0, 300) ?? "", gbrainId: f.gbrainId, createdAt: safeDate(f.createdAt), updatedAt: safeDate(f.createdAt) })))
    .onConflictDoNothing();
  return fresh.length;
}

function kindOf(kind: string): FactKind {
  return (["fact", "preference", "commitment", "event", "belief"] as const).find((k) => k === kind) ?? "fact";
}

function safeDate(iso: string): Date {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) || d.getTime() === 0 ? new Date() : d;
}

/** Records facts a coding agent wrote through the checked MCP address. */
export async function recordAgentFacts(clientId: string, label: string, all: { gbrainId: string; text: string; kind: string; replaces?: string }[]): Promise<number> {
  if (all.length === 0) return 0;
  // A replacement of the agent's own note (the proxy only lets those through): update that record, keeping its history.
  let updated = 0;
  const facts: typeof all = [];
  for (const f of all) {
    const [own] = f.replaces
      ? await db()
          .select(factColumns)
          .from(assistantFacts)
          .where(and(eq(assistantFacts.gbrainId, f.replaces), eq(assistantFacts.agentClientId, clientId)))
          .limit(1)
      : [];
    if (!own) {
      facts.push(f);
      continue;
    }
    await db().transaction(async (tx) => {
      await tx.insert(assistantFactVersions).values({ factId: own.id, text: own.text, byName: label, writtenAt: own.updatedAt });
      await tx.update(assistantFacts).set({ text: f.text.slice(0, 4000), gbrainId: f.gbrainId, status: "corrected", updatedAt: new Date() }).where(eq(assistantFacts.id, own.id));
    });
    updated += 1;
  }
  if (facts.length === 0) return updated;
  // GBrain answers an exact repeat with the existing fact's id: that fact is
  // not the agent's, so it is not recorded again (and stays unreplaceable).
  const known = new Set(
    (await db().select({ g: assistantFacts.gbrainId }).from(assistantFacts).where(inArray(assistantFacts.gbrainId, facts.map((f) => f.gbrainId)))).map((r) => r.g),
  );
  const fresh = [...new Map(facts.filter((f) => !known.has(f.gbrainId)).map((f) => [f.gbrainId, f])).values()];
  if (fresh.length === 0) return updated;
  const rows = await db()
    .insert(assistantFacts)
    .values(fresh.map((f) => ({ text: f.text.slice(0, 4000), kind: kindOf(f.kind), source: "agent" as const, sourceDetail: label, gbrainId: f.gbrainId, agentClientId: clientId })))
    .returning({ id: assistantFacts.id });
  for (const r of rows) {
    await audit({ actor: { id: null, name: `Coding agent “${label}”`, kind: "ai" }, action: "assistant.fact_added", module: MODULE_ID, target: { type: "fact", id: r.id }, summary: `A coding agent (“${label}”) added a fact to the business brain.` });
  }
  return updated + rows.length;
}

/**
 * True only when every one of these GBrain facts is known here and every
 * record holding it was written by this same agent access (the only facts an
 * agent may replace).
 */
export async function agentOwnsFacts(clientId: string, gbrainIds: string[]): Promise<boolean> {
  if (gbrainIds.length === 0) return true;
  const rows = await db()
    .select({ g: assistantFacts.gbrainId, agent: assistantFacts.agentClientId })
    .from(assistantFacts)
    .where(inArray(assistantFacts.gbrainId, gbrainIds));
  if (rows.some((r) => r.agent !== clientId)) return false;
  return new Set(rows.map((r) => r.g)).size === new Set(gbrainIds).size;
}

/** Whether another current record shares this GBrain fact (then it is not withdrawn or replaced in the brain). */
async function sharedInBrain(dbOrTx: Db, gbrainId: string, exceptId: string): Promise<boolean> {
  const [row] = await dbOrTx
    .select({ id: assistantFacts.id })
    .from(assistantFacts)
    .where(and(eq(assistantFacts.gbrainId, gbrainId), ne(assistantFacts.id, exceptId), ne(assistantFacts.status, "withdrawn")))
    .limit(1);
  return Boolean(row);
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface FactQuery {
  q?: string;
  status?: "current" | "withdrawn" | "all";
  limit?: number;
  offset?: number;
}

export async function listFacts(dbOrCtx: Db, query: FactQuery = {}): Promise<Fact[]> {
  const status = query.status ?? "current";
  const conditions = [];
  if (status === "current") conditions.push(ne(assistantFacts.status, "withdrawn"));
  if (status === "withdrawn") conditions.push(eq(assistantFacts.status, "withdrawn"));
  if (query.q?.trim()) conditions.push(matches(query.q));
  return dbOrCtx
    .select(factColumns)
    .from(assistantFacts)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(assistantFacts.updatedAt))
    .limit(query.limit ?? 50)
    .offset(query.offset ?? 0);
}

/** Full-text match on any of the words (OR), plus a plain substring match for short or odd queries. */
function matches(q: string) {
  const words = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1)
    .slice(0, 8);
  const ts = words.length ? sql`${assistantFacts.search} @@ to_tsquery('simple', ${words.map((w) => `${w}:*`).join(" | ")})` : sql`false`;
  return or(ts, sql`${assistantFacts.text} ilike ${`%${q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`}`)!;
}

export async function countFacts(dbOrCtx: Db): Promise<number> {
  const [row] = await dbOrCtx.select({ n: sql<number>`count(*)::int` }).from(assistantFacts).where(ne(assistantFacts.status, "withdrawn"));
  return row?.n ?? 0;
}

export async function getFact(dbOrCtx: Db, id: string): Promise<{ fact: Fact; versions: (typeof assistantFactVersions.$inferSelect)[] } | null> {
  const [fact] = await dbOrCtx.select(factColumns).from(assistantFacts).where(eq(assistantFacts.id, id));
  if (!fact) return null;
  const versions = await dbOrCtx.select().from(assistantFactVersions).where(eq(assistantFactVersions.factId, id)).orderBy(desc(assistantFactVersions.replacedAt));
  return { fact, versions };
}

export interface RecalledFact {
  id: string;
  text: string;
  kind: string;
  source: string;
  updatedAt: string;
}

/**
 * What the assistant's recall tool returns: the brain's keyword matches
 * (when it is on) merged with the suite's own full-text matches, current
 * facts only, newest first.
 */
export async function recallFacts(dbOrCtx: Db, query: string, limit = 10): Promise<{ facts: RecalledFact[]; brain: "on" | "off" | "unavailable" }> {
  const local = await listFacts(dbOrCtx, { q: query, status: "current", limit });
  const b = brain();
  let brainState: "on" | "off" | "unavailable" = b ? "on" : "off";
  let fromBrain: BrainFact[] = [];
  if (b) {
    try {
      fromBrain = (await b.recall({ grep: query.trim().slice(0, 200), limit, includeExpired: false })).filter((f) => !f.expired);
    } catch {
      brainState = "unavailable";
    }
  }
  const byGbrain = new Map(local.filter((f) => f.gbrainId).map((f) => [f.gbrainId as string, f]));
  const out = new Map<string, RecalledFact>();
  for (const f of local) out.set(f.id, view(f));
  const unknown = fromBrain.filter((g) => !byGbrain.has(g.gbrainId));
  if (unknown.length) {
    const rows = await dbOrCtx
      .select(factColumns)
      .from(assistantFacts)
      .where(and(inArray(assistantFacts.gbrainId, unknown.map((g) => g.gbrainId)), ne(assistantFacts.status, "withdrawn")));
    for (const f of rows) out.set(f.id, view(f));
    const seen = new Set(rows.map((r) => r.gbrainId));
    for (const g of unknown) {
      if (!seen.has(g.gbrainId)) out.set(`g:${g.gbrainId}`, { id: `brain:${g.gbrainId}`, text: g.text, kind: g.kind, source: "Found in the brain", updatedAt: g.createdAt });
    }
  }
  return {
    facts: [...out.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, limit),
    brain: brainState,
  };
}

function view(f: Fact): RecalledFact {
  return { id: f.id, text: f.text, kind: f.kind, source: SOURCE_LABELS[f.source], updatedAt: f.updatedAt.toISOString() };
}

export async function searchFacts(ctx: ModuleContext, query: string, limit: number): Promise<SearchHit[]> {
  const q = sql`websearch_to_tsquery('simple', ${query})`;
  const rows = await ctx.db
    .select({
      id: assistantFacts.id,
      text: assistantFacts.text,
      updatedAt: assistantFacts.updatedAt,
      rank: sql<number>`ts_rank(${assistantFacts.search}, ${q})`,
    })
    .from(assistantFacts)
    .where(and(sql`${assistantFacts.search} @@ ${q}`, ne(assistantFacts.status, "withdrawn")))
    .orderBy(sql`4 desc`)
    .limit(limit);
  return rows.map((r) => ({
    title: r.text.length > 80 ? `${r.text.slice(0, 77)}…` : r.text,
    snippet: r.text,
    url: `/m/${MODULE_ID}/facts/${r.id}`,
    rank: Number(r.rank),
    at: r.updatedAt,
  }));
}

// ── Changing ─────────────────────────────────────────────────────────────────

/**
 * Replaces a fact's wording. The old wording is kept in its history (here and
 * in the brain, where GBrain supersedes it). If the brain is on and does not
 * answer, nothing changes.
 */
export async function correctFact(ctx: ModuleContext, id: string, newText: string): Promise<{ removed: number }> {
  const found = await getFact(ctx.db, id);
  if (!found) throw new UserError("That fact is gone. Reload the page.");
  const { fact } = found;
  if (fact.status === "withdrawn") throw new UserError("This fact was withdrawn, so it cannot be corrected. Add it again as a new fact instead.");
  const settings = await assistantSettingsRow(ctx.db);
  const cleaned = cleanFactText(newText, { redactPersonal: settings.redactFacts, businessName: ctx.business.name });
  if (!cleaned.text) throw new UserError("The correction is empty once secrets and personal details are removed. Write it in plain words.");
  if (cleaned.text === fact.text) throw new UserError("That is the same wording as now. Change the text, or cancel.");

  let gbrainId = fact.gbrainId;
  const b = brain();
  if (b && fact.gbrainId && (await sharedInBrain(ctx.db, fact.gbrainId, fact.id))) {
    // Another record holds the same brain fact: leave it alone and write the new wording beside it.
    const provenance = `${provenanceOf(fact.source, fact.sourceDetail)}; corrected by ${ctx.viewer.name}`;
    gbrainId = (await b.remember({ text: cleaned.text, kind: fact.kind, provenance })).gbrainId;
  } else if (b && fact.gbrainId) {
    const provenance = `${provenanceOf(fact.source, fact.sourceDetail)}; corrected by ${ctx.viewer.name}`;
    try {
      gbrainId = (await b.remember({ text: cleaned.text, kind: fact.kind, provenance, replaces: fact.gbrainId })).gbrainId;
    } catch (error) {
      if (!(error instanceof BrainReplaceRefused)) throw error;
      // GBrain refuses some replacements: withdraw the old wording, then write the new one.
      await b.forget(fact.gbrainId, "replaced by a newer wording");
      gbrainId = (await b.remember({ text: cleaned.text, kind: fact.kind, provenance })).gbrainId;
    }
  }
  await ctx.db.transaction(async (tx) => {
    await tx.insert(assistantFactVersions).values({ factId: fact.id, text: fact.text, byName: fact.createdByName || SOURCE_LABELS[fact.source], writtenAt: fact.updatedAt });
    await tx
      .update(assistantFacts)
      .set({ text: cleaned.text, status: "corrected", gbrainId, updatedAt: new Date(), createdByName: ctx.viewer.name, brainError: null })
      .where(eq(assistantFacts.id, fact.id));
    await audit(
      { actor: userActor(ctx.viewer), action: "assistant.fact_corrected", module: MODULE_ID, target: { type: "fact", id: fact.id }, summary: `${ctx.viewer.name} corrected a fact the assistant knows.` },
      tx,
    );
  });
  if (b && !gbrainId) await pushToBrain(fact.id);
  return { removed: cleaned.removed };
}

/** Withdraws a fact: no longer recalled by the assistant or agents. Its record stays. */
export async function withdrawFact(ctx: ModuleContext, id: string, reason: string): Promise<void> {
  const found = await getFact(ctx.db, id);
  if (!found) throw new UserError("That fact is gone. Reload the page.");
  const { fact } = found;
  if (fact.status === "withdrawn") return;
  const b = brain();
  if (b && fact.gbrainId && !(await sharedInBrain(ctx.db, fact.gbrainId, fact.id))) await b.forget(fact.gbrainId, `${reason || "withdrawn"} (by ${ctx.viewer.name})`);
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(assistantFacts)
      .set({ status: "withdrawn", withdrawnReason: reason || null, updatedAt: new Date() })
      .where(eq(assistantFacts.id, fact.id));
    await audit(
      { actor: userActor(ctx.viewer), action: "assistant.fact_withdrawn", module: MODULE_ID, target: { type: "fact", id: fact.id }, summary: `${ctx.viewer.name} withdrew a fact the assistant knew${reason ? ` (${reason.slice(0, 120)})` : ""}.` },
      tx,
    );
  });
}
