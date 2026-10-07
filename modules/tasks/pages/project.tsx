import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { fromTemplateAction, quickAddTask } from "../actions";
import { P, PRIORITY_LABEL, STATUS_LABEL, TASK_PRIORITIES, TASK_STATUSES, type TaskPriority, type TaskStatus } from "../constants";
import { getProject, labelsInUse, listTasks, projectAudience } from "../data";
import { todayIn } from "../logic";
import { idSchema } from "../schemas";
import { NotFoundCard, ProjectHeader } from "./parts";
import { TaskList } from "./task-list";

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v || undefined;
}

/** The list view, with filters. A template shows its steps and "Start a project from it". */
export async function ProjectPage({ ctx, params, basePath, searchParams }: ModulePageProps) {
  const id = idSchema.safeParse(params.projectId);
  const project = id.success ? await getProject(ctx, id.data) : null;
  if (!project) return <NotFoundCard what="Project" basePath={basePath} />;
  const today = todayIn(ctx.business.timezone);

  const status = one(searchParams.status);
  const assignee = one(searchParams.assignee);
  const label = one(searchParams.label);
  const priority = one(searchParams.priority);
  const q = one(searchParams.q)?.slice(0, 200);
  const sort = one(searchParams.sort) === "priority" ? "priority" : "due";
  const statuses = status === "all" ? undefined : TASK_STATUSES.includes(status as TaskStatus) ? [status as TaskStatus] : undefined;
  const [tasks, people, labels] = await Promise.all([
    listTasks(ctx, {
      projectId: project.id,
      statuses,
      includeDone: status === "all" || project.isTemplate,
      assigneeId: assignee && assignee !== "none" && idSchema.safeParse(assignee).success ? assignee : undefined,
      unassigned: assignee === "none",
      label,
      priority: TASK_PRIORITIES.includes(priority as TaskPriority) ? (priority as TaskPriority) : undefined,
      query: q,
      sort: project.isTemplate ? "board" : sort,
    }),
    projectAudience(project.id),
    labelsInUse(ctx, project.id),
  ]);
  const canEdit = ctx.can(P.edit) && !project.archived;
  const canManage = ctx.can(P.manage);
  const filtered = Boolean(status || assignee || label || priority || q);

  return (
    <div className="space-y-6">
      <ProjectHeader basePath={basePath} project={project} active="list" canManage={canManage} />

      {project.isTemplate && canManage ? (
        <ActionForm action={fromTemplateAction} submit="Start a project" className="card grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
          <input type="hidden" name="templateId" value={project.id} />
          <label className="block">
            <span className="label">New project’s name</span>
            <input name="name" required maxLength={120} className="input" defaultValue={project.name.replace(/^Example template: /, "")} />
          </label>
          <label className="block">
            <span className="label">Start date</span>
            <input type="date" name="startOn" required className="input" defaultValue={today} />
          </label>
        </ActionForm>
      ) : null}

      {canEdit ? (
        <ActionForm action={quickAddTask} submit="Add task" className="card grid gap-3 sm:grid-cols-[1fr_10rem_12rem_auto] sm:items-end" resetOnSuccess>
          <input type="hidden" name="projectId" value={project.id} />
          <label className="block">
            <span className="label">{project.isTemplate ? "New step" : "New task"}</span>
            <input name="title" required maxLength={200} className="input" placeholder="What needs doing?" />
          </label>
          {project.isTemplate ? (
            <p className="hint self-center">Set its days after start on the step itself.</p>
          ) : (
            <label className="block">
              <span className="label">Due</span>
              <input type="date" name="dueOn" className="input" />
            </label>
          )}
          <label className="block">
            <span className="label">Assign to</span>
            <select name="assigneeId" className="input" defaultValue="">
              <option value="">No one yet</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </ActionForm>
      ) : null}

      {!project.isTemplate ? (
        <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Filter tasks">
          <label className="block">
            <span className="label">Search</span>
            <input name="q" defaultValue={q} className="input" placeholder="Words in the task" />
          </label>
          <label className="block">
            <span className="label">Status</span>
            <select name="status" defaultValue={status ?? ""} className="input">
              <option value="">Open</option>
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
              <option value="all">All, with done</option>
            </select>
          </label>
          <label className="block">
            <span className="label">Person</span>
            <select name="assignee" defaultValue={assignee ?? ""} className="input">
              <option value="">Anyone</option>
              <option value={ctx.viewer.id}>Me</option>
              <option value="none">No one</option>
              {people
                .filter((p) => p.id !== ctx.viewer.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          {labels.length ? (
            <label className="block">
              <span className="label">Label</span>
              <select name="label" defaultValue={label ?? ""} className="input">
                <option value="">Any</option>
                {labels.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="block">
            <span className="label">Priority</span>
            <select name="priority" defaultValue={priority ?? ""} className="input">
              <option value="">Any</option>
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Sort by</span>
            <select name="sort" defaultValue={sort} className="input">
              <option value="due">Due date</option>
              <option value="priority">Priority</option>
            </select>
          </label>
          <button className="btn" type="submit">
            Show
          </button>
          {filtered ? (
            <Link href={`${basePath}/p/${project.id}`} className="link self-center text-sm">
              Clear
            </Link>
          ) : null}
        </form>
      ) : null}

      {tasks.length === 0 ? (
        <div className="card text-center">
          <p className="font-medium">{filtered ? "No task matches these filters." : project.isTemplate ? "This template has no steps yet." : "No open tasks in this project."}</p>
          <p className="muted">{canEdit ? "Add one above." : "When someone adds a task, it shows up here."}</p>
        </div>
      ) : (
        <TaskList tasks={tasks} today={today} basePath={basePath} canEdit={canEdit} testId="project-tasks" />
      )}
    </div>
  );
}
