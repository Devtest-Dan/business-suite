import "server-only";
import type { WriteAction } from "@/lib/modules/contract";
import { enabledModules, findModule } from "@/lib/modules/registry-access";

/**
 * The link to the Tasks app, used only through its registered write action
 * (never its internals), and only when that app is installed and switched on.
 * A follow-up becomes a task there; without it, the follow-up is a reminder
 * in this app.
 *
 * The Tasks app is built separately, so the exact shape of its "create a
 * task" input is not known here: we offer the task in a few common shapes
 * and use the first one its schema accepts. If none fits, the follow-up
 * stays a reminder here (nothing is lost).
 */

export const TASKS_MODULE = "tasks";
const ACTION_NAMES = ["create_task", "add_task", "create_tasks", "create"];

export interface TaskDraft {
  title: string;
  notes: string;
  dueOn: string;
  assigneeId: string | null;
  assigneeEmail: string;
  /** Who the task is about, and where to find them in this app. */
  about: string;
  url: string;
}

export interface TasksLink {
  fullName: string;
  action: WriteAction<unknown>;
}

function findTaskAction(): TasksLink | null {
  const mod = findModule(TASKS_MODULE);
  for (const name of ACTION_NAMES) {
    const action = mod?.actions?.find((a) => a.name === name) as WriteAction<unknown> | undefined;
    if (action) return { fullName: `${TASKS_MODULE}.${name}`, action };
  }
  return null;
}

/** True when this build includes a Tasks app with a create action (it may still be switched off). */
export function tasksInstalled(): boolean {
  return findTaskAction() !== null;
}

/** The Tasks app's create action, when it is installed and switched on. */
export async function tasksLink(): Promise<TasksLink | null> {
  const link = findTaskAction();
  if (!link) return null;
  const on = (await enabledModules()).some((m) => m.id === TASKS_MODULE);
  return on ? link : null;
}

/** The project Customers files its follow-ups in (made on first use). */
export const FOLLOW_UP_PROJECT = "Customer follow-ups";

/** The candidate shapes of one task, richest first. The first is tasks.create_task's own input. */
export function taskShapes(d: TaskDraft): Record<string, unknown>[] {
  const own: Record<string, unknown> = {
    project: FOLLOW_UP_PROJECT,
    createProjectIfMissing: true,
    title: d.title,
    description: [d.notes.trim(), `Customer: ${d.about}`].filter(Boolean).join("\n\n"),
    dueOn: d.dueOn || null,
    assignees: d.assigneeEmail ? [d.assigneeEmail] : [],
    sourceLabel: `From Customers: ${d.about}`.slice(0, 200),
    ...(d.url.startsWith("/") ? { sourceUrl: d.url } : {}),
  };
  return [own, ...legacyShapes(d)];
}

function legacyShapes(d: TaskDraft): Record<string, unknown>[] {
  const description = [d.notes.trim(), `Customer: ${d.about} (${d.url})`].filter(Boolean).join("\n\n");
  const text = { title: d.title, description, notes: description, detail: description, body: description };
  const due = { dueDate: d.dueOn, dueOn: d.dueOn, due: d.dueOn };
  const who = d.assigneeId ? { assigneeIds: [d.assigneeId], assigneeId: d.assigneeId, assigneeEmail: d.assigneeEmail, assigneeEmails: [d.assigneeEmail] } : {};
  return [
    { ...text, ...due, ...who },
    { ...text, ...due },
    { title: d.title, description, dueDate: d.dueOn },
    { title: d.title, dueDate: d.dueOn },
    { title: d.title, description },
  ];
}

/** The first shape the Tasks action accepts (raw, as propose() expects), or null. */
export function taskInputFor(link: TasksLink, draft: TaskDraft): Record<string, unknown> | null {
  for (const shape of taskShapes(draft)) if (link.action.input.safeParse(shape).success) return shape;
  return null;
}
