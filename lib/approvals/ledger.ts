import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { audit, userActor } from "@/lib/audit";
import { sha256 } from "@/lib/crypto";
import { UserError } from "@/lib/errors";
import { db } from "@/lib/db/client";
import { approvalItems, approvals, users, type ApprovalSource, type ApprovalStatus } from "@/lib/db/schema";
import type { ModuleManifest, Viewer, WriteAction } from "@/lib/modules/contract";
import { findModule } from "@/lib/modules/registry-access";
import { permissionsFor } from "@/lib/permissions";
import { businessProfile } from "@/lib/settings";

/**
 * The shared approvals ledger (the Otto pattern). A batch of N records is ONE
 * approval with N ledger rows. Each row has a dedupe key that is unique per
 * action across every batch. Before a record is written its row is claimed
 * with one conditional UPDATE, and the write plus the "applied" mark commit in
 * one transaction, so approving twice, retrying or two people pressing
 * Approve at once never writes a record twice. Failures are kept per record.
 */

/** A claim older than this is considered abandoned (the server stopped mid-write). */
export const STALE_CLAIM_MINUTES = 5;
/** The most records one approval may hold. */
export const MAX_BATCH = 1000;

export class ApprovalError extends UserError {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

/** JSON with sorted keys, so the same record always gives the same key. */
class NothingNew extends Error {}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function defaultDedupeKey(input: unknown): string {
  return sha256(stableJson(input));
}

export function findAction(fullName: string): { module: ModuleManifest; action: WriteAction<unknown> } {
  const dot = fullName.indexOf(".");
  const mod = dot > 0 ? findModule(fullName.slice(0, dot)) : undefined;
  const action = mod?.actions?.find((a) => a.name === fullName.slice(dot + 1)) as WriteAction<unknown> | undefined;
  if (!mod || !action) throw new ApprovalError(`No app offers the write "${fullName}". It may have been removed from this suite.`);
  return { module: mod, action };
}

export interface ProposeInput {
  /** Full action name, e.g. "announcements.post". */
  action: string;
  items: unknown[];
  source: ApprovalSource;
  requestedBy: Viewer | null;
  /** Shown as the approval's heading; defaults to the action's label. */
  title?: string;
  /** Free text from the AI or the importer, shown under the heading. */
  note?: string;
  /** Explicit dedupe keys, one per item (e.g. AI tool-call ids or an import's key column). */
  keys?: (string | null | undefined)[];
}

export interface ProposeResult {
  approvalId: string | null;
  accepted: number;
  /** Records left out because the ledger already holds their key. */
  duplicates: number;
  invalid: { index: number; error: string }[];
}

export async function propose(input: ProposeInput): Promise<ProposeResult> {
  const { module, action } = findAction(input.action);
  if (input.items.length === 0) throw new ApprovalError("There is nothing to approve: the batch has no records.");
  if (input.items.length > MAX_BATCH) {
    throw new ApprovalError(`A batch can hold at most ${MAX_BATCH} records; this one has ${input.items.length}. Split it and try again.`);
  }

  const invalid: ProposeResult["invalid"] = [];
  const rows: { position: number; dedupeKey: string; payload: unknown; preview: string }[] = [];
  input.items.forEach((raw, index) => {
    const parsed = action.input.safeParse(raw);
    if (!parsed.success) {
      invalid.push({ index, error: parsed.error.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`).join("; ") });
      return;
    }
    const explicit = input.keys?.[index]?.trim();
    rows.push({
      position: index,
      dedupeKey: explicit || (action.dedupeKey ? action.dedupeKey(parsed.data) : defaultDedupeKey(parsed.data)),
      payload: parsed.data,
      preview: action.preview(parsed.data).slice(0, 500),
    });
  });
  if (rows.length === 0) return { approvalId: null, accepted: 0, duplicates: 0, invalid };

  const fullName = `${module.id}.${action.name}`;
  const result = await db().transaction(async (tx) => {
    const [approval] = await tx
      .insert(approvals)
      .values({
        module: module.id,
        action: fullName,
        title: input.title?.slice(0, 200) || action.label,
        summary: [
          input.note?.slice(0, 1500) ?? "",
          invalid.length
            ? `${invalid.length} record(s) were left out because they were not valid (first: record ${invalid[0].index + 1}: ${invalid[0].error.slice(0, 200)}).`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
        source: input.source,
        requestedBy: input.requestedBy?.id ?? null,
        total: 0,
      })
      .returning({ id: approvals.id });
    const inserted = await tx
      .insert(approvalItems)
      .values(rows.map((r) => ({ ...r, approvalId: approval.id, action: fullName, payload: r.payload as object })))
      .onConflictDoNothing({ target: [approvalItems.action, approvalItems.dedupeKey] })
      .returning({ id: approvalItems.id });
    const duplicates = rows.length - inserted.length;
    // Every record is already in the ledger: undo the empty approval.
    if (inserted.length === 0) throw new NothingNew();
    await tx.update(approvals).set({ total: inserted.length, duplicateCount: duplicates }).where(eq(approvals.id, approval.id));
    return { approvalId: approval.id as string | null, accepted: inserted.length, duplicates };
  }).catch((error: unknown) => {
    if (error instanceof NothingNew) return { approvalId: null, accepted: 0, duplicates: rows.length };
    throw error;
  });

  if (result.approvalId) {
    const actor = input.requestedBy ? { ...userActor(input.requestedBy), kind: input.source === "ai" ? ("ai" as const) : ("user" as const) } : { id: null, name: "System", kind: "system" as const };
    await audit({
      actor,
      action: "approvals.proposed",
      module: module.id,
      target: { type: "approval", id: result.approvalId },
      summary: `${input.source === "ai" ? "The assistant" : input.requestedBy?.name ?? "An import"} proposed ${result.accepted} × ${action.label}${result.duplicates ? ` (${result.duplicates} already in the ledger, left out)` : ""}.`,
      data: { action: fullName, accepted: result.accepted, duplicates: result.duplicates, invalid: invalid.length },
    });
    const { notifyApprovers } = await import("@/lib/notifications");
    await notifyApprovers(result.approvalId, action.permission, input.requestedBy, action.label, result.accepted);
  }
  return { ...result, invalid };
}

/** Holders of "approvals.decide", or the person who asked if they hold the action's own permission. */
export async function canDecide(viewer: Viewer, approval: { action: string; requestedBy: string | null }): Promise<boolean> {
  const held = await permissionsFor(viewer.role);
  if (held.has("approvals.decide")) return true;
  try {
    const { action } = findAction(approval.action);
    return approval.requestedBy === viewer.id && held.has(action.permission);
  } catch {
    return false;
  }
}

export interface RunReport {
  approvalId: string;
  status: ApprovalStatus;
  /** Records this call wrote. */
  appliedNow: number;
  /** Records this call tried and failed. */
  failedNow: number;
  /** Records another call had already claimed or written. */
  alreadyHandled: number;
  /** False when someone had already approved before this call. */
  firstDecision: boolean;
  totals: { applied: number; failed: number; skipped: number; pending: number; claimed: number };
  failures: { position: number; preview: string; error: string }[];
}

async function loadViewer(id: string | null): Promise<Viewer | null> {
  if (!id) return null;
  const [u] = await db().select({ id: users.id, name: users.name, email: users.email, role: users.role }).from(users).where(eq(users.id, id));
  return u ?? null;
}

/**
 * Approves (all records, or only `selectedItemIds`) and writes. Safe to call
 * again: records already written are never written twice, and a second call
 * picks up anything the first left unfinished.
 */
export async function approve(approvalId: string, approver: Viewer, options: { selectedItemIds?: string[]; retryFailed?: boolean } = {}): Promise<RunReport> {
  const [approval] = await db().select().from(approvals).where(eq(approvals.id, approvalId));
  if (!approval) throw new ApprovalError("This approval does not exist. It may have been removed.");
  if (!(await canDecide(approver, approval))) {
    throw new ApprovalError("You cannot decide this approval. Ask someone who holds the matching permission.");
  }
  if (approval.status === "declined") throw new ApprovalError("This approval was declined, so nothing can be written from it.");
  const { module, action } = findAction(approval.action);

  // First decision: record who approved, and leave unselected records out.
  const [first] = await db()
    .update(approvals)
    .set({ status: "running", decidedBy: approver.id, decidedAt: new Date() })
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
    .returning({ id: approvals.id });
  if (first && options.selectedItemIds) {
    await db()
      .update(approvalItems)
      .set({ status: "skipped" })
      .where(
        and(
          eq(approvalItems.approvalId, approvalId),
          eq(approvalItems.status, "pending"),
          options.selectedItemIds.length ? notInArray(approvalItems.id, options.selectedItemIds) : sql`true`,
        ),
      );
  }
  if (first) {
    await audit({
      actor: userActor(approver),
      action: "approvals.approved",
      module: module.id,
      target: { type: "approval", id: approvalId },
      summary: `${approver.name} approved "${approval.title}"${options.selectedItemIds ? ` (${options.selectedItemIds.length} of ${approval.total} records)` : ""}.`,
    });
  }

  const requestedBy = await loadViewer(approval.requestedBy);
  const business = await businessProfile();
  const candidates = await db()
    .select({ id: approvalItems.id })
    .from(approvalItems)
    .where(and(eq(approvalItems.approvalId, approvalId), inArray(approvalItems.status, ["pending", "failed", "claimed"])))
    .orderBy(asc(approvalItems.position));

  let appliedNow = 0;
  let failedNow = 0;
  let alreadyHandled = 0;
  for (const { id } of candidates) {
    const outcome = await runItem(id, action, {
      approvalId,
      source: approval.source,
      moduleId: module.id,
      approver,
      requestedBy,
      business: { name: business.name, timezone: business.timezone },
      retryFailed: options.retryFailed ?? false,
    });
    if (outcome === "applied") appliedNow += 1;
    else if (outcome === "failed") failedNow += 1;
    else alreadyHandled += 1;
  }

  const report = await finish(approvalId);
  if (appliedNow || failedNow) {
    await audit({
      actor: userActor(approver),
      action: "approvals.applied",
      module: module.id,
      target: { type: "approval", id: approvalId },
      summary: `"${approval.title}": ${appliedNow} written${failedNow ? `, ${failedNow} failed` : ""}.`,
      data: { appliedNow, failedNow, alreadyHandled },
    });
  }
  if (first) {
    const { approvalDecided } = await import("@/lib/notifications");
    await approvalDecided(approvalId, approver, approval.requestedBy, approval.title, report.failures.length ? "approved (some records failed)" : "approved");
  }
  return { ...report, appliedNow, failedNow, alreadyHandled, firstDecision: Boolean(first) };
}

type ItemOutcome = "applied" | "failed" | "not-claimed";

async function runItem(
  itemId: string,
  action: WriteAction<unknown>,
  ctx: { approvalId: string; source: ApprovalSource; moduleId: string; approver: Viewer; requestedBy: Viewer | null; business: { name: string; timezone: string }; retryFailed: boolean },
): Promise<ItemOutcome> {
  const token = randomUUID();
  const staleOk = action.sideEffects === "database";
  // The claim: one conditional UPDATE. Only one caller can move a row to "claimed".
  const [claimed] = await db()
    .update(approvalItems)
    .set({ status: "claimed", claimToken: token, claimedAt: new Date(), attempts: sql`${approvalItems.attempts} + 1` })
    .where(
      and(
        eq(approvalItems.id, itemId),
        sql`(${approvalItems.status} = 'pending'
          or (${approvalItems.status} = 'failed' and ${ctx.retryFailed})
          or (${approvalItems.status} = 'claimed' and ${staleOk} and ${approvalItems.claimedAt} < now() - make_interval(mins => ${STALE_CLAIM_MINUTES})))`,
      ),
    )
    .returning();
  if (!claimed) return "not-claimed";

  let after: (() => Promise<void>) | undefined;
  try {
    await db().transaction(async (tx) => {
      const input = action.input.parse(claimed.payload);
      const result = await action.apply(
        { tx, moduleId: ctx.moduleId, approvalId: ctx.approvalId, source: ctx.source, dedupeKey: claimed.dedupeKey, approver: ctx.approver, requestedBy: ctx.requestedBy, business: ctx.business },
        input,
      );
      after = result.after;
      const marked = await tx
        .update(approvalItems)
        .set({ status: "applied", appliedAt: new Date(), error: null, result: { targetId: result.targetId ?? null, summary: result.summary ?? null } })
        .where(and(eq(approvalItems.id, itemId), eq(approvalItems.claimToken, token)))
        .returning({ id: approvalItems.id });
      // Someone took the claim over (it went stale): undo this write.
      if (marked.length === 0) throw new ApprovalError("The claim on this record was lost; nothing was written.");
    });
  } catch (error) {
    const message = describeFailure(error);
    await db()
      .update(approvalItems)
      .set({ status: "failed", error: message.slice(0, 1000) })
      .where(and(eq(approvalItems.id, itemId), eq(approvalItems.claimToken, token)));
    return "failed";
  }
  if (after) await after().catch(() => {});
  return "applied";
}

/** A record's failure as the approver reads it: the database's own reason, not the query. */
export function describeFailure(error: unknown): string {
  if (error instanceof UserError) return error.message;
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? error.cause.message : null;
    if (error.name === "ZodError") return "The record no longer matches what the app expects; it cannot be written.";
    return cause ?? error.message.split("\n")[0];
  }
  return String(error);
}

async function finish(approvalId: string): Promise<Omit<RunReport, "appliedNow" | "failedNow" | "alreadyHandled" | "firstDecision">> {
  const counts = await db()
    .select({ status: approvalItems.status, n: sql<number>`count(*)::int` })
    .from(approvalItems)
    .where(eq(approvalItems.approvalId, approvalId))
    .groupBy(approvalItems.status);
  const totals = { applied: 0, failed: 0, skipped: 0, pending: 0, claimed: 0 };
  for (const c of counts) totals[c.status] = c.n;
  const status: ApprovalStatus =
    totals.pending + totals.claimed > 0
      ? "running"
      : totals.failed === 0
        ? "applied"
        : totals.applied > 0
          ? "partially_applied"
          : "failed";
  await db()
    .update(approvals)
    .set({
      status,
      appliedCount: totals.applied,
      failedCount: totals.failed,
      skippedCount: totals.skipped,
      completedAt: status === "running" ? null : new Date(),
    })
    .where(and(eq(approvals.id, approvalId), sql`${approvals.status} <> 'declined'`));
  const failures = await db()
    .select({ position: approvalItems.position, preview: approvalItems.preview, error: approvalItems.error })
    .from(approvalItems)
    .where(and(eq(approvalItems.approvalId, approvalId), eq(approvalItems.status, "failed")))
    .orderBy(asc(approvalItems.position));
  return { approvalId, status, totals, failures: failures.map((f) => ({ ...f, error: f.error ?? "" })) };
}

export async function decline(approvalId: string, approver: Viewer, reason: string): Promise<void> {
  const [approval] = await db().select().from(approvals).where(eq(approvals.id, approvalId));
  if (!approval) throw new ApprovalError("This approval does not exist. It may have been removed.");
  if (!(await canDecide(approver, approval))) throw new ApprovalError("You cannot decide this approval. Ask someone who holds the matching permission.");
  const [done] = await db()
    .update(approvals)
    .set({ status: "declined", decidedBy: approver.id, decidedAt: new Date(), completedAt: new Date() })
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
    .returning({ id: approvals.id });
  if (!done) throw new ApprovalError("This approval was already decided, so it cannot be declined now.");
  await db().update(approvalItems).set({ status: "skipped" }).where(and(eq(approvalItems.approvalId, approvalId), eq(approvalItems.status, "pending")));
  await audit({
    actor: userActor(approver),
    action: "approvals.declined",
    module: approval.module,
    target: { type: "approval", id: approvalId },
    summary: `${approver.name} declined "${approval.title}"${reason ? `: ${reason.slice(0, 200)}` : "."}`,
  });
  const { approvalDecided } = await import("@/lib/notifications");
  await approvalDecided(approvalId, approver, approval.requestedBy, approval.title, "declined");
}
