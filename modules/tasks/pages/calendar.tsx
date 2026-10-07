import Link from "next/link";
import { redirect } from "next/navigation";
import type { ModulePageProps } from "@/lib/modules/contract";
import { P } from "../constants";
import { getProject, listTasks, type TaskRow } from "../data";
import { isMonth, monthGrid, monthOf, monthTitle, shiftMonth, todayIn } from "../logic";
import { idSchema } from "../schemas";
import { NotFoundCard, ProjectHeader } from "./parts";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** A month of tasks by due date: a grid on wide screens, a day-by-day list on a phone. */
function MonthView({ tasks, month, today, basePath, here, extraQuery = "" }: { tasks: TaskRow[]; month: string; today: string; basePath: string; here: string; extraQuery?: string }) {
  const weeks = monthGrid(month);
  const byDay = new Map<string, TaskRow[]>();
  for (const t of tasks) if (t.dueOn) byDay.set(t.dueOn, [...(byDay.get(t.dueOn) ?? []), t]);
  const chip = (t: TaskRow) => {
    const late = t.status !== "done" && t.dueOn! < today;
    return (
      <Link
        key={t.id}
        href={`${basePath}/t/${t.id}`}
        title={`${t.title} · ${t.projectName}`}
        className={`block truncate rounded px-1.5 py-0.5 text-xs ${t.status === "done" ? "bg-surface-2 text-muted line-through" : late ? "bg-danger/10 text-danger" : t.priority === "urgent" || t.priority === "high" ? "bg-warn/10 text-fg" : "bg-accent-soft text-fg"}`}
      >
        {t.title}
      </Link>
    );
  };
  const q = (m: string) => `${here}?month=${m}${extraQuery}`;
  const daysWithTasks = weeks.flat().filter((d) => monthOf(d) === month && byDay.has(d));
  return (
    <section className="space-y-3" aria-label={monthTitle(month)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="h2">{monthTitle(month)}</h2>
        <div className="flex gap-2">
          <Link className="btn" href={q(shiftMonth(month, -1))} aria-label="Previous month">
            ←
          </Link>
          <Link className="btn" href={q(monthOf(today))}>
            Today
          </Link>
          <Link className="btn" href={q(shiftMonth(month, 1))} aria-label="Next month">
            →
          </Link>
        </div>
      </div>
      <div className="hidden overflow-hidden rounded-lg border border-line md:block" data-testid="calendar-grid">
        <div className="grid grid-cols-7 border-b border-line bg-surface-2 text-xs font-medium text-muted">
          {WEEKDAYS.map((d) => (
            <div key={d} className="px-2 py-1.5">
              {d}
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} className="grid grid-cols-7 border-b border-line last:border-b-0">
            {week.map((day) => {
              const inMonth = monthOf(day) === month;
              const list = byDay.get(day) ?? [];
              return (
                <div key={day} data-date={day} className={`min-h-24 space-y-1 border-r border-line p-1.5 last:border-r-0 ${inMonth ? "bg-surface" : "bg-surface-2"}`}>
                  <div className={`text-xs ${day === today ? "inline-block rounded-full bg-accent px-1.5 font-semibold text-white" : inMonth ? "text-muted" : "text-subtle"}`}>{Number(day.slice(8))}</div>
                  {list.slice(0, 4).map(chip)}
                  {list.length > 4 ? <p className="text-xs text-subtle">and {list.length - 4} more</p> : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="space-y-3 md:hidden" data-testid="calendar-agenda">
        {daysWithTasks.length === 0 ? <p className="muted">Nothing is due this month.</p> : null}
        {daysWithTasks.map((day) => (
          <div key={day} className="space-y-1">
            <h3 className={`text-sm font-semibold ${day === today ? "text-accent" : ""}`}>
              {new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`))}
              {day === today ? " · Today" : ""}
            </h3>
            <div className="space-y-1">{(byDay.get(day) ?? []).map(chip)}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function monthRange(month: string): { from: string; to: string } {
  const weeks = monthGrid(month);
  return { from: weeks[0][0], to: weeks[weeks.length - 1][6] };
}

/** "Calendar" in the menu: the viewer's tasks, or everyone's they can see. */
export async function CalendarPage({ ctx, basePath, searchParams }: ModulePageProps) {
  const today = todayIn(ctx.business.timezone);
  const m = one(searchParams.month);
  const month = isMonth(m) ? m : monthOf(today);
  const everyone = one(searchParams.who) === "all";
  const { from, to } = monthRange(month);
  const tasks = await listTasks(ctx, { assigneeId: everyone ? undefined : ctx.viewer.id, dueFrom: from, dueTo: to, includeDone: true, limit: 1000 });
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="h1">Calendar</h1>
          <p className="muted">{everyone ? "Every task with a due date in the projects you can see." : "Your tasks, by due date."}</p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Whose tasks">
          <Link href={`${basePath}/calendar?month=${month}`} className={`btn ${everyone ? "" : "btn-primary"}`} aria-current={!everyone ? "page" : undefined}>
            Mine
          </Link>
          <Link href={`${basePath}/calendar?month=${month}&who=all`} className={`btn ${everyone ? "btn-primary" : ""}`} aria-current={everyone ? "page" : undefined}>
            Everyone’s
          </Link>
        </div>
      </header>
      <MonthView tasks={tasks} month={month} today={today} basePath={basePath} here={`${basePath}/calendar`} extraQuery={everyone ? "&who=all" : ""} />
    </div>
  );
}

export async function ProjectCalendarPage({ ctx, params, basePath, searchParams }: ModulePageProps) {
  const id = idSchema.safeParse(params.projectId);
  const project = id.success ? await getProject(ctx, id.data) : null;
  if (!project) return <NotFoundCard what="Project" basePath={basePath} />;
  if (project.isTemplate) redirect(`${basePath}/p/${project.id}`);
  const today = todayIn(ctx.business.timezone);
  const m = one(searchParams.month);
  const month = isMonth(m) ? m : monthOf(today);
  const { from, to } = monthRange(month);
  const tasks = await listTasks(ctx, { projectId: project.id, dueFrom: from, dueTo: to, includeDone: true, limit: 1000 });
  return (
    <div className="space-y-6">
      <ProjectHeader basePath={basePath} project={project} active="calendar" canManage={ctx.can(P.manage)} />
      <MonthView tasks={tasks} month={month} today={today} basePath={basePath} here={`${basePath}/p/${project.id}/calendar`} />
    </div>
  );
}
