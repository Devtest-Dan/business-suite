import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import type { ModulePageProps } from "@/lib/modules/contract";
import { quickAddTask } from "../actions";
import { P } from "../constants";
import { listProjects, listTasks, type TaskRow } from "../data";
import { addDays, todayIn } from "../logic";
import { TaskList } from "./task-list";

/** Everything assigned to the viewer, across projects, grouped by when it is due. */
export async function MyTasksPage({ ctx, basePath, searchParams }: ModulePageProps) {
  const showDone = searchParams.done === "1";
  const today = todayIn(ctx.business.timezone);
  const [open, projects, done] = await Promise.all([
    listTasks(ctx, { assigneeId: ctx.viewer.id, limit: 500 }),
    listProjects(ctx),
    showDone ? listTasks(ctx, { assigneeId: ctx.viewer.id, statuses: ["done"], sort: "recent", limit: 30 }) : Promise.resolve([] as TaskRow[]),
  ]);
  const week = addDays(today, 7);
  const groups: { title: string; key: string; tasks: TaskRow[] }[] = [
    { title: "Overdue", key: "overdue", tasks: open.filter((t) => t.dueOn && t.dueOn < today) },
    { title: "Today", key: "today", tasks: open.filter((t) => t.dueOn === today) },
    { title: "Next 7 days", key: "week", tasks: open.filter((t) => t.dueOn && t.dueOn > today && t.dueOn <= week) },
    { title: "Later", key: "later", tasks: open.filter((t) => t.dueOn && t.dueOn > week) },
    { title: "No due date", key: "none", tasks: open.filter((t) => !t.dueOn) },
  ];
  const canEdit = ctx.can(P.edit);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="h1">My tasks</h1>
          <p className="muted">Everything assigned to you, in every project you are part of.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`${basePath}/calendar`} className="btn">
            Calendar
          </Link>
          <Link href={`${basePath}/projects`} className="btn">
            Projects
          </Link>
        </div>
      </header>

      {canEdit && projects.length ? (
        <ActionForm action={quickAddTask} submit="Add task" className="card grid gap-3 sm:grid-cols-[1fr_12rem_10rem_auto] sm:items-end" submitClassName="btn btn-primary" resetOnSuccess>
          <label className="block">
            <span className="label">New task for me</span>
            <input name="title" required maxLength={200} className="input" placeholder="What needs doing?" />
          </label>
          <label className="block">
            <span className="label">Project</span>
            <select name="projectId" className="input" defaultValue={projects[0].id}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Due</span>
            <input type="date" name="dueOn" className="input" />
          </label>
          <input type="hidden" name="assigneeId" value={ctx.viewer.id} />
        </ActionForm>
      ) : null}

      {open.length === 0 ? (
        <div className="card text-center">
          <p className="font-medium">Nothing is assigned to you right now.</p>
          <p className="muted">
            {projects.length ? "Open a project to see the team's tasks, or add one for yourself above." : "When someone gives you a task, it shows up here."}
          </p>
        </div>
      ) : (
        groups
          .filter((g) => g.tasks.length)
          .map((g) => (
            <section key={g.key} className="space-y-2" aria-labelledby={`group-${g.key}`}>
              <h2 id={`group-${g.key}`} className={`h2 ${g.key === "overdue" ? "text-danger" : ""}`}>
                {g.title} <span className="text-sm font-normal text-subtle">({g.tasks.length})</span>
              </h2>
              <TaskList tasks={g.tasks} today={today} basePath={basePath} canEdit={canEdit} showProject testId={`my-tasks-${g.key}`} />
            </section>
          ))
      )}

      <section className="space-y-2">
        {showDone ? (
          <>
            <h2 className="h2">Recently done</h2>
            {done.length ? <TaskList tasks={done} today={today} basePath={basePath} canEdit={canEdit} showProject testId="my-tasks-done" /> : <p className="muted">Nothing done yet.</p>}
            <Link href={basePath} className="link text-sm">
              Hide done tasks
            </Link>
          </>
        ) : (
          <Link href={`${basePath}?done=1`} className="link text-sm">
            Show recently done tasks
          </Link>
        )}
      </section>
    </div>
  );
}
