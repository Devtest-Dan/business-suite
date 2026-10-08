import "server-only";
import { and, eq } from "drizzle-orm";
import { approve, canDecide, describeFailure, propose } from "@/lib/approvals/ledger";
import { db } from "@/lib/db/client";
import { approvalItems } from "@/lib/db/schema";
import type { ApplyContext, ApplyResult, ModuleContext, Viewer } from "@/lib/modules/contract";
import { permissionsFor } from "@/lib/permissions";
import { assertSubjectExists, followUpSubjectUrl, insertFollowUp, MODULE_ID, userIdByEmail } from "./data";
import { customerFollowUps } from "./schema";
import type { FollowUpInput } from "./schemas";
import { taskInputFor, tasksLink, type TaskDraft } from "./tasks-link";

/**
 * Follow-ups. When the Tasks app is on, a follow-up becomes a task there
 * (through its registered write action) and this app keeps a link to it;
 * otherwise it is a reminder here, shown in "what needs me" and notified
 * when due.
 */

export interface FollowUpFields {
  title: string;
  notes: string;
  dueOn: string;
  contactId: string | null;
  companyId: string | null;
  dealId: string | null;
  assigneeId: string | null;
}

export interface FollowUpOutcome {
  followUpId: string;
  via: "here" | "tasks";
  /** Set when the task waits in the approvals inbox. */
  waitingApprovalId?: string;
  message: string;
}

function draftFor(f: FollowUpFields, about: string, assigneeEmail: string): TaskDraft {
  return { title: f.title, notes: f.notes, dueOn: f.dueOn, assigneeId: f.assigneeId, assigneeEmail, about, url: followUpSubjectUrl(f) };
}

/** A person adds a follow-up from a page. */
export async function createFollowUpFromPage(ctx: ModuleContext, f: FollowUpFields, assigneeEmail: string): Promise<FollowUpOutcome> {
  const about = await assertSubjectExists(ctx.db, f);
  const link = await tasksLink();
  const shape = link ? taskInputFor(link, draftFor(f, about, assigneeEmail)) : null;
  if (!link || !shape) {
    const row = await insertFollowUp(ctx.db, f, ctx.viewer);
    return { followUpId: row.id, via: "here", message: `Follow-up set for ${row.dueOn}.` };
  }

  // Through the Tasks app's own write action: proposed by this person, approved at once when they may.
  const row = await insertFollowUp(ctx.db, f, ctx.viewer, { via: "tasks" });
  const result = await propose({
    action: link.fullName,
    items: [shape],
    source: "user",
    requestedBy: ctx.viewer,
    title: `Task from Customers: ${f.title}`,
    note: `${ctx.viewer.name} set a follow-up for ${about} in Customers.`,
    keys: [`customers:follow-up:${row.id}`],
  });
  if (!result.approvalId) {
    await ctx.db.update(customerFollowUps).set({ via: "here" }).where(eq(customerFollowUps.id, row.id));
    return { followUpId: row.id, via: "here", message: `The Tasks app did not accept it, so the follow-up is a reminder here, due ${row.dueOn}.` };
  }
  await ctx.db.update(customerFollowUps).set({ taskApprovalId: result.approvalId }).where(eq(customerFollowUps.id, row.id));
  if (!(await canDecide(ctx.viewer, { action: link.fullName, requestedBy: ctx.viewer.id }))) {
    return { followUpId: row.id, via: "tasks", waitingApprovalId: result.approvalId, message: "The task waits in Approvals: your role cannot add tasks directly. It appears in Tasks once someone approves it." };
  }
  const report = await approve(result.approvalId, ctx.viewer);
  if (report.status !== "applied") {
    await ctx.db.update(customerFollowUps).set({ via: "here" }).where(eq(customerFollowUps.id, row.id));
    const why = report.failures[0]?.error ?? "it could not be written";
    return { followUpId: row.id, via: "here", message: `The task could not be added in Tasks (${why}), so the follow-up is a reminder here, due ${row.dueOn}.` };
  }
  const [item] = await db()
    .select({ result: approvalItems.result })
    .from(approvalItems)
    .where(and(eq(approvalItems.approvalId, result.approvalId), eq(approvalItems.status, "applied")));
  const taskId = (item?.result as { targetId?: string | null } | null)?.targetId ?? null;
  await ctx.db.update(customerFollowUps).set({ taskId }).where(eq(customerFollowUps.id, row.id));
  return { followUpId: row.id, via: "tasks", message: `Added as a task in Tasks, due ${row.dueOn}.` };
}

/** The approved "create a follow-up" (from the assistant): a task in Tasks when it is on, else a reminder here. */
export async function applyFollowUp(ctx: ApplyContext, input: FollowUpInput): Promise<ApplyResult> {
  const by = ctx.requestedBy ?? ctx.approver;
  const assigneeId = (await userIdByEmail(ctx.tx, input.assigneeEmail)) ?? by.id;
  const fields: FollowUpFields = { title: input.title, notes: input.notes, dueOn: input.dueOn, contactId: input.contactId, companyId: input.companyId, dealId: input.dealId, assigneeId };
  const about = await assertSubjectExists(ctx.tx, fields);
  const sourceKey = `${ctx.approvalId}:${ctx.dedupeKey}`;

  const link = await tasksLink();
  const shape = link ? taskInputFor(link, draftFor(fields, about, input.assigneeEmail)) : null;
  const approverHolds = link ? await mayUse(ctx.approver, link.action.permission) : false;
  if (link && shape && approverHolds) {
    try {
      // A savepoint: if Tasks fails, only its part is rolled back and the reminder below still works.
      const task = await ctx.tx.transaction((sp) => link.action.apply({ ...ctx, tx: sp, moduleId: "tasks", calledBy: MODULE_ID, dedupeKey: `customers:${ctx.dedupeKey}` }, link.action.input.parse(shape)));
      const row = await insertFollowUp(ctx.tx, fields, by, { via: "tasks", taskApprovalId: ctx.approvalId, taskId: task.targetId ?? null, sourceKey });
      return { targetId: row.id, summary: `Added the task “${row.title}” in Tasks for ${about}, due ${row.dueOn}`, after: task.after };
    } catch (error) {
      // The task could not be written: keep the follow-up here instead of losing it.
      const row = await insertFollowUp(ctx.tx, fields, by, { sourceKey });
      return { targetId: row.id, summary: `Set a reminder here for ${about}, due ${row.dueOn} (Tasks refused it: ${describeFailure(error)})` };
    }
  }
  const row = await insertFollowUp(ctx.tx, fields, by, { sourceKey });
  return { targetId: row.id, summary: `Set a follow-up for ${about}: “${row.title}”, due ${row.dueOn}` };
}

async function mayUse(viewer: Viewer, permission: string): Promise<boolean> {
  const held = await permissionsFor(viewer.role);
  return held.has(permission) || held.has("approvals.decide");
}
