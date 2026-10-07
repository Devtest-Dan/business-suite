import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { formatDateTime } from "@/lib/format";
import { Icon } from "@/lib/icons";
import type { ModulePageProps } from "@/lib/modules/contract";
import {
  attachAction,
  checklistAddAction,
  checklistDeleteAction,
  checklistToggleAction,
  commentAction,
  deleteTaskAction,
  removeAttachmentAction,
  saveTaskAction,
  setStatusAction,
  watchAction,
} from "../actions";
import { P, PRIORITY_LABEL, RECURRENCE_LABEL, STATUS_LABEL, TASK_PRIORITIES, TASK_RECURRENCES, TASK_STATUSES } from "../constants";
import { getTask, projectAudience } from "../data";
import { todayIn } from "../logic";
import { idSchema } from "../schemas";
import { DueText, LabelList, NotFoundCard, PriorityBadge } from "./parts";

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function TaskPage({ ctx, params, basePath }: ModulePageProps) {
  const id = idSchema.safeParse(params.taskId);
  const detail = id.success ? await getTask(ctx, id.data) : null;
  if (!detail) return <NotFoundCard what="Task" basePath={basePath} />;
  const { task, project } = detail;
  const tz = ctx.business.timezone;
  const today = todayIn(tz);
  const canEdit = ctx.can(P.edit) && !project.archived;
  const canComment = ctx.can(P.comment) && !project.archived;
  const people = canEdit ? await projectAudience(project.id) : [];
  const assigned = new Set(detail.assignees.map((a) => a.id));

  return (
    <article className="space-y-6">
      <header className="space-y-2">
        <Link href={`${basePath}/p/${project.id}${project.isTemplate ? "" : "/board"}`} className="link text-sm">
          ← {project.name}
        </Link>
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className={`h1 ${task.status === "done" ? "text-muted line-through" : ""}`} data-testid="task-title">
            {task.title}
          </h1>
          <PriorityBadge priority={task.priority} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-subtle">
          {project.isTemplate ? (
            <span>{task.dueOffsetDays === null ? "No set day" : `Day ${task.dueOffsetDays} after start`}</span>
          ) : task.dueOn ? (
            <DueText dueOn={task.dueOn} today={today} done={task.status === "done"} />
          ) : (
            <span>No due date</span>
          )}
          {task.recurrence !== "none" ? <span>{RECURRENCE_LABEL[task.recurrence]}</span> : null}
          <span>
            Added by {task.createdByName || "someone"} · {formatDateTime(task.createdAt, tz)}
          </span>
          {task.sourceLabel ? (
            task.sourceUrl ? (
              <Link href={task.sourceUrl} className="link">
                {task.sourceLabel}
              </Link>
            ) : (
              <span>{task.sourceLabel}</span>
            )
          ) : null}
        </div>
        <LabelList labels={task.labels} />
        {detail.repeatedAs ? (
          <p className="notice notice-ok text-sm">
            It repeats: the next copy is{" "}
            <Link className="link" href={`${basePath}/t/${detail.repeatedAs.id}`}>
              due {detail.repeatedAs.dueOn ?? "with no date"}
            </Link>
            .
          </p>
        ) : null}
      </header>

      {!project.isTemplate ? (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Status" data-testid="status-buttons">
          {TASK_STATUSES.map((s) =>
            canEdit && s !== task.status ? (
              <form key={s} action={setStatusAction.bind(null, task.id, s)}>
                <button type="submit" className="btn">
                  {s === "done" ? <Icon name="check" className="size-4" /> : null} {STATUS_LABEL[s]}
                </button>
              </form>
            ) : (
              <span key={s} className={`btn ${s === task.status ? "btn-primary" : "opacity-50"}`} aria-current={s === task.status ? "true" : undefined}>
                {STATUS_LABEL[s]}
              </span>
            ),
          )}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <section className="card space-y-2" aria-labelledby="desc">
            <h2 id="desc" className="h2">
              Description
            </h2>
            {task.description ? <p className="whitespace-pre-line leading-relaxed">{task.description}</p> : <p className="muted">No description.</p>}
          </section>

          <section className="card space-y-3" aria-labelledby="checklist">
            <h2 id="checklist" className="h2">
              Checklist{" "}
              {detail.checklist.length ? (
                <span className="text-sm font-normal text-subtle">
                  {detail.checklist.filter((c) => c.done).length}/{detail.checklist.length}
                </span>
              ) : null}
            </h2>
            {detail.checklist.length ? (
              <ul className="space-y-1" data-testid="checklist">
                {detail.checklist.map((item) => (
                  <li key={item.id} className="flex items-center gap-2">
                    {canEdit ? (
                      <form action={checklistToggleAction.bind(null, item.id, !item.done)} className="contents">
                        <button type="submit" className={`grid size-5 place-items-center rounded border ${item.done ? "border-ok bg-ok text-white" : "border-line"}`} aria-label={`${item.done ? "Untick" : "Tick"}: ${item.text}`}>
                          {item.done ? <Icon name="check" className="size-3" /> : null}
                        </button>
                      </form>
                    ) : (
                      <span className={`grid size-5 place-items-center rounded border ${item.done ? "border-ok bg-ok text-white" : "border-line"}`}>{item.done ? <Icon name="check" className="size-3" /> : null}</span>
                    )}
                    <span className={`flex-1 ${item.done ? "text-muted line-through" : ""}`}>{item.text}</span>
                    {canEdit ? (
                      <form action={checklistDeleteAction.bind(null, item.id)}>
                        <button type="submit" className="text-subtle hover:text-danger" aria-label={`Remove: ${item.text}`}>
                          <Icon name="x" className="size-4" />
                        </button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted text-sm">No checklist.</p>
            )}
            {canEdit ? (
              <ActionForm action={checklistAddAction} submit="Add" className="flex flex-wrap items-end gap-2" submitClassName="btn" resetOnSuccess>
                <input type="hidden" name="taskId" value={task.id} />
                <label className="block min-w-0 flex-1">
                  <span className="sr-only">New checklist item</span>
                  <input name="text" required maxLength={300} className="input" placeholder="Add a checklist item" />
                </label>
              </ActionForm>
            ) : null}
          </section>

          <section className="card space-y-3" aria-labelledby="files">
            <h2 id="files" className="h2">
              Attachments
            </h2>
            {detail.attachments.length ? (
              <ul className="space-y-1 text-sm" data-testid="attachments">
                {detail.attachments.map((a) => (
                  <li key={a.fileId} className="flex items-center gap-2">
                    <Icon name="file" className="size-4 shrink-0 text-subtle" />
                    <a href={`/api/files/${a.fileId}`} className="link min-w-0 flex-1 truncate" target="_blank" rel="noopener">
                      {a.name}
                    </a>
                    <span className="text-xs text-subtle">{size(a.size)}</span>
                    {canEdit ? (
                      <form action={removeAttachmentAction.bind(null, task.id, a.fileId)}>
                        <button type="submit" className="text-subtle hover:text-danger" aria-label={`Remove attachment ${a.name}`}>
                          <Icon name="x" className="size-4" />
                        </button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted text-sm">No files attached.</p>
            )}
            {canEdit ? (
              <ActionForm action={attachAction} submit="Attach" className="flex flex-wrap items-center gap-2" submitClassName="btn" resetOnSuccess>
                <input type="hidden" name="taskId" value={task.id} />
                <label className="block">
                  <span className="sr-only">File to attach (up to 10 MB)</span>
                  <input type="file" name="file" required className="block text-sm" />
                </label>
              </ActionForm>
            ) : null}
          </section>

          <section className="card space-y-3" aria-labelledby="comments">
            <h2 id="comments" className="h2">
              Comments
            </h2>
            {detail.comments.length ? (
              <ul className="space-y-3" data-testid="comments">
                {detail.comments.map((c) => (
                  <li key={c.id} className="space-y-0.5">
                    <p className="text-xs text-subtle">
                      <span className="font-medium text-fg">{c.authorName}</span> · {formatDateTime(c.createdAt, tz)}
                    </p>
                    <p className="whitespace-pre-line">{c.body}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted text-sm">No comments yet.</p>
            )}
            {canComment ? (
              <ActionForm action={commentAction} submit="Comment" className="space-y-2" submitClassName="btn btn-primary" resetOnSuccess>
                <input type="hidden" name="taskId" value={task.id} />
                <label className="block">
                  <span className="label">Add a comment</span>
                  <textarea name="body" required rows={3} maxLength={5000} className="input" />
                  <span className="hint">Type @ and a person’s name (for example @{ctx.viewer.name.split(" ")[0]}) to notify them. Watchers are told about every comment.</span>
                </label>
              </ActionForm>
            ) : null}
          </section>
        </div>

        <aside className="min-w-0 space-y-6">
          <section className="card space-y-2" aria-labelledby="people">
            <h2 id="people" className="h2">
              People
            </h2>
            <p className="text-sm">
              <span className="text-subtle">Assigned: </span>
              {detail.assignees.length ? detail.assignees.map((a) => a.name).join(", ") : "no one yet"}
            </p>
            <p className="text-sm">
              <span className="text-subtle">Watching: </span>
              {detail.watchers.length ? detail.watchers.map((w) => w.name).join(", ") : "no one"}
            </p>
            <form action={watchAction.bind(null, task.id, !detail.watching)}>
              <button type="submit" className="btn">
                <Icon name="eye" className="size-4" /> {detail.watching ? "Stop watching" : "Watch"}
              </button>
            </form>
          </section>

          {canEdit ? (
            <details className="card" open={false}>
              <summary className="cursor-pointer font-semibold">Edit task</summary>
              <ActionForm action={saveTaskAction} submit="Save changes" className="mt-3 space-y-3">
                <input type="hidden" name="taskId" value={task.id} />
                <label className="block">
                  <span className="label">Title</span>
                  <input name="title" required maxLength={200} defaultValue={task.title} className="input" />
                </label>
                <label className="block">
                  <span className="label">Description</span>
                  <textarea name="description" rows={5} maxLength={10000} defaultValue={task.description} className="input" />
                </label>
                {project.isTemplate ? (
                  <label className="block">
                    <span className="label">Days after start</span>
                    <input type="number" name="dueOffsetDays" min={0} max={3650} defaultValue={task.dueOffsetDays ?? ""} className="input" />
                  </label>
                ) : (
                  <label className="block">
                    <span className="label">Due date</span>
                    <input type="date" name="dueOn" defaultValue={task.dueOn ?? ""} className="input" />
                  </label>
                )}
                <label className="block">
                  <span className="label">Priority</span>
                  <select name="priority" defaultValue={task.priority} className="input">
                    {TASK_PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {PRIORITY_LABEL[p]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="label">Repeats</span>
                  <select name="recurrence" defaultValue={task.recurrence} className="input">
                    {TASK_RECURRENCES.map((r) => (
                      <option key={r} value={r}>
                        {RECURRENCE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                  <span className="hint">When a repeating task is done, its next copy is made with the next due date.</span>
                </label>
                <label className="block">
                  <span className="label">Labels</span>
                  <input name="labels" defaultValue={task.labels.join(", ")} className="input" placeholder="Separate with commas" />
                </label>
                <fieldset className="space-y-1">
                  <legend className="label">Assigned to</legend>
                  {people.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="assigneeIds" value={p.id} defaultChecked={assigned.has(p.id)} className="size-4" />
                      <span>{p.name}</span>
                    </label>
                  ))}
                </fieldset>
              </ActionForm>
            </details>
          ) : null}

          <section className="card space-y-2" aria-labelledby="history">
            <h2 id="history" className="h2">
              History
            </h2>
            <ul className="space-y-2 text-sm" data-testid="task-history">
              {detail.activity.map((a) => (
                <li key={a.id}>
                  <span className="font-medium">{a.actorName}</span> {a.summary}
                  <span className="block text-xs text-subtle">{formatDateTime(a.createdAt, tz)}</span>
                </li>
              ))}
            </ul>
          </section>

          {canEdit ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-danger">Delete this task…</summary>
              <form action={deleteTaskAction.bind(null, task.id)} className="mt-2 space-y-2">
                <p className="hint">This removes the task, its comments, checklist and files for good.</p>
                <button type="submit" className="btn btn-danger">
                  Yes, delete it
                </button>
              </form>
            </details>
          ) : null}
        </aside>
      </div>
    </article>
  );
}
