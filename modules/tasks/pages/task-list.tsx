import Link from "next/link";
import { Icon } from "@/lib/icons";
import { setStatusAction } from "../actions";
import type { TaskRow } from "../data";
import { LabelList, PriorityBadge, StatusBadge, TaskMeta } from "./parts";

/** A tick button: marks a task done (or back to "To do" when it is done). */
export function DoneButton({ task, canEdit }: { task: Pick<TaskRow, "id" | "title" | "status">; canEdit: boolean }) {
  const done = task.status === "done";
  const box = (
    <span
      className={`grid size-5 shrink-0 place-items-center rounded-full border ${done ? "border-ok bg-ok text-white" : "border-line bg-surface"}`}
      aria-hidden="true"
    >
      {done ? <Icon name="check" className="size-3" /> : null}
    </span>
  );
  if (!canEdit) return box;
  return (
    <form action={setStatusAction.bind(null, task.id, done ? "todo" : "done")} className="contents">
      <button type="submit" className="mt-0.5 rounded-full" title={done ? "Mark as not done" : "Mark as done"} aria-label={`${done ? "Mark as not done" : "Mark as done"}: ${task.title}`}>
        {box}
      </button>
    </form>
  );
}

export function TaskList({
  tasks,
  today,
  basePath,
  canEdit,
  showProject = false,
  testId,
}: {
  tasks: TaskRow[];
  today: string;
  basePath: string;
  canEdit: boolean;
  showProject?: boolean;
  testId?: string;
}) {
  return (
    <ul className="divide-y divide-line rounded-lg border border-line bg-surface" data-testid={testId}>
      {tasks.map((t) => (
        <li key={t.id} className="flex items-start gap-3 px-3 py-2.5">
          {t.isTemplate ? <span className="mt-0.5 size-5 shrink-0" /> : <DoneButton task={t} canEdit={canEdit} />}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`${basePath}/t/${t.id}`} className={`font-medium hover:underline ${t.status === "done" ? "text-muted line-through" : ""}`}>
                {t.title}
              </Link>
              {t.status !== "todo" && t.status !== "done" ? <StatusBadge status={t.status} /> : null}
              <PriorityBadge priority={t.priority} />
            </div>
            <TaskMeta task={t} today={today} showProject={showProject} />
            <LabelList labels={t.labels} />
          </div>
        </li>
      ))}
    </ul>
  );
}
