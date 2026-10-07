import "server-only";
import { and, asc, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { audit, userActor } from "@/lib/audit";
import type { Db, DbTx } from "@/lib/db/client";
import { db as rootDb } from "@/lib/db/client";
import { files, users } from "@/lib/db/schema";
import { UserError } from "@/lib/errors";
import type { ModuleContext, SearchHit } from "@/lib/modules/contract";
import { notify, usersWithPermission } from "@/lib/notifications";
import { deleteStoredFile, saveFile } from "@/lib/storage";
import {
  MODULE_ID,
  NOTIFY,
  P,
  STATUS_LABEL,
  type ProjectVisibility,
  type ReminderKind,
  type TaskPriority,
  type TaskRecurrence,
  type TaskStatus,
} from "./constants";
import { addDays, daysBetween, findMentions, nextDueDate, positionAt, todayIn } from "./logic";
import {
  taskActivity,
  taskAssignees,
  taskAttachments,
  taskChecklistItems,
  taskComments,
  taskProjectMembers,
  taskProjects,
  taskReminders,
  tasks,
  taskWatchers,
} from "./schema";
import type { AhlTaskInput, TaskInput } from "./schemas";

export { MODULE_ID, P } from "./constants";

type Tx = Db | DbTx;
export interface Actor {
  id: string;
  name: string;
}
export interface Person {
  id: string;
  name: string;
  email: string;
}

// Qualified names for raw subqueries: Drizzle leaves the table off a column when a query has one table, which would bind it to the subquery's own table.
const PROJECT_ID = sql.raw(`"tasks_projects"."id"`);
const TASK_ID = sql.raw(`"tasks_tasks"."id"`);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Who can see what ─────────────────────────────────────────────────────────

/**
 * Projects the viewer can see: task managers see all; guests only projects
 * they are a member of; everyone else team projects and their private ones.
 * Use in queries that have tasks_projects in FROM.
 */
export function projectVisibleSql(ctx: ModuleContext): SQL {
  if (ctx.can(P.manage)) return sql`true`;
  const member = sql`exists (select 1 from ${taskProjectMembers} pm where pm.project_id = ${PROJECT_ID} and pm.user_id = ${ctx.viewer.id})`;
  if (ctx.viewer.role === "guest") return member;
  return sql`(${taskProjects.visibility} = 'team' or ${member})`;
}

/** The people who can see a project (for assignee lists, @mentions and notifications). */
export async function projectAudience(projectId: string, tx: Tx = rootDb()): Promise<(Person & { role: string })[]> {
  const [project] = await tx.select({ visibility: taskProjects.visibility }).from(taskProjects).where(eq(taskProjects.id, projectId));
  if (!project) return [];
  const [access, managers, memberRows, people] = await Promise.all([
    usersWithPermission(P.access),
    usersWithPermission(P.manage),
    tx.select({ userId: taskProjectMembers.userId }).from(taskProjectMembers).where(eq(taskProjectMembers.projectId, projectId)),
    tx.select({ id: users.id, name: users.name, email: users.email, role: users.role }).from(users).where(eq(users.status, "active")).orderBy(users.name),
  ]);
  const canAccess = new Set(access);
  const isManager = new Set(managers);
  const members = new Set(memberRows.map((m) => m.userId));
  return people.filter((u) => canAccess.has(u.id) && (members.has(u.id) || isManager.has(u.id) || (project.visibility === "team" && u.role !== "guest")));
}

/** Everyone active, for pickers on pages that are not about one project. */
export async function activePeople(tx: Tx = rootDb()): Promise<(Person & { role: string })[]> {
  return tx.select({ id: users.id, name: users.name, email: users.email, role: users.role }).from(users).where(eq(users.status, "active")).orderBy(users.name);
}

// ── Projects ─────────────────────────────────────────────────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  visibility: ProjectVisibility;
  isTemplate: boolean;
  archived: boolean;
  open: number;
  overdue: number;
  done: number;
}

export async function listProjects(ctx: ModuleContext, options: { templates?: boolean; includeArchived?: boolean } = {}): Promise<ProjectSummary[]> {
  const today = todayIn(ctx.business.timezone);
  return ctx.db
    .select({
      id: taskProjects.id,
      name: taskProjects.name,
      description: taskProjects.description,
      visibility: taskProjects.visibility,
      isTemplate: taskProjects.isTemplate,
      archived: taskProjects.archived,
      open: sql<number>`(select count(*)::int from ${tasks} t where t.project_id = ${PROJECT_ID} and t.status <> 'done')`,
      overdue: sql<number>`(select count(*)::int from ${tasks} t where t.project_id = ${PROJECT_ID} and t.status <> 'done' and t.due_on < ${today})`,
      done: sql<number>`(select count(*)::int from ${tasks} t where t.project_id = ${PROJECT_ID} and t.status = 'done')`,
    })
    .from(taskProjects)
    .where(
      and(
        eq(taskProjects.isTemplate, options.templates ?? false),
        options.includeArchived ? undefined : eq(taskProjects.archived, false),
        projectVisibleSql(ctx),
      ),
    )
    .orderBy(asc(taskProjects.archived), asc(sql`lower(${taskProjects.name})`));
}

export type Project = Omit<typeof taskProjects.$inferSelect, "search">;
const projectColumns = {
  id: taskProjects.id,
  name: taskProjects.name,
  description: taskProjects.description,
  visibility: taskProjects.visibility,
  isTemplate: taskProjects.isTemplate,
  archived: taskProjects.archived,
  createdBy: taskProjects.createdBy,
  createdAt: taskProjects.createdAt,
  updatedAt: taskProjects.updatedAt,
};

export async function getProject(ctx: ModuleContext, id: string): Promise<(Project & { members: Person[] }) | null> {
  const [project] = await ctx.db
    .select(projectColumns)
    .from(taskProjects)
    .where(and(eq(taskProjects.id, id), projectVisibleSql(ctx)));
  if (!project) return null;
  const members = await ctx.db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(taskProjectMembers)
    .innerJoin(users, eq(users.id, taskProjectMembers.userId))
    .where(eq(taskProjectMembers.projectId, id))
    .orderBy(users.name);
  return { ...project, members };
}

export async function createProject(
  tx: Tx,
  input: { name: string; description: string; visibility: ProjectVisibility; isTemplate?: boolean },
  actor: Actor,
  memberIds: string[] = [],
): Promise<Project> {
  const [project] = await tx
    .insert(taskProjects)
    .values({ name: input.name, description: input.description, visibility: input.visibility, isTemplate: input.isTemplate ?? false, createdBy: actor.id })
    .returning(projectColumns);
  const members = [...new Set([actor.id, ...memberIds])];
  await tx
    .insert(taskProjectMembers)
    .values(members.map((userId) => ({ projectId: project.id, userId })))
    .onConflictDoNothing();
  await audit(
    {
      actor: userActor(actor),
      action: input.isTemplate ? "tasks.template_created" : "tasks.project_created",
      module: MODULE_ID,
      target: { type: "project", id: project.id },
      summary: `${actor.name} created the ${input.isTemplate ? "template" : "project"} "${project.name}".`,
      visibility: input.visibility === "team" && !input.isTemplate ? "everyone" : "admins",
    },
    tx,
  );
  return project;
}

export async function updateProject(ctx: ModuleContext, id: string, input: { name: string; description: string; visibility: ProjectVisibility }): Promise<void> {
  const [row] = await ctx.db
    .update(taskProjects)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(taskProjects.id, id))
    .returning({ id: taskProjects.id });
  if (!row) throw new UserError("That project no longer exists.");
  await audit({
    actor: userActor(ctx.viewer),
    action: "tasks.project_updated",
    module: MODULE_ID,
    target: { type: "project", id },
    summary: `${ctx.viewer.name} changed the project "${input.name}" (${input.visibility === "private" ? "private" : "team"}).`,
  });
}

export async function setProjectArchived(ctx: ModuleContext, id: string, archived: boolean): Promise<void> {
  const [row] = await ctx.db
    .update(taskProjects)
    .set({ archived, updatedAt: new Date() })
    .where(eq(taskProjects.id, id))
    .returning({ name: taskProjects.name });
  if (!row) throw new UserError("That project no longer exists.");
  await audit({
    actor: userActor(ctx.viewer),
    action: archived ? "tasks.project_archived" : "tasks.project_restored",
    module: MODULE_ID,
    target: { type: "project", id },
    summary: `${ctx.viewer.name} ${archived ? "archived" : "brought back"} the project "${row.name}".`,
  });
}

export async function deleteProject(ctx: ModuleContext, id: string): Promise<string> {
  const attachmentFiles = await ctx.db
    .select({ fileId: taskAttachments.fileId })
    .from(taskAttachments)
    .innerJoin(tasks, eq(tasks.id, taskAttachments.taskId))
    .where(eq(tasks.projectId, id));
  const [row] = await ctx.db.delete(taskProjects).where(eq(taskProjects.id, id)).returning({ name: taskProjects.name });
  if (!row) throw new UserError("That project no longer exists.");
  for (const f of attachmentFiles) await deleteStoredFile(f.fileId);
  await audit({
    actor: userActor(ctx.viewer),
    action: "tasks.project_deleted",
    module: MODULE_ID,
    target: { type: "project", id },
    summary: `${ctx.viewer.name} deleted the project "${row.name}" and its tasks.`,
  });
  return row.name;
}

export async function addProjectMember(ctx: ModuleContext, projectId: string, userId: string): Promise<void> {
  const [person] = await ctx.db.select({ name: users.name }).from(users).where(and(eq(users.id, userId), eq(users.status, "active")));
  if (!person) throw new UserError("That person is not an active member of the suite.");
  await ctx.db.insert(taskProjectMembers).values({ projectId, userId }).onConflictDoNothing();
  await audit({
    actor: userActor(ctx.viewer),
    action: "tasks.member_added",
    module: MODULE_ID,
    target: { type: "project", id: projectId },
    summary: `${ctx.viewer.name} added ${person.name} to a project.`,
  });
}

export async function removeProjectMember(ctx: ModuleContext, projectId: string, userId: string): Promise<void> {
  await ctx.db.delete(taskProjectMembers).where(and(eq(taskProjectMembers.projectId, projectId), eq(taskProjectMembers.userId, userId)));
}

/** A project by id or name (not a template, not archived), for the AI and imports. */
export async function resolveProject(tx: Tx, ref: string, createIfMissing = false, actorId: string | null = null): Promise<{ id: string; name: string }> {
  const open = and(eq(taskProjects.isTemplate, false), eq(taskProjects.archived, false));
  if (UUID_RE.test(ref)) {
    const [p] = await tx.select({ id: taskProjects.id, name: taskProjects.name }).from(taskProjects).where(and(eq(taskProjects.id, ref), open));
    if (!p) throw new UserError(`There is no open project with the id ${ref}. It may have been archived or deleted.`);
    return p;
  }
  const found = await tx
    .select({ id: taskProjects.id, name: taskProjects.name })
    .from(taskProjects)
    .where(and(sql`lower(${taskProjects.name}) = lower(${ref.trim()})`, open));
  if (found.length === 0) {
    if (createIfMissing && !UUID_RE.test(ref)) {
      const [made] = await tx.insert(taskProjects).values({ name: ref.trim(), visibility: "team", createdBy: actorId }).returning({ id: taskProjects.id, name: taskProjects.name });
      return made;
    }
    throw new UserError(`There is no open project called “${ref}”. Create it first, or choose another project.`);
  }
  if (found.length > 1) throw new UserError(`More than one project is called “${ref}”. Use the project's id instead.`);
  return found[0];
}

/** People by email or full name (active only). */
export async function resolvePeople(tx: Tx, refs: string[]): Promise<string[]> {
  if (refs.length === 0) return [];
  const people = await activePeople(tx);
  return refs.map((ref) => {
    const r = ref.trim().toLowerCase();
    const byEmail = people.find((p) => p.email === r);
    if (byEmail) return byEmail.id;
    const byName = people.filter((p) => p.name.trim().toLowerCase() === r);
    if (byName.length === 1) return byName[0].id;
    if (byName.length > 1) throw new UserError(`More than one person is called “${ref}”. Use their email instead.`);
    throw new UserError(`No one in the suite has the email or name “${ref}”. Invite them first, or leave the task unassigned.`);
  });
}

// ── Task lists ───────────────────────────────────────────────────────────────

export interface TaskRow {
  id: string;
  projectId: string;
  projectName: string;
  isTemplate: boolean;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueOn: string | null;
  dueOffsetDays: number | null;
  labels: string[];
  recurrence: TaskRecurrence;
  position: number;
  completedAt: Date | null;
  sourceLabel: string | null;
  assignees: { id: string; name: string }[];
  checklistDone: number;
  checklistTotal: number;
  comments: number;
}

function jsonList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T[];
    } catch {
      return [];
    }
  }
  return [];
}

const taskRowColumns = {
  id: tasks.id,
  projectId: tasks.projectId,
  projectName: taskProjects.name,
  isTemplate: taskProjects.isTemplate,
  title: tasks.title,
  status: tasks.status,
  priority: tasks.priority,
  dueOn: tasks.dueOn,
  dueOffsetDays: tasks.dueOffsetDays,
  labels: tasks.labels,
  recurrence: tasks.recurrence,
  position: tasks.position,
  completedAt: tasks.completedAt,
  sourceLabel: tasks.sourceLabel,
  assignees: sql<unknown>`coalesce((select json_agg(json_build_object('id', u.id, 'name', u.name) order by u.name) from ${taskAssignees} a join ${users} u on u.id = a.user_id where a.task_id = ${TASK_ID}), '[]'::json)`,
  checklistDone: sql<number>`(select count(*)::int from ${taskChecklistItems} c where c.task_id = ${TASK_ID} and c.done)`,
  checklistTotal: sql<number>`(select count(*)::int from ${taskChecklistItems} c where c.task_id = ${TASK_ID})`,
  comments: sql<number>`(select count(*)::int from ${taskComments} c where c.task_id = ${TASK_ID})`,
};

export interface TaskFilter {
  projectId?: string;
  /** Only tasks assigned to this person. */
  assigneeId?: string;
  /** Only tasks with no one assigned. */
  unassigned?: boolean;
  statuses?: TaskStatus[];
  includeDone?: boolean;
  label?: string;
  priority?: TaskPriority;
  query?: string;
  dueFrom?: string;
  dueTo?: string;
  overdueOn?: string;
  sort?: "due" | "priority" | "board" | "recent";
  limit?: number;
}

export async function listTasks(ctx: ModuleContext, filter: TaskFilter = {}): Promise<TaskRow[]> {
  const conditions: (SQL | undefined)[] = [projectVisibleSql(ctx)];
  if (filter.projectId) conditions.push(eq(tasks.projectId, filter.projectId));
  else conditions.push(eq(taskProjects.isTemplate, false), eq(taskProjects.archived, false));
  if (filter.assigneeId) conditions.push(sql`exists (select 1 from ${taskAssignees} a where a.task_id = ${TASK_ID} and a.user_id = ${filter.assigneeId})`);
  if (filter.unassigned) conditions.push(sql`not exists (select 1 from ${taskAssignees} a where a.task_id = ${TASK_ID})`);
  if (filter.statuses?.length) conditions.push(inArray(tasks.status, filter.statuses));
  else if (!filter.includeDone) conditions.push(ne(tasks.status, "done"));
  if (filter.label) conditions.push(sql`lower(${filter.label}) = any (select lower(x) from unnest(${tasks.labels}) x)`);
  if (filter.priority) conditions.push(eq(tasks.priority, filter.priority));
  if (filter.query) conditions.push(sql`${tasks.search} @@ websearch_to_tsquery('simple', ${filter.query})`);
  if (filter.dueFrom) conditions.push(sql`${tasks.dueOn} >= ${filter.dueFrom}`);
  if (filter.dueTo) conditions.push(sql`${tasks.dueOn} <= ${filter.dueTo}`);
  if (filter.overdueOn) conditions.push(sql`${tasks.dueOn} < ${filter.overdueOn}`, ne(tasks.status, "done"));
  const priorityRank = sql`array_position(array['urgent','high','normal','low']::text[], ${tasks.priority}::text)`;
  const order =
    filter.sort === "board"
      ? [asc(tasks.position), asc(tasks.createdAt)]
      : filter.sort === "priority"
        ? [asc(priorityRank), sql`${tasks.dueOn} asc nulls last`, asc(tasks.position)]
        : filter.sort === "recent"
          ? [desc(tasks.updatedAt)]
          : [sql`${tasks.dueOn} asc nulls last`, asc(priorityRank), asc(tasks.position)];
  const rows = await ctx.db
    .select(taskRowColumns)
    .from(tasks)
    .innerJoin(taskProjects, eq(taskProjects.id, tasks.projectId))
    .where(and(...conditions))
    .orderBy(...order)
    .limit(Math.min(filter.limit ?? 500, 1000));
  return rows.map((r) => ({ ...r, assignees: jsonList<{ id: string; name: string }>(r.assignees) }));
}

/** Labels in use in a project (or everywhere the viewer can see), for filters. */
export async function labelsInUse(ctx: ModuleContext, projectId?: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ label: sql<string>`distinct unnest(${tasks.labels})` })
    .from(tasks)
    .innerJoin(taskProjects, eq(taskProjects.id, tasks.projectId))
    .where(and(projectVisibleSql(ctx), projectId ? eq(tasks.projectId, projectId) : undefined));
  return [...new Set(rows.map((r) => r.label))].sort((a, b) => a.localeCompare(b));
}

export async function dueSummary(ctx: ModuleContext): Promise<{ overdue: TaskRow[]; today: TaskRow[] }> {
  const today = todayIn(ctx.business.timezone);
  const mine = await listTasks(ctx, { assigneeId: ctx.viewer.id, dueTo: today, limit: 100 });
  return { overdue: mine.filter((t) => t.dueOn! < today), today: mine.filter((t) => t.dueOn === today) };
}

// ── One task ─────────────────────────────────────────────────────────────────

export type Task = Omit<typeof tasks.$inferSelect, "search">;
const taskColumns = {
  id: tasks.id,
  projectId: tasks.projectId,
  title: tasks.title,
  description: tasks.description,
  status: tasks.status,
  priority: tasks.priority,
  dueOn: tasks.dueOn,
  dueOffsetDays: tasks.dueOffsetDays,
  labels: tasks.labels,
  position: tasks.position,
  recurrence: tasks.recurrence,
  recurrenceOf: tasks.recurrenceOf,
  completedAt: tasks.completedAt,
  createdBy: tasks.createdBy,
  createdByName: tasks.createdByName,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
  sourceLabel: tasks.sourceLabel,
  sourceUrl: tasks.sourceUrl,
  externalId: tasks.externalId,
  externalUpdatedAt: tasks.externalUpdatedAt,
  sourceKey: tasks.sourceKey,
};

export interface TaskDetail {
  task: Task;
  project: { id: string; name: string; isTemplate: boolean; archived: boolean; visibility: ProjectVisibility };
  assignees: Person[];
  watching: boolean;
  watchers: { id: string; name: string }[];
  checklist: { id: string; text: string; done: boolean }[];
  comments: { id: string; authorId: string | null; authorName: string; body: string; createdAt: Date }[];
  attachments: { fileId: string; name: string; mime: string; size: number; createdAt: Date }[];
  activity: { id: string; actorName: string; summary: string; createdAt: Date }[];
  repeatedAs: { id: string; dueOn: string | null } | null;
}

export async function getTask(ctx: ModuleContext, id: string): Promise<TaskDetail | null> {
  const [row] = await ctx.db
    .select({
      task: taskColumns,
      project: { id: taskProjects.id, name: taskProjects.name, isTemplate: taskProjects.isTemplate, archived: taskProjects.archived, visibility: taskProjects.visibility },
    })
    .from(tasks)
    .innerJoin(taskProjects, eq(taskProjects.id, tasks.projectId))
    .where(and(eq(tasks.id, id), projectVisibleSql(ctx)));
  if (!row) return null;
  const [assignees, watchers, checklist, comments, attachments, activity, [repeatedAs]] = await Promise.all([
    ctx.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(taskAssignees)
      .innerJoin(users, eq(users.id, taskAssignees.userId))
      .where(eq(taskAssignees.taskId, id))
      .orderBy(users.name),
    ctx.db.select({ id: users.id, name: users.name }).from(taskWatchers).innerJoin(users, eq(users.id, taskWatchers.userId)).where(eq(taskWatchers.taskId, id)).orderBy(users.name),
    ctx.db
      .select({ id: taskChecklistItems.id, text: taskChecklistItems.text, done: taskChecklistItems.done })
      .from(taskChecklistItems)
      .where(eq(taskChecklistItems.taskId, id))
      .orderBy(asc(taskChecklistItems.position), asc(taskChecklistItems.text)),
    ctx.db
      .select({ id: taskComments.id, authorId: taskComments.authorId, authorName: taskComments.authorName, body: taskComments.body, createdAt: taskComments.createdAt })
      .from(taskComments)
      .where(eq(taskComments.taskId, id))
      .orderBy(asc(taskComments.createdAt)),
    ctx.db
      .select({ fileId: files.id, name: files.name, mime: files.mime, size: files.size, createdAt: taskAttachments.createdAt })
      .from(taskAttachments)
      .innerJoin(files, eq(files.id, taskAttachments.fileId))
      .where(eq(taskAttachments.taskId, id))
      .orderBy(asc(taskAttachments.createdAt)),
    ctx.db
      .select({ id: taskActivity.id, actorName: taskActivity.actorName, summary: taskActivity.summary, createdAt: taskActivity.createdAt })
      .from(taskActivity)
      .where(eq(taskActivity.taskId, id))
      .orderBy(desc(taskActivity.createdAt))
      .limit(100),
    ctx.db.select({ id: tasks.id, dueOn: tasks.dueOn }).from(tasks).where(eq(tasks.recurrenceOf, id)),
  ]);
  return {
    ...row,
    assignees,
    watchers,
    watching: watchers.some((w) => w.id === ctx.viewer.id),
    checklist,
    comments,
    attachments,
    activity,
    repeatedAs: repeatedAs ?? null,
  };
}

/** The task, if the viewer can see its project; null otherwise. */
export async function visibleTask(ctx: ModuleContext, id: string): Promise<{ id: string; projectId: string; title: string; isTemplate: boolean } | null> {
  const [row] = await ctx.db
    .select({ id: tasks.id, projectId: tasks.projectId, title: tasks.title, isTemplate: taskProjects.isTemplate })
    .from(tasks)
    .innerJoin(taskProjects, eq(taskProjects.id, tasks.projectId))
    .where(and(eq(tasks.id, id), projectVisibleSql(ctx)));
  return row ?? null;
}

async function logActivity(tx: Tx, taskId: string, actor: Actor, summary: string): Promise<void> {
  await tx.insert(taskActivity).values({ taskId, actorId: actor.id, actorName: actor.name, summary: summary.slice(0, 500) });
}

async function endOfColumn(tx: Tx, projectId: string, status: TaskStatus): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${tasks.position})` })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, status)));
  return (row?.max ?? 0) + 1;
}

async function names(tx: Tx, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx.select({ name: users.name }).from(users).where(inArray(users.id, ids)).orderBy(users.name);
  return rows.map((r) => r.name);
}

// ── Creating and changing tasks ──────────────────────────────────────────────

export interface NewTask {
  projectId: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueOn?: string | null;
  dueOffsetDays?: number | null;
  assigneeIds?: string[];
  labels?: string[];
  checklist?: string[];
  recurrence?: TaskRecurrence;
  sourceLabel?: string | null;
  sourceUrl?: string | null;
  externalId?: string | null;
  externalUpdatedAt?: Date | null;
  recurrenceOf?: string | null;
}

/**
 * Writes one task with its assignees, watchers and checklist. Returns the task
 * and a function that sends the "assigned to you" notices (call it after the
 * transaction commits). Assignees become project members, so they can see it.
 */
export async function createTask(
  tx: Tx,
  input: NewTask,
  actor: Actor,
  options: { sourceKey?: string; via?: "ai" | "import" | "user"; activity?: string } = {},
): Promise<{ task: Task; notifyAssigned: () => Promise<void> }> {
  const status = input.status ?? "todo";
  const assigneeIds = [...new Set(input.assigneeIds ?? [])];
  const [task] = await tx
    .insert(tasks)
    .values({
      projectId: input.projectId,
      title: input.title,
      description: input.description ?? "",
      status,
      priority: input.priority ?? "normal",
      dueOn: input.dueOn ?? null,
      dueOffsetDays: input.dueOffsetDays ?? null,
      labels: input.labels ?? [],
      position: await endOfColumn(tx, input.projectId, status),
      recurrence: input.recurrence ?? "none",
      recurrenceOf: input.recurrenceOf ?? null,
      completedAt: status === "done" ? new Date() : null,
      createdBy: actor.id,
      createdByName: actor.name,
      sourceLabel: input.sourceLabel || null,
      sourceUrl: input.sourceUrl || null,
      externalId: input.externalId ?? null,
      externalUpdatedAt: input.externalUpdatedAt ?? null,
      sourceKey: options.sourceKey ?? null,
    })
    .returning(taskColumns);
  if (assigneeIds.length) {
    await tx.insert(taskAssignees).values(assigneeIds.map((userId) => ({ taskId: task.id, userId })));
    await tx
      .insert(taskProjectMembers)
      .values(assigneeIds.map((userId) => ({ projectId: input.projectId, userId })))
      .onConflictDoNothing();
  }
  await tx
    .insert(taskWatchers)
    .values([...new Set([actor.id, ...assigneeIds])].map((userId) => ({ taskId: task.id, userId })))
    .onConflictDoNothing();
  const checklist = (input.checklist ?? []).filter((t) => t.trim());
  if (checklist.length) {
    await tx.insert(taskChecklistItems).values(checklist.map((text, position) => ({ taskId: task.id, text: text.trim().slice(0, 300), position })));
  }
  const via = options.via === "ai" ? " (drafted by the assistant, approved)" : options.via === "import" ? " (imported, approved)" : "";
  await logActivity(tx, task.id, actor, options.activity ?? `Created the task${via}.`);
  const notifyAssigned = async () => {
    const others = assigneeIds.filter((id) => id !== actor.id);
    await notify(others, { kind: NOTIFY.assigned, title: `${actor.name} gave you a task: ${task.title}`, body: task.dueOn ? `Due ${task.dueOn}` : undefined, url: `/m/${MODULE_ID}/t/${task.id}` });
  };
  return { task, notifyAssigned };
}

/** Turns a TaskInput (AI, CSV, other apps) into a task: looks up the project and the people. */
export async function createTaskFromInput(
  tx: Tx,
  input: TaskInput,
  actor: Actor,
  options: { sourceKey?: string; via?: "ai" | "import" | "user" } = {},
): Promise<{ task: Task; projectName: string; notifyAssigned: () => Promise<void> }> {
  const project = await resolveProject(tx, input.project, input.createProjectIfMissing, actor?.id ?? null);
  const assigneeIds = await resolvePeople(tx, input.assignees);
  const { task, notifyAssigned } = await createTask(
    tx,
    {
      projectId: project.id,
      title: input.title,
      description: input.description,
      status: input.status,
      priority: input.priority,
      dueOn: input.dueOn,
      assigneeIds,
      labels: input.labels,
      checklist: input.checklist,
      recurrence: input.recurrence,
      sourceLabel: input.sourceLabel,
      sourceUrl: input.sourceUrl,
    },
    actor,
    options,
  );
  return { task, projectName: project.name, notifyAssigned };
}

/**
 * Changes a task's status (and, on the board, its place in the column). When a
 * repeating task is done, its next copy is made once (a unique index on
 * recurrence_of makes a second copy impossible). Returns a function that sends
 * the notices; call it after the transaction commits.
 */
export async function setTaskStatus(
  tx: Tx,
  taskId: string,
  status: TaskStatus,
  actor: Actor,
  options: { timezone: string; position?: number; expectTitle?: string } ,
): Promise<{ task: Task; changed: boolean; next: Task | null; after: () => Promise<void> }> {
  const [current] = await tx.select(taskColumns).from(tasks).where(eq(tasks.id, taskId)).for("update");
  if (!current) throw new UserError("That task no longer exists.");
  if (options.expectTitle && options.expectTitle.trim().toLowerCase() !== current.title.trim().toLowerCase()) {
    throw new UserError(`The task is now called “${current.title}”, not “${options.expectTitle}”. Nothing was changed; check it and ask again.`);
  }
  const noop = async () => {};
  if (current.status === status) {
    if (options.position !== undefined && options.position !== current.position) {
      await tx.update(tasks).set({ position: options.position }).where(eq(tasks.id, taskId));
    }
    return { task: current, changed: false, next: null, after: noop };
  }
  const [task] = await tx
    .update(tasks)
    .set({
      status,
      completedAt: status === "done" ? new Date() : null,
      position: options.position ?? (await endOfColumn(tx, current.projectId, status)),
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))
    .returning(taskColumns);
  await logActivity(tx, taskId, actor, `Moved it from ${STATUS_LABEL[current.status]} to ${STATUS_LABEL[status]}.`);

  let next: Task | null = null;
  const [project] = await tx.select({ isTemplate: taskProjects.isTemplate }).from(taskProjects).where(eq(taskProjects.id, task.projectId));
  if (status === "done" && task.recurrence !== "none" && !project?.isTemplate) {
    const [already] = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.recurrenceOf, task.id));
    if (!already) {
      const dueOn = nextDueDate(task.dueOn, task.recurrence, todayIn(options.timezone));
      const [assigneeRows, checklistRows] = await Promise.all([
        tx.select({ userId: taskAssignees.userId }).from(taskAssignees).where(eq(taskAssignees.taskId, task.id)),
        tx.select({ text: taskChecklistItems.text }).from(taskChecklistItems).where(eq(taskChecklistItems.taskId, task.id)).orderBy(asc(taskChecklistItems.position)),
      ]);
      const made = await createTask(
        tx,
        {
          projectId: task.projectId,
          title: task.title,
          description: task.description,
          priority: task.priority,
          dueOn,
          assigneeIds: assigneeRows.map((a) => a.userId),
          labels: task.labels,
          checklist: checklistRows.map((c) => c.text),
          recurrence: task.recurrence,
          recurrenceOf: task.id,
          sourceLabel: task.sourceLabel,
          sourceUrl: task.sourceUrl,
        },
        actor,
        { activity: `Made automatically: the previous copy was done${dueOn ? `; this one is due ${dueOn}` : ""}.` },
      );
      next = made.task;
      await logActivity(tx, task.id, actor, `It repeats: the next copy is due ${dueOn}.`);
    }
  }

  const after = async () => {
    if (status !== "done") return;
    const watchers = await rootDb().select({ userId: taskWatchers.userId }).from(taskWatchers).where(eq(taskWatchers.taskId, taskId));
    await notify(
      watchers.map((w) => w.userId).filter((id) => id !== actor.id),
      { kind: NOTIFY.completed, title: `${actor.name} finished: ${task.title}`, url: `/m/${MODULE_ID}/t/${task.id}` },
    );
  };
  return { task, changed: true, next, after };
}

/** Drag and drop on the board: a new column and/or a new place in it. */
export async function moveTask(ctx: ModuleContext, taskId: string, status: TaskStatus, index: number): Promise<void> {
  const after = await ctx.db.transaction(async (tx) => {
    const [current] = await tx.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId));
    if (!current) throw new UserError("That task no longer exists. Reload the board.");
    const others = await tx
      .select({ position: tasks.position })
      .from(tasks)
      .where(and(eq(tasks.projectId, current.projectId), eq(tasks.status, status), ne(tasks.id, taskId)))
      .orderBy(asc(tasks.position), asc(tasks.createdAt));
    const position = positionAt(
      others.map((o) => o.position),
      index,
    );
    const result = await setTaskStatus(tx, taskId, status, ctx.viewer, { timezone: ctx.business.timezone, position });
    return result.after;
  });
  await after();
}

export interface TaskChanges {
  title: string;
  description: string;
  priority: TaskPriority;
  dueOn: string | null;
  dueOffsetDays: number | null;
  labels: string[];
  recurrence: TaskRecurrence;
  assigneeIds: string[];
}

/** Saves the edit form; every change is written to the task's history. */
export async function updateTask(ctx: ModuleContext, taskId: string, changes: TaskChanges): Promise<void> {
  const added = await ctx.db.transaction(async (tx) => {
    const [current] = await tx.select(taskColumns).from(tasks).where(eq(tasks.id, taskId)).for("update");
    if (!current) throw new UserError("That task no longer exists.");
    const lines: string[] = [];
    if (current.title !== changes.title) lines.push(`Renamed it from “${current.title}” to “${changes.title}”.`);
    if (current.description !== changes.description) lines.push("Changed the description.");
    if (current.priority !== changes.priority) lines.push(`Set the priority to ${changes.priority}.`);
    if (current.dueOn !== changes.dueOn) lines.push(changes.dueOn ? `Set the due date to ${changes.dueOn}.` : "Removed the due date.");
    if (current.dueOffsetDays !== changes.dueOffsetDays) lines.push(changes.dueOffsetDays === null ? "Removed the days after start." : `Set it to ${changes.dueOffsetDays} days after start.`);
    if (current.labels.join("\u0000") !== changes.labels.join("\u0000")) lines.push(changes.labels.length ? `Set the labels to ${changes.labels.join(", ")}.` : "Removed the labels.");
    if (current.recurrence !== changes.recurrence) lines.push(changes.recurrence === "none" ? "It no longer repeats." : `It now repeats (${changes.recurrence}).`);
    await tx
      .update(tasks)
      .set({
        title: changes.title,
        description: changes.description,
        priority: changes.priority,
        dueOn: changes.dueOn,
        dueOffsetDays: changes.dueOffsetDays,
        labels: changes.labels,
        recurrence: changes.recurrence,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));

    const before = (await tx.select({ userId: taskAssignees.userId }).from(taskAssignees).where(eq(taskAssignees.taskId, taskId))).map((a) => a.userId);
    const wanted = [...new Set(changes.assigneeIds)];
    const toAdd = wanted.filter((id) => !before.includes(id));
    const toRemove = before.filter((id) => !wanted.includes(id));
    if (toRemove.length) await tx.delete(taskAssignees).where(and(eq(taskAssignees.taskId, taskId), inArray(taskAssignees.userId, toRemove)));
    if (toAdd.length) {
      await tx.insert(taskAssignees).values(toAdd.map((userId) => ({ taskId, userId })));
      await tx.insert(taskWatchers).values(toAdd.map((userId) => ({ taskId, userId }))).onConflictDoNothing();
      await tx
        .insert(taskProjectMembers)
        .values(toAdd.map((userId) => ({ projectId: current.projectId, userId })))
        .onConflictDoNothing();
      lines.push(`Assigned it to ${(await names(tx, toAdd)).join(", ")}.`);
    }
    if (toRemove.length) lines.push(`Unassigned ${(await names(tx, toRemove)).join(", ")}.`);
    for (const line of lines) await logActivity(tx, taskId, ctx.viewer, line);
    return toAdd;
  });
  const others = added.filter((id) => id !== ctx.viewer.id);
  await notify(others, { kind: NOTIFY.assigned, title: `${ctx.viewer.name} gave you a task: ${changes.title}`, url: `/m/${MODULE_ID}/t/${taskId}` });
}

export async function deleteTask(ctx: ModuleContext, taskId: string): Promise<{ projectId: string; title: string }> {
  const fileIds = await ctx.db.select({ fileId: taskAttachments.fileId }).from(taskAttachments).where(eq(taskAttachments.taskId, taskId));
  const [row] = await ctx.db.delete(tasks).where(eq(tasks.id, taskId)).returning({ projectId: tasks.projectId, title: tasks.title });
  if (!row) throw new UserError("That task no longer exists.");
  for (const f of fileIds) await deleteStoredFile(f.fileId);
  await audit({
    actor: userActor(ctx.viewer),
    action: "tasks.task_deleted",
    module: MODULE_ID,
    target: { type: "task", id: taskId },
    summary: `${ctx.viewer.name} deleted the task "${row.title}".`,
  });
  return row;
}

// ── Comments, checklist, attachments, watching ───────────────────────────────

export async function addComment(ctx: ModuleContext, taskId: string, body: string): Promise<void> {
  const [task] = await ctx.db.select({ title: tasks.title, projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new UserError("That task no longer exists.");
  const audience = await projectAudience(task.projectId);
  const mentioned = findMentions(body, audience).filter((id) => id !== ctx.viewer.id);
  const watchers = await ctx.db.transaction(async (tx) => {
    await tx.insert(taskComments).values({ taskId, authorId: ctx.viewer.id, authorName: ctx.viewer.name, body });
    await tx.insert(taskWatchers).values({ taskId, userId: ctx.viewer.id }).onConflictDoNothing();
    await tx.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, taskId));
    return (await tx.select({ userId: taskWatchers.userId }).from(taskWatchers).where(eq(taskWatchers.taskId, taskId))).map((w) => w.userId);
  });
  const url = `/m/${MODULE_ID}/t/${taskId}`;
  const snippet = body.slice(0, 140);
  await notify(mentioned, { kind: NOTIFY.mentioned, title: `${ctx.viewer.name} mentioned you on “${task.title}”`, body: snippet, url });
  const audienceIds = new Set(audience.map((a) => a.id));
  await notify(
    watchers.filter((id) => id !== ctx.viewer.id && !mentioned.includes(id) && audienceIds.has(id)),
    { kind: NOTIFY.commented, title: `${ctx.viewer.name} commented on “${task.title}”`, body: snippet, url },
  );
}

export async function addChecklistItem(ctx: ModuleContext, taskId: string, text: string): Promise<void> {
  const [row] = await ctx.db
    .select({ max: sql<number | null>`max(${taskChecklistItems.position})` })
    .from(taskChecklistItems)
    .where(eq(taskChecklistItems.taskId, taskId));
  await ctx.db.insert(taskChecklistItems).values({ taskId, text, position: (row?.max ?? -1) + 1 });
}

export async function setChecklistItem(ctx: ModuleContext, itemId: string, done: boolean): Promise<string> {
  const [item] = await ctx.db
    .update(taskChecklistItems)
    .set({ done })
    .where(eq(taskChecklistItems.id, itemId))
    .returning({ taskId: taskChecklistItems.taskId, text: taskChecklistItems.text });
  if (!item) throw new UserError("That checklist item no longer exists.");
  await logActivity(ctx.db, item.taskId, ctx.viewer, `${done ? "Ticked" : "Unticked"} “${item.text}”.`);
  return item.taskId;
}

export async function deleteChecklistItem(ctx: ModuleContext, itemId: string): Promise<string | null> {
  const [item] = await ctx.db.delete(taskChecklistItems).where(eq(taskChecklistItems.id, itemId)).returning({ taskId: taskChecklistItems.taskId });
  return item?.taskId ?? null;
}

export async function checklistItemTask(ctx: ModuleContext, itemId: string): Promise<string | null> {
  const [item] = await ctx.db.select({ taskId: taskChecklistItems.taskId }).from(taskChecklistItems).where(eq(taskChecklistItems.id, itemId));
  return item?.taskId ?? null;
}

export async function addAttachment(ctx: ModuleContext, taskId: string, file: { name: string; mime: string; bytes: Uint8Array }): Promise<void> {
  const stored = await saveFile({ ...file, module: MODULE_ID }, ctx.viewer.id);
  await ctx.db.insert(taskAttachments).values({ taskId, fileId: stored.id, addedBy: ctx.viewer.id });
  await logActivity(ctx.db, taskId, ctx.viewer, `Attached “${stored.name}”.`);
}

export async function removeAttachment(ctx: ModuleContext, taskId: string, fileId: string): Promise<void> {
  const [row] = await ctx.db
    .delete(taskAttachments)
    .where(and(eq(taskAttachments.taskId, taskId), eq(taskAttachments.fileId, fileId)))
    .returning({ fileId: taskAttachments.fileId });
  if (!row) throw new UserError("That attachment is no longer on the task.");
  const [file] = await ctx.db.select({ name: files.name }).from(files).where(eq(files.id, fileId));
  await deleteStoredFile(fileId);
  await logActivity(ctx.db, taskId, ctx.viewer, `Removed the attachment “${file?.name ?? "file"}”.`);
}

export async function setWatching(ctx: ModuleContext, taskId: string, watch: boolean): Promise<void> {
  if (watch) await ctx.db.insert(taskWatchers).values({ taskId, userId: ctx.viewer.id }).onConflictDoNothing();
  else await ctx.db.delete(taskWatchers).where(and(eq(taskWatchers.taskId, taskId), eq(taskWatchers.userId, ctx.viewer.id)));
}

// ── Templates ────────────────────────────────────────────────────────────────

/** Copies a template's tasks into a new project; each due date is the start date plus the task's days after start. */
export async function projectFromTemplate(ctx: ModuleContext, templateId: string, name: string, startOn: string): Promise<Project> {
  return ctx.db.transaction(async (tx) => {
    const [template] = await tx.select(projectColumns).from(taskProjects).where(and(eq(taskProjects.id, templateId), eq(taskProjects.isTemplate, true)));
    if (!template) throw new UserError("That template no longer exists.");
    const members = await tx.select({ userId: taskProjectMembers.userId }).from(taskProjectMembers).where(eq(taskProjectMembers.projectId, templateId));
    const project = await createProject(
      tx,
      { name, description: template.description, visibility: template.visibility },
      ctx.viewer,
      members.map((m) => m.userId),
    );
    const source = await tx.select(taskColumns).from(tasks).where(eq(tasks.projectId, templateId)).orderBy(asc(tasks.position));
    for (const t of source) {
      const [assigneeRows, checklistRows] = await Promise.all([
        tx.select({ userId: taskAssignees.userId }).from(taskAssignees).where(eq(taskAssignees.taskId, t.id)),
        tx.select({ text: taskChecklistItems.text }).from(taskChecklistItems).where(eq(taskChecklistItems.taskId, t.id)).orderBy(asc(taskChecklistItems.position)),
      ]);
      await createTask(
        tx,
        {
          projectId: project.id,
          title: t.title,
          description: t.description,
          priority: t.priority,
          dueOn: t.dueOffsetDays === null ? null : addDays(startOn, t.dueOffsetDays),
          assigneeIds: assigneeRows.map((a) => a.userId),
          labels: t.labels,
          checklist: checklistRows.map((c) => c.text),
          recurrence: t.recurrence,
        },
        ctx.viewer,
        { activity: `Made from the template “${template.name}”.` },
      );
    }
    return project;
  });
}

/** Saves a project's tasks as a template: due dates become days after the earliest due date. */
export async function saveAsTemplate(ctx: ModuleContext, projectId: string, name: string): Promise<Project> {
  return ctx.db.transaction(async (tx) => {
    const [project] = await tx.select(projectColumns).from(taskProjects).where(eq(taskProjects.id, projectId));
    if (!project) throw new UserError("That project no longer exists.");
    const source = await tx.select(taskColumns).from(tasks).where(eq(tasks.projectId, projectId)).orderBy(asc(tasks.position));
    const dates = source.map((t) => t.dueOn).filter((d): d is string => Boolean(d)).sort();
    const start = dates[0] ?? null;
    const members = await tx.select({ userId: taskProjectMembers.userId }).from(taskProjectMembers).where(eq(taskProjectMembers.projectId, projectId));
    const template = await createProject(
      tx,
      { name, description: project.description, visibility: project.visibility, isTemplate: true },
      ctx.viewer,
      members.map((m) => m.userId),
    );
    for (const t of source) {
      const [assigneeRows, checklistRows] = await Promise.all([
        tx.select({ userId: taskAssignees.userId }).from(taskAssignees).where(eq(taskAssignees.taskId, t.id)),
        tx.select({ text: taskChecklistItems.text }).from(taskChecklistItems).where(eq(taskChecklistItems.taskId, t.id)).orderBy(asc(taskChecklistItems.position)),
      ]);
      await createTask(
        tx,
        {
          projectId: template.id,
          title: t.title,
          description: t.description,
          priority: t.priority,
          dueOffsetDays: t.dueOn && start ? daysBetween(start, t.dueOn) : null,
          assigneeIds: assigneeRows.map((a) => a.userId),
          labels: t.labels,
          checklist: checklistRows.map((c) => c.text),
          recurrence: t.recurrence,
        },
        ctx.viewer,
        { activity: `Copied from the project “${project.name}” into a template.` },
      );
    }
    return template;
  });
}

// ── Import from the AHL "Tasks" export ───────────────────────────────────────

/**
 * Writes one exported task: a new task, or an update to the one already
 * imported with the same externalId when the file's copy is newer.
 */
export async function importAhlTask(tx: Tx, input: AhlTaskInput, actor: Actor, sourceKey: string): Promise<{ taskId: string; summary: string; after?: () => Promise<void> }> {
  const updatedAt = new Date(input.externalUpdatedAt);
  const [existing] = await tx.select(taskColumns).from(tasks).where(eq(tasks.externalId, input.externalId)).for("update");
  if (existing) {
    if (existing.externalUpdatedAt && existing.externalUpdatedAt >= updatedAt) {
      return { taskId: existing.id, summary: `“${existing.title}” is already up to date` };
    }
    await tx
      .update(tasks)
      .set({
        title: input.title,
        description: input.detail,
        dueOn: input.dueOn,
        externalUpdatedAt: updatedAt,
        updatedAt: new Date(),
        ...(existing.status !== input.status ? { status: input.status, completedAt: input.status === "done" ? new Date() : null } : {}),
      })
      .where(eq(tasks.id, existing.id));
    await logActivity(tx, existing.id, actor, "Updated from a newer export file (imported, approved).");
    return { taskId: existing.id, summary: `Updated “${input.title}”` };
  }
  const [project] = await tx
    .select({ id: taskProjects.id })
    .from(taskProjects)
    .where(and(eq(taskProjects.id, input.projectId), eq(taskProjects.isTemplate, false)));
  if (!project) throw new UserError("The project chosen for this import no longer exists. Import the file again into another project.");
  let assigneeIds: string[] = [];
  if (input.assigneeId) {
    const [person] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, input.assigneeId), eq(users.status, "active")));
    assigneeIds = person ? [person.id] : [];
  }
  const { task, notifyAssigned } = await createTask(
    tx,
    {
      projectId: input.projectId,
      title: input.title,
      description: input.detail,
      status: input.status,
      dueOn: input.dueOn,
      assigneeIds,
      sourceLabel: input.sourceLabel ? `Imported: ${input.sourceLabel}` : "Imported from a Tasks export",
      externalId: input.externalId,
      externalUpdatedAt: updatedAt,
    },
    actor,
    { sourceKey, via: "import" },
  );
  return { taskId: task.id, summary: `Added “${task.title}”`, after: notifyAssigned };
}

// ── Reminders ────────────────────────────────────────────────────────────────

let lastSweep = 0;
/** Reminders are checked at most this often, whatever triggers the check. */
export const REMINDER_SWEEP_MS = 5 * 60_000;

/**
 * Sends "due today" and "overdue" reminders, each once per task and due date
 * (the tasks_reminders row is the guard, so two servers or two page loads
 * never send twice). Goes to the assignees, or the creator when no one is
 * assigned. Run from the home page's "what needs me" (throttled).
 */
export async function sendDueReminders(timezone: string, options: { now?: Date; force?: boolean } = {}): Promise<number> {
  const now = options.now ?? new Date();
  if (!options.force && now.getTime() - lastSweep < REMINDER_SWEEP_MS) return 0;
  lastSweep = now.getTime();
  const today = todayIn(timezone, now);
  const due = await rootDb()
    .select({ id: tasks.id, title: tasks.title, dueOn: tasks.dueOn, createdBy: tasks.createdBy })
    .from(tasks)
    .innerJoin(taskProjects, eq(taskProjects.id, tasks.projectId))
    .where(
      and(
        ne(tasks.status, "done"),
        sql`${tasks.dueOn} <= ${today}`,
        eq(taskProjects.isTemplate, false),
        eq(taskProjects.archived, false),
        sql`not exists (select 1 from ${taskReminders} r where r.task_id = ${TASK_ID} and r.due_on = ${tasks.dueOn} and r.kind = (case when ${tasks.dueOn} = ${today} then 'due_today' else 'overdue' end)::tasks_reminder_kind)`,
      ),
    )
    .limit(200);
  let sent = 0;
  for (const t of due) {
    const kind: ReminderKind = t.dueOn === today ? "due_today" : "overdue";
    const claimed = await rootDb()
      .insert(taskReminders)
      .values({ taskId: t.id, kind, dueOn: t.dueOn! })
      .onConflictDoNothing()
      .returning({ taskId: taskReminders.taskId });
    if (claimed.length === 0) continue;
    const assignees = (await rootDb().select({ userId: taskAssignees.userId }).from(taskAssignees).where(eq(taskAssignees.taskId, t.id))).map((a) => a.userId);
    const to = assignees.length ? assignees : t.createdBy ? [t.createdBy] : [];
    await notify(to, {
      kind: NOTIFY.due,
      title: kind === "due_today" ? `Due today: ${t.title}` : `Overdue: ${t.title}`,
      body: kind === "overdue" ? `It was due ${t.dueOn}.` : undefined,
      url: `/m/${MODULE_ID}/t/${t.id}`,
    });
    sent += 1;
  }
  return sent;
}

// ── Search ───────────────────────────────────────────────────────────────────

export async function searchTasks(ctx: ModuleContext, query: string, limit: number): Promise<SearchHit[]> {
  const q = sql`websearch_to_tsquery('simple', ${query})`;
  const [taskHits, projectHits] = await Promise.all([
    ctx.db
      .select({
        id: tasks.id,
        title: tasks.title,
        projectName: taskProjects.name,
        status: tasks.status,
        updatedAt: tasks.updatedAt,
        rank: sql<number>`ts_rank(${tasks.search}, ${q})`,
        snippet: sql<string>`ts_headline('simple', ${tasks.description}, ${q}, 'MaxWords=24, MinWords=8, StartSel=«, StopSel=»')`,
      })
      .from(tasks)
      .innerJoin(taskProjects, eq(taskProjects.id, tasks.projectId))
      .where(and(sql`${tasks.search} @@ ${q}`, projectVisibleSql(ctx)))
      .orderBy(desc(sql`ts_rank(${tasks.search}, ${q})`))
      .limit(limit),
    ctx.db
      .select({ id: taskProjects.id, name: taskProjects.name, isTemplate: taskProjects.isTemplate, description: taskProjects.description, rank: sql<number>`ts_rank(${taskProjects.search}, ${q})`, updatedAt: taskProjects.updatedAt })
      .from(taskProjects)
      .where(and(sql`${taskProjects.search} @@ ${q}`, projectVisibleSql(ctx)))
      .orderBy(desc(sql`ts_rank(${taskProjects.search}, ${q})`))
      .limit(Math.min(5, limit)),
  ]);
  return [
    ...taskHits.map((r) => ({
      title: r.title,
      snippet: `${r.projectName} · ${STATUS_LABEL[r.status]}${r.snippet && r.snippet !== "" ? ` · ${r.snippet}` : ""}`,
      url: `/m/${MODULE_ID}/t/${r.id}`,
      rank: Number(r.rank),
      at: r.updatedAt,
    })),
    ...projectHits.map((r) => ({
      title: `${r.isTemplate ? "Template" : "Project"}: ${r.name}`,
      snippet: r.description.slice(0, 160),
      url: `/m/${MODULE_ID}/p/${r.id}`,
      rank: Number(r.rank),
      at: r.updatedAt,
    })),
  ]
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit);
}

// ── Demo data ────────────────────────────────────────────────────────────────

/** Invented example data, clearly labelled, so a new suite does not open on an empty page. */
export async function seedDemo(ctx: ModuleContext): Promise<void> {
  const today = todayIn(ctx.business.timezone);
  const owner = ctx.viewer;
  await ctx.db.transaction(async (tx) => {
    const demo = await createProject(
      tx,
      {
        name: "Example: Shop window refresh",
        description: "Example data, made up to show how Tasks works. Rename it, or delete it in the project's settings when you are ready.",
        visibility: "team",
      },
      owner,
    );
    const add = (t: Omit<NewTask, "projectId">) => createTask(tx, { projectId: demo.id, ...t }, owner, { activity: "Created as example data." });
    await add({ title: "Measure the window and take photos", status: "done", priority: "normal", dueOn: addDays(today, -3), assigneeIds: [owner.id], labels: ["example"] });
    await add({
      title: "Choose the new display theme",
      status: "doing",
      priority: "high",
      dueOn: today,
      assigneeIds: [owner.id],
      labels: ["example", "design"],
      description: "Pick one idea from the mood board and write down the three items it needs.",
      checklist: ["Look at last year's photos", "Shortlist three ideas", "Pick one"],
    });
    await add({ title: "Order props and lighting", status: "todo", priority: "normal", dueOn: addDays(today, 4), labels: ["example", "buying"] });
    await add({ title: "Book a quiet morning to set it up", status: "waiting", priority: "low", dueOn: addDays(today, 9), labels: ["example"] });
    await add({ title: "Water the window plants", status: "todo", priority: "low", dueOn: addDays(today, 1), recurrence: "weekly", labels: ["example"], assigneeIds: [owner.id] });

    const template = await createProject(
      tx,
      {
        name: "Example template: A new person starts",
        description: "Example data: the steps for someone's first two weeks. Start a project from it with their start date.",
        visibility: "team",
        isTemplate: true,
      },
      owner,
    );
    const step = (title: string, dueOffsetDays: number, checklist: string[] = []) =>
      createTask(tx, { projectId: template.id, title, dueOffsetDays, checklist, labels: ["example"] }, owner, { activity: "Created as example data." });
    await step("Send the welcome email and first-day plan", 0, ["Start time and address", "Who meets them"]);
    await step("Invite them to the suite", 0);
    await step("Walk through the safety and closing-up procedures", 1);
    await step("First week check-in", 5);
    await step("Two-week review", 14);
  });
}
