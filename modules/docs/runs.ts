import "server-only";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { audit, userActor } from "@/lib/audit";
import type { Db, DbTx } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { UserError } from "@/lib/errors";
import type { ModuleContext } from "@/lib/modules/contract";
import { notify } from "@/lib/notifications";
import { accessFor, canManage, canRead, MODULE_ID, P, type Who } from "./access";
import { getSpace, readableSpaceIds, whoFor, type PageWithSpace } from "./data";
import { docsPages, docsRuns, docsRunSteps, docsSpaceMembers, docsSpaces } from "./schema";
import { dayIn, dueOn } from "./text";

type Conn = Db | DbTx;
export type Run = typeof docsRuns.$inferSelect;
export type RunStep = typeof docsRunSteps.$inferSelect;

/** Starts a checklist run of a procedure: its current steps are copied, so later edits do not change a run in progress. */
export async function startRun(ctx: ModuleContext, page: PageWithSpace, input: { assignedTo?: string; dueOn?: string }): Promise<Run> {
  if (!ctx.can(P.run)) throw new UserError("Your role cannot run procedures. Ask the owner.");
  if (page.kind !== "procedure") throw new UserError("Only a procedure can be run. Change the page's type to Procedure first.");
  if (page.archivedAt) throw new UserError("This procedure is archived. Bring it back before running it.");
  if (page.steps.length === 0) throw new UserError("This procedure has no steps yet. Edit it and add at least one step.");
  const today = dayIn(ctx.business.timezone);
  if (input.assignedTo && input.assignedTo !== ctx.viewer.id) {
    const [person] = await ctx.db.select({ id: users.id, role: users.role, status: users.status }).from(users).where(eq(users.id, input.assignedTo));
    if (!person || person.status !== "active") throw new UserError("That person's account is not active. Pick someone else.");
    const who = await whoFor(person);
    const space = await getSpace(ctx.db, who, page.spaceId);
    if (!space || !who.can(P.run)) throw new UserError("That person cannot open this space or run procedures, so they could not complete it. Pick someone else, or add them to the space.");
  }
  const [run] = await ctx.db
    .insert(docsRuns)
    .values({
      pageId: page.id,
      revision: page.revision,
      title: page.title,
      steps: page.steps,
      dueOn: input.dueOn ?? today,
      assignedTo: input.assignedTo ?? null,
      startedBy: ctx.viewer.id,
      startedByName: ctx.viewer.name,
    })
    .returning();
  await audit({
    actor: userActor(ctx.viewer),
    action: "docs.run_started",
    module: MODULE_ID,
    target: { type: "docs_run", id: run.id },
    summary: `${ctx.viewer.name} started "${page.title}" for ${run.dueOn}.`,
    visibility: page.space.visibility === "team" ? "everyone" : "admins",
  });
  if (run.assignedTo && run.assignedTo !== ctx.viewer.id) {
    await notify([run.assignedTo], {
      kind: "docs.run_assigned",
      title: `${ctx.viewer.name} asked you to complete: ${page.title}`,
      body: `For ${run.dueOn}. ${page.steps.length} step(s).`,
      url: `/m/${MODULE_ID}/runs/${run.id}`,
    });
  }
  return run;
}

export type RunWithAccess = Run & { pageSpaceId: string; access: ReturnType<typeof accessFor>; assigneeName: string | null };

/** A run the person can see (they can read the procedure's space). */
export async function getRun(conn: Conn, who: Who, id: string): Promise<RunWithAccess | null> {
  const [row] = await conn
    .select({ run: docsRuns, spaceId: docsPages.spaceId, assigneeName: users.name })
    .from(docsRuns)
    .innerJoin(docsPages, eq(docsPages.id, docsRuns.pageId))
    .leftJoin(users, eq(users.id, docsRuns.assignedTo))
    .where(eq(docsRuns.id, id));
  if (!row) return null;
  const space = await getSpace(conn, who, row.spaceId);
  if (!space) return null;
  return { ...row.run, pageSpaceId: row.spaceId, access: space.access, assigneeName: row.assigneeName };
}

export async function runSteps(conn: Conn, runId: string): Promise<RunStep[]> {
  return conn.select().from(docsRunSteps).where(eq(docsRunSteps.runId, runId)).orderBy(asc(docsRunSteps.position));
}

function requireOpen(run: Run) {
  if (run.status === "completed") throw new UserError("This run is already finished, so its steps cannot change. Start a new run if it needs doing again.");
  if (run.status === "cancelled") throw new UserError("This run was cancelled. Start a new run from the procedure.");
}

/** Ticks one step (once: a second tick by anyone is refused, saying who ticked it). */
export async function completeStep(ctx: ModuleContext, run: RunWithAccess, position: number, answer: string): Promise<void> {
  if (!ctx.can(P.run) || !canRead(run.access)) throw new UserError("You cannot complete steps of this run. Ask the owner.");
  requireOpen(run);
  const step = run.steps[position];
  if (!step) throw new UserError("That step is not in this run. Reload the page.");
  let stored = answer.trim();
  if (step.check === "yesno") {
    stored = stored.toLowerCase();
    if (stored !== "yes" && stored !== "no") throw new UserError(`Step ${position + 1} asks “${step.checkLabel}”: answer Yes or No.`);
  } else if (step.check === "value" && !stored) {
    throw new UserError(`Step ${position + 1} asks you to record “${step.checkLabel}”. Fill it in, then tick the step.`);
  }
  await ctx.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(docsRunSteps)
      .values({ runId: run.id, position, doneBy: ctx.viewer.id, doneByName: ctx.viewer.name, answer: stored })
      .onConflictDoNothing()
      .returning({ position: docsRunSteps.position });
    if (inserted.length === 0) {
      const [done] = await tx.select().from(docsRunSteps).where(and(eq(docsRunSteps.runId, run.id), eq(docsRunSteps.position, position)));
      throw new UserError(`${done?.doneByName ?? "Someone"} already ticked step ${position + 1}.`);
    }
    if (step.check === "yesno" && stored === "no") await tx.update(docsRuns).set({ flagged: true }).where(eq(docsRuns.id, run.id));
  });
}

/** Unticks a step: the person who ticked it, or a manager of the space, while the run is open. */
export async function undoStep(ctx: ModuleContext, run: RunWithAccess, position: number): Promise<void> {
  requireOpen(run);
  const [done] = await ctx.db.select().from(docsRunSteps).where(and(eq(docsRunSteps.runId, run.id), eq(docsRunSteps.position, position)));
  if (!done) return;
  if (done.doneBy !== ctx.viewer.id && !canManage(run.access)) throw new UserError(`Only ${done.doneByName} or a manager of the space can untick this step.`);
  await ctx.db.transaction(async (tx) => {
    await tx.delete(docsRunSteps).where(and(eq(docsRunSteps.runId, run.id), eq(docsRunSteps.position, position)));
    // Recompute the flag from what is left.
    const left = await tx.select().from(docsRunSteps).where(eq(docsRunSteps.runId, run.id));
    const flagged = left.some((s) => run.steps[s.position]?.check === "yesno" && s.answer === "no");
    await tx.update(docsRuns).set({ flagged }).where(eq(docsRuns.id, run.id));
  });
}

/** Finishes a run once every step is ticked. Only one finish counts (a conditional UPDATE). */
export async function finishRun(ctx: ModuleContext, run: RunWithAccess): Promise<Run> {
  if (!ctx.can(P.run) || !canRead(run.access)) throw new UserError("You cannot finish this run. Ask the owner.");
  requireOpen(run);
  const done = await runSteps(ctx.db, run.id);
  const missing = run.steps.map((_, i) => i).filter((i) => !done.some((d) => d.position === i));
  if (missing.length) throw new UserError(`Step${missing.length > 1 ? "s" : ""} ${missing.map((i) => i + 1).join(", ")} ${missing.length > 1 ? "are" : "is"} not ticked yet. Tick every step, then finish.`);
  const [finished] = await ctx.db
    .update(docsRuns)
    .set({ status: "completed", completedBy: ctx.viewer.id, completedByName: ctx.viewer.name, completedAt: new Date() })
    .where(and(eq(docsRuns.id, run.id), eq(docsRuns.status, "open")))
    .returning();
  if (!finished) throw new UserError("Someone finished or cancelled this run a moment ago. Reload the page.");
  const [space] = await ctx.db.select({ visibility: docsSpaces.visibility }).from(docsSpaces).where(eq(docsSpaces.id, run.pageSpaceId));
  await audit({
    actor: userActor(ctx.viewer),
    action: "docs.run_completed",
    module: MODULE_ID,
    target: { type: "docs_run", id: run.id },
    summary: `${ctx.viewer.name} finished "${run.title}" for ${run.dueOn}${finished.flagged ? " (a check was answered No)" : ""}.`,
    visibility: space?.visibility === "team" ? "everyone" : "admins",
  });
  const tell = new Set([run.startedBy, run.assignedTo].filter((id): id is string => Boolean(id) && id !== ctx.viewer.id));
  if (tell.size) {
    await notify([...tell], {
      kind: "docs.run_finished",
      title: `${ctx.viewer.name} finished: ${run.title}${finished.flagged ? " (a check was answered No)" : ""}`,
      url: `/m/${MODULE_ID}/runs/${run.id}`,
    });
  }
  return finished;
}

export async function cancelRun(ctx: ModuleContext, run: RunWithAccess): Promise<void> {
  requireOpen(run);
  if (run.startedBy !== ctx.viewer.id && !canManage(run.access)) throw new UserError("Only the person who started this run, or a manager of the space, can cancel it.");
  await ctx.db.update(docsRuns).set({ status: "cancelled" }).where(and(eq(docsRuns.id, run.id), eq(docsRuns.status, "open")));
  await audit({
    actor: userActor(ctx.viewer),
    action: "docs.run_cancelled",
    module: MODULE_ID,
    target: { type: "docs_run", id: run.id },
    summary: `${ctx.viewer.name} cancelled the run of "${run.title}" for ${run.dueOn}.`,
  });
}

export type RunListRow = Pick<Run, "id" | "pageId" | "title" | "status" | "dueOn" | "startedByName" | "startedAt" | "completedByName" | "completedAt" | "flagged"> & {
  assigneeName: string | null;
  stepCount: number;
  doneCount: number;
};

/** Runs in spaces the person can read: open first, then the newest. */
export async function listRuns(conn: Conn, who: Who, options: { pageId?: string; status?: "open" | "completed" | "cancelled"; limit?: number; mine?: boolean } = {}): Promise<RunListRow[]> {
  const ids = await readableSpaceIds(conn, who);
  if (ids.length === 0) return [];
  const rows = await conn
    .select({
      id: docsRuns.id,
      pageId: docsRuns.pageId,
      title: docsRuns.title,
      status: docsRuns.status,
      dueOn: docsRuns.dueOn,
      startedByName: docsRuns.startedByName,
      startedAt: docsRuns.startedAt,
      completedByName: docsRuns.completedByName,
      completedAt: docsRuns.completedAt,
      flagged: docsRuns.flagged,
      assigneeName: users.name,
      stepCount: sql<number>`jsonb_array_length(${docsRuns.steps})::int`,
      doneCount: sql<number>`(select count(*)::int from docs_run_steps s where s.run_id = ${docsRuns.id})`,
    })
    .from(docsRuns)
    .innerJoin(docsPages, eq(docsPages.id, docsRuns.pageId))
    .leftJoin(users, eq(users.id, docsRuns.assignedTo))
    .where(
      and(
        inArray(docsPages.spaceId, ids),
        options.pageId ? eq(docsRuns.pageId, options.pageId) : undefined,
        options.status ? eq(docsRuns.status, options.status) : undefined,
        options.mine ? or(eq(docsRuns.assignedTo, who.viewer.id), and(sql`${docsRuns.assignedTo} is null`, eq(docsRuns.startedBy, who.viewer.id))) : undefined,
      ),
    )
    .orderBy(sql`case when ${docsRuns.status} = 'open' then 0 else 1 end`, desc(docsRuns.dueOn), desc(docsRuns.startedAt))
    .limit(options.limit ?? 100);
  return rows;
}

export interface DueProcedure {
  pageId: string;
  title: string;
  spaceName: string;
  state: "not started" | "open" | "done";
  runId: string | null;
}

/** Scheduled procedures due today (business timezone) in spaces the person can read, and how far today's run is. */
export async function dueToday(conn: Conn, who: Who, timezone: string): Promise<DueProcedure[]> {
  const ids = await readableSpaceIds(conn, who);
  if (ids.length === 0) return [];
  const today = dayIn(timezone);
  const procs = await conn
    .select({ id: docsPages.id, title: docsPages.title, schedule: docsPages.schedule, scheduleDay: docsPages.scheduleDay, spaceName: docsSpaces.name })
    .from(docsPages)
    .innerJoin(docsSpaces, eq(docsSpaces.id, docsPages.spaceId))
    .where(
      and(
        inArray(docsPages.spaceId, ids),
        eq(docsPages.kind, "procedure"),
        eq(docsPages.isTemplate, false),
        sql`${docsPages.archivedAt} is null`,
        sql`${docsPages.schedule} <> 'none'`,
      ),
    )
    .orderBy(asc(docsPages.title));
  const due = procs.filter((p) => dueOn(p.schedule, p.scheduleDay, today));
  if (due.length === 0) return [];
  const runs = await conn
    .select({ id: docsRuns.id, pageId: docsRuns.pageId, status: docsRuns.status })
    .from(docsRuns)
    .where(and(inArray(docsRuns.pageId, due.map((p) => p.id)), eq(docsRuns.dueOn, today), sql`${docsRuns.status} <> 'cancelled'`))
    .orderBy(desc(docsRuns.startedAt));
  return due.map((p) => {
    const mine = runs.filter((r) => r.pageId === p.id);
    const done = mine.find((r) => r.status === "completed");
    const open = mine.find((r) => r.status === "open");
    return { pageId: p.id, title: p.title, spaceName: p.spaceName, state: done ? "done" : open ? "open" : "not started", runId: (done ?? open)?.id ?? null };
  });
}

/** Spaces where a person is a member: for picking whom to assign a run to. */
export async function assignablePeople(conn: Conn, page: PageWithSpace) {
  const people = await conn
    .select({ id: users.id, name: users.name, role: users.role, memberRole: docsSpaceMembers.role })
    .from(users)
    .leftJoin(docsSpaceMembers, and(eq(docsSpaceMembers.userId, users.id), eq(docsSpaceMembers.spaceId, page.spaceId)))
    .where(eq(users.status, "active"))
    .orderBy(asc(users.name));
  const out: { id: string; name: string }[] = [];
  for (const p of people) {
    const who = await whoFor(p);
    if (who.can(P.run) && canRead(accessFor(who, page.space, p.memberRole))) out.push({ id: p.id, name: p.name });
  }
  return out;
}
