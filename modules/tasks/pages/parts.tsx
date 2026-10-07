import Link from "next/link";
import { Icon } from "@/lib/icons";
import { PRIORITY_LABEL, STATUS_LABEL, type TaskPriority, type TaskStatus } from "../constants";
import type { TaskRow } from "../data";
import { describeDue, dueState } from "../logic";

export function StatusBadge({ status }: { status: TaskStatus }) {
  const cls = status === "done" ? "badge badge-ok" : status === "doing" ? "badge badge-accent" : status === "waiting" ? "badge badge-warn" : "badge";
  return <span className={cls}>{STATUS_LABEL[status]}</span>;
}

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  if (priority === "normal") return null;
  const cls = priority === "urgent" ? "badge badge-danger" : priority === "high" ? "badge badge-warn" : "badge";
  return <span className={cls}>{PRIORITY_LABEL[priority]}</span>;
}

export function DueText({ dueOn, today, done }: { dueOn: string | null; today: string; done?: boolean }) {
  if (!dueOn) return null;
  const state = dueState(dueOn, today, done);
  const cls = state === "overdue" ? "text-danger font-medium" : state === "today" ? "text-warn font-medium" : "text-subtle";
  return <span className={`text-xs ${cls}`}>{done ? `Due ${dueOn}` : describeDue(dueOn, today)}</span>;
}

export function LabelList({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {labels.map((l) => (
        <span key={l} className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">
          {l}
        </span>
      ))}
    </span>
  );
}

export function TaskMeta({ task, today, showProject = false }: { task: TaskRow; today: string; showProject?: boolean }) {
  const done = task.status === "done";
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
      {showProject ? <span>{task.projectName}</span> : null}
      {task.isTemplate ? (task.dueOffsetDays !== null ? <span>Day {task.dueOffsetDays} after start</span> : null) : <DueText dueOn={task.dueOn} today={today} done={done} />}
      {task.assignees.length ? <span>{task.assignees.map((a) => a.name).join(", ")}</span> : null}
      {task.checklistTotal ? (
        <span>
          <Icon name="check" className="inline size-3" /> {task.checklistDone}/{task.checklistTotal}
        </span>
      ) : null}
      {task.comments ? (
        <span>
          <Icon name="chat" className="inline size-3" /> {task.comments}
        </span>
      ) : null}
      {task.recurrence !== "none" ? <span>Repeats</span> : null}
    </span>
  );
}

const TABS = [
  { key: "list", label: "List", suffix: "" },
  { key: "board", label: "Board", suffix: "/board" },
  { key: "calendar", label: "Calendar", suffix: "/calendar" },
  { key: "settings", label: "Settings", suffix: "/settings" },
] as const;

/** The project's name and its view tabs. Templates have only a list (and settings). */
export function ProjectHeader({
  basePath,
  project,
  active,
  canManage,
}: {
  basePath: string;
  project: { id: string; name: string; description: string; isTemplate: boolean; archived: boolean; visibility: string };
  active: (typeof TABS)[number]["key"];
  canManage: boolean;
}) {
  const tabs = TABS.filter((t) => (t.key === "settings" ? canManage : !project.isTemplate || t.key === "list"));
  return (
    <header className="space-y-3">
      <Link href={project.isTemplate ? `${basePath}/templates` : `${basePath}/projects`} className="link text-sm">
        ← {project.isTemplate ? "Templates" : "Projects"}
      </Link>
      <div className="flex flex-wrap items-baseline gap-2">
        <h1 className="h1">{project.name}</h1>
        {project.isTemplate ? <span className="badge">Template</span> : null}
        {project.archived ? <span className="badge badge-warn">Archived</span> : null}
        {project.visibility === "private" ? <span className="badge">Private</span> : null}
      </div>
      {project.description ? <p className="muted max-w-3xl whitespace-pre-line">{project.description}</p> : null}
      <nav className="flex gap-1 overflow-x-auto border-b border-line" aria-label="Project views">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`${basePath}/p/${project.id}${t.suffix}`}
            aria-current={active === t.key ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap ${active === t.key ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

export function NotFoundCard({ what, basePath }: { what: string; basePath: string }) {
  return (
    <div className="card max-w-xl space-y-2">
      <h1 className="h1">{what} not found</h1>
      <p className="muted">It may have been deleted, or it is in a project you are not a member of. Ask the person who manages it to add you.</p>
      <Link href={basePath} className="link">
        Back to My tasks
      </Link>
    </div>
  );
}
