/**
 * Names and value lists shared by the schema, the server and the browser.
 * The Postgres enums in schema.ts are built from these lists, so the
 * TypeScript unions and the database can never disagree.
 */

export const MODULE_ID = "tasks";

export const P = {
  access: "tasks.access",
  comment: "tasks.comment",
  edit: "tasks.edit",
  manage: "tasks.manage",
  import: "tasks.import",
} as const;

export const TASK_STATUSES = ["todo", "doing", "waiting", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const STATUS_LABEL: Record<TaskStatus, string> = { todo: "To do", doing: "Doing", waiting: "Waiting", done: "Done" };

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const PRIORITY_LABEL: Record<TaskPriority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

export const TASK_RECURRENCES = ["none", "daily", "weekdays", "weekly", "monthly", "yearly"] as const;
export type TaskRecurrence = (typeof TASK_RECURRENCES)[number];
export const RECURRENCE_LABEL: Record<TaskRecurrence, string> = {
  none: "Does not repeat",
  daily: "Every day",
  weekdays: "Every weekday (Mon–Fri)",
  weekly: "Every week",
  monthly: "Every month",
  yearly: "Every year",
};

export const PROJECT_VISIBILITIES = ["team", "private"] as const;
export type ProjectVisibility = (typeof PROJECT_VISIBILITIES)[number];
export const VISIBILITY_LABEL: Record<ProjectVisibility, string> = {
  team: "Team: everyone except guests can see it",
  private: "Private: only its members can see it",
};

export const REMINDER_KINDS = ["due_today", "overdue"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

export const NOTIFY = {
  assigned: "tasks.assigned",
  mentioned: "tasks.mentioned",
  commented: "tasks.commented",
  due: "tasks.due",
  completed: "tasks.completed",
} as const;

/** The AHL "Tasks" export this module imports (docs/TASK_EXPORT_FORMAT.md in the AHL repo). */
export const AHL_FORMAT = "business-suite.tasks";
export const AHL_VERSION = 1;
