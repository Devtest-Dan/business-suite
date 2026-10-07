import Link from "next/link";
import { z } from "zod";
import { defineAction, defineModule, defineReadTool } from "@/lib/modules/contract";
import { MODULE_ID, P, PRIORITY_LABEL, RECURRENCE_LABEL, STATUS_LABEL, TASK_STATUSES } from "./constants";
import {
  createTaskFromInput,
  dueSummary,
  importAhlTask,
  listProjects,
  listTasks,
  resolvePeople,
  searchTasks,
  seedDemo,
  sendDueReminders,
  setTaskStatus,
  type TaskRow,
} from "./data";
import { describeDue, todayIn } from "./logic";
import { BoardPage } from "./pages/board";
import { CalendarPage, ProjectCalendarPage } from "./pages/calendar";
import { ImportPage } from "./pages/import";
import { MyTasksPage } from "./pages/my-tasks";
import { NewProjectPage } from "./pages/new-project";
import { ProjectPage } from "./pages/project";
import { ProjectSettingsPage } from "./pages/project-settings";
import { ProjectsPage } from "./pages/projects";
import { TaskPage } from "./pages/task";
import { TemplatesPage } from "./pages/templates";
import { ahlTaskInput, statusInput, taskInput, type AhlTaskInput, type StatusInput, type TaskInput } from "./schemas";

/** What the AI sees of a task: small, plain JSON with ids. */
function forAi(t: TaskRow, today: string) {
  return {
    id: t.id,
    title: t.title,
    project: t.projectName,
    projectId: t.projectId,
    status: t.status,
    priority: t.priority,
    dueOn: t.dueOn,
    due: t.dueOn ? describeDue(t.dueOn, today) : null,
    assignees: t.assignees.map((a) => a.name),
    labels: t.labels,
    checklist: t.checklistTotal ? `${t.checklistDone}/${t.checklistTotal}` : null,
  };
}

/** Tasks: projects, a board, a calendar and "My tasks" for the whole team. */
export const tasks = defineModule({
  id: MODULE_ID,
  name: "Tasks",
  description: "Projects and tasks for the team: lists, a board, a calendar, reminders and templates.",
  version: "1.0.0",
  icon: "check",
  nav: [
    { label: "My tasks", path: "", icon: "check" },
    { label: "Projects", path: "projects", icon: "list" },
    { label: "Calendar", path: "calendar", icon: "calendar" },
    { label: "Templates", path: "templates", icon: "grid", permission: P.manage },
    { label: "Import", path: "import", icon: "upload", permission: P.import },
  ],
  permissions: [
    { key: P.access, label: "See tasks", description: "Open Tasks and see the projects they belong to (guests: only projects they are added to).", defaultRoles: ["owner", "admin", "member", "guest"] },
    { key: P.comment, label: "Comment on tasks", description: "Write comments and @mention people on tasks they can see.", defaultRoles: ["owner", "admin", "member", "guest"] },
    { key: P.edit, label: "Add and change tasks", description: "Add tasks, change them, move them on the board, tick checklists and attach files.", defaultRoles: ["owner", "admin", "member"] },
    { key: P.manage, label: "Manage projects", description: "Create, change, archive and delete projects and templates, choose their members, and see every project.", defaultRoles: ["owner", "admin"] },
    { key: P.import, label: "Import tasks", description: "Import tasks from a CSV or a Tasks export file, sent for approval as one batch.", defaultRoles: ["owner", "admin"] },
  ],
  routes: [
    { path: "", title: "My tasks", permission: P.access, page: MyTasksPage },
    { path: "projects", title: "Projects", permission: P.access, page: ProjectsPage },
    { path: "projects/new", title: "New project", permission: P.manage, page: NewProjectPage },
    { path: "calendar", title: "Calendar", permission: P.access, page: CalendarPage },
    { path: "templates", title: "Templates", permission: P.manage, page: TemplatesPage },
    { path: "import", title: "Import tasks", permission: P.import, page: ImportPage },
    { path: "p/:projectId", title: "Project", permission: P.access, page: ProjectPage },
    { path: "p/:projectId/board", title: "Board", permission: P.access, page: BoardPage },
    { path: "p/:projectId/calendar", title: "Project calendar", permission: P.access, page: ProjectCalendarPage },
    { path: "p/:projectId/settings", title: "Project settings", permission: P.manage, page: ProjectSettingsPage },
    { path: "t/:taskId", title: "Task", permission: P.access, page: TaskPage },
  ],
  migrations: { folder: "modules/tasks/migrations" },
  search: { label: "Tasks", permission: P.access, search: searchTasks },
  notifications: [
    { kind: "tasks.assigned", label: "Someone gives you a task", pushByDefault: true },
    { kind: "tasks.mentioned", label: "Someone @mentions you on a task", pushByDefault: true },
    { kind: "tasks.due", label: "A task of yours is due today or overdue", pushByDefault: true },
    { kind: "tasks.commented", label: "A comment on a task you watch", pushByDefault: false },
    { kind: "tasks.completed", label: "A task you watch is done", pushByDefault: false },
  ],
  widget: {
    title: "Due today and overdue",
    permission: P.access,
    render: async (ctx) => {
      const { overdue, today } = await dueSummary(ctx);
      const day = todayIn(ctx.business.timezone);
      if (overdue.length + today.length === 0) {
        return (
          <p className="muted text-sm" data-testid="tasks-widget">
            Nothing of yours is due today or late.{" "}
            <Link className="link" href={`/m/${MODULE_ID}`}>
              My tasks
            </Link>
          </p>
        );
      }
      const list = [...overdue, ...today].slice(0, 6);
      return (
        <div className="space-y-2" data-testid="tasks-widget">
          <p className="text-sm font-medium">
            {overdue.length ? <span className="text-danger">{overdue.length} overdue</span> : null}
            {overdue.length && today.length ? " · " : null}
            {today.length ? <span>{today.length} due today</span> : null}
          </p>
          <ul className="space-y-1 text-sm">
            {list.map((t) => (
              <li key={t.id} className="flex justify-between gap-2">
                <Link className="link truncate" href={`/m/${MODULE_ID}/t/${t.id}`}>
                  {t.title}
                </Link>
                <span className={`shrink-0 text-xs ${t.dueOn! < day ? "text-danger" : "text-subtle"}`}>{describeDue(t.dueOn, day)}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    },
  },
  needsMe: async (ctx) => {
    if (!ctx.can(P.access)) return [];
    // Opening the home page is what sends due/overdue reminders (each once; throttled).
    await sendDueReminders(ctx.business.timezone).catch((error) => console.error(`Task reminders failed: ${error instanceof Error ? error.message : error}`));
    const { overdue, today } = await dueSummary(ctx);
    const day = todayIn(ctx.business.timezone);
    return [...overdue, ...today].slice(0, 5).map((t) => ({ title: `${t.dueOn! < day ? "Overdue" : "Due today"}: ${t.title}`, detail: t.projectName, url: `/m/${MODULE_ID}/t/${t.id}` }));
  },
  actions: [
    defineAction<TaskInput>({
      name: "create_task",
      label: "Add a task",
      permission: P.edit,
      input: taskInput,
      preview: (t) =>
        [
          `Add “${t.title}” to ${t.project}`,
          t.assignees.length ? `for ${t.assignees.join(", ")}` : "",
          t.dueOn ? `due ${t.dueOn}` : "",
          t.priority !== "normal" ? `(${PRIORITY_LABEL[t.priority].toLowerCase()} priority)` : "",
          t.status !== "todo" ? `as ${STATUS_LABEL[t.status]}` : "",
          t.recurrence !== "none" ? `, ${RECURRENCE_LABEL[t.recurrence].toLowerCase()}` : "",
          t.checklist.length ? `with a ${t.checklist.length}-item checklist` : "",
        ]
          .filter(Boolean)
          .join(" "),
      sideEffects: "database",
      apply: async (ctx, input) => {
        const actor = ctx.requestedBy ?? ctx.approver;
        const { task, projectName, notifyAssigned } = await createTaskFromInput(ctx.tx, input, actor, { sourceKey: `${ctx.approvalId}:${ctx.dedupeKey}`, via: ctx.source });
        return { targetId: task.id, summary: `Added “${task.title}” to ${projectName}`, after: notifyAssigned };
      },
    }),
    defineAction<StatusInput>({
      name: "set_status",
      label: "Change a task's status",
      permission: P.edit,
      input: statusInput,
      preview: (s) => `Mark ${s.title ? `“${s.title}”` : "a task"} (${s.taskId.slice(0, 8)}) as ${STATUS_LABEL[s.status]}`,
      sideEffects: "database",
      apply: async (ctx, input) => {
        const actor = ctx.requestedBy ?? ctx.approver;
        const { task, changed, after } = await setTaskStatus(ctx.tx, input.taskId, input.status, actor, { timezone: ctx.business.timezone, expectTitle: input.title });
        return { targetId: task.id, summary: changed ? `“${task.title}” is now ${STATUS_LABEL[input.status]}` : `“${task.title}” was already ${STATUS_LABEL[input.status]}`, after };
      },
    }),
    defineAction<AhlTaskInput>({
      name: "import_ahl_task",
      label: "Import a task from a Tasks export",
      permission: P.import,
      input: ahlTaskInput,
      preview: (t) => `Add or update “${t.title}”${t.dueOn ? `, due ${t.dueOn}` : ""} (${STATUS_LABEL[t.status]})${t.sourceLabel ? ` · from ${t.sourceLabel}` : ""}`,
      dedupeKey: (t) => `ahl:${t.externalId}:${new Date(t.externalUpdatedAt).toISOString()}`,
      sideEffects: "database",
      apply: async (ctx, input) => {
        const actor = ctx.requestedBy ?? ctx.approver;
        const done = await importAhlTask(ctx.tx, input, actor, `${ctx.approvalId}:${ctx.dedupeKey}`);
        return { targetId: done.taskId, summary: done.summary, after: done.after };
      },
    }),
  ],
  aiTools: [
    defineReadTool<{ includeArchived: boolean }>({
      name: "list_projects",
      description: "List the task projects the person can see, with how many tasks are open, overdue and done.",
      permission: P.access,
      input: z.object({ includeArchived: z.boolean().default(false) }),
      run: async (ctx, { includeArchived }) =>
        (await listProjects(ctx, { includeArchived })).map((p) => ({ id: p.id, name: p.name, open: p.open, overdue: p.overdue, done: p.done, archived: p.archived })),
    }),
    defineReadTool<{ project?: string; assignee?: string; status?: (typeof TASK_STATUSES)[number]; includeDone: boolean; limit: number }>({
      name: "list_tasks",
      description:
        'List tasks. Optional filters: project (name or id), assignee ("me", or a person\'s email or full name), status (todo, doing, waiting, done). Open tasks only unless includeDone is true or status is "done". Sorted by due date.',
      permission: P.access,
      input: z.object({
        project: z.string().max(200).optional(),
        assignee: z.string().max(200).optional(),
        status: z.enum(TASK_STATUSES).optional(),
        includeDone: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      run: async (ctx, input) => {
        const today = todayIn(ctx.business.timezone);
        let projectId: string | undefined;
        if (input.project) {
          const projects = await listProjects(ctx, { includeArchived: true });
          const match = projects.find((p) => p.id === input.project || p.name.toLowerCase() === input.project!.trim().toLowerCase());
          if (!match) return { error: `No project called “${input.project}” that this person can see. Use list_projects.` };
          projectId = match.id;
        }
        let assigneeId: string | undefined;
        if (input.assignee) {
          if (input.assignee.trim().toLowerCase() === "me") assigneeId = ctx.viewer.id;
          else {
            try {
              [assigneeId] = await resolvePeople(ctx.db, [input.assignee]);
            } catch (error) {
              return { error: error instanceof Error ? error.message : "Unknown person." };
            }
          }
        }
        const rows = await listTasks(ctx, { projectId, assigneeId, statuses: input.status ? [input.status] : undefined, includeDone: input.includeDone, limit: input.limit });
        return rows.map((t) => forAi(t, today));
      },
    }),
    defineReadTool<{ query: string }>({
      name: "find_tasks",
      description: "Full-text search of tasks (titles and descriptions), open and done.",
      permission: P.access,
      input: z.object({ query: z.string().min(1).max(200) }),
      run: async (ctx, { query }) => {
        const today = todayIn(ctx.business.timezone);
        return (await listTasks(ctx, { query, includeDone: true, limit: 20 })).map((t) => forAi(t, today));
      },
    }),
    defineReadTool<{ mineOnly: boolean }>({
      name: "overdue_tasks",
      description: "Open tasks whose due date has passed (in the business's timezone), oldest first. mineOnly limits it to the person asking.",
      permission: P.access,
      input: z.object({ mineOnly: z.boolean().default(false) }),
      run: async (ctx, { mineOnly }) => {
        const today = todayIn(ctx.business.timezone);
        const rows = await listTasks(ctx, { overdueOn: today, assigneeId: mineOnly ? ctx.viewer.id : undefined, limit: 100 });
        return { today, overdue: rows.map((t) => forAi(t, today)) };
      },
    }),
    { kind: "write", name: "create_task", description: "Add one task to a project (give the project's name or id; assignees by email or full name).", action: "create_task" },
    { kind: "write", name: "create_tasks", description: "Add several tasks as one batch (e.g. the steps of a plan). The whole batch is one approval.", action: "create_task", batch: true },
    { kind: "write", name: "update_task_status", description: "Change one task's status (todo, doing, waiting, done). Give the task id from list_tasks and its title.", action: "set_status" },
    { kind: "write", name: "update_task_statuses", description: "Change the status of several tasks as one batch. Give each task's id and title.", action: "set_status", batch: true },
  ],
  seed: seedDemo,
});
