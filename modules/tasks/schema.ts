/**
 * Tasks' own tables. Every table and enum name starts with "tasks_".
 * Imports are relative so drizzle-kit can load this file on its own.
 * After changing it: pnpm suite:db:generate tasks <short-name>
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { files, users } from "../../lib/db/schema";
import { tsvector } from "../../lib/db/types";
import { PROJECT_VISIBILITIES, REMINDER_KINDS, TASK_PRIORITIES, TASK_RECURRENCES, TASK_STATUSES } from "./constants";

// ── Enums (built from the lists in constants.ts, which the browser also uses) ──

export const taskStatusEnum = pgEnum("tasks_status", TASK_STATUSES);
export const taskPriorityEnum = pgEnum("tasks_priority", TASK_PRIORITIES);
export const taskRecurrenceEnum = pgEnum("tasks_recurrence", TASK_RECURRENCES);
export const projectVisibilityEnum = pgEnum("tasks_project_visibility", PROJECT_VISIBILITIES);
export const reminderKindEnum = pgEnum("tasks_reminder_kind", REMINDER_KINDS);

// ── Projects (a template is a project with is_template = true) ───────────────

export const taskProjects = pgTable(
  "tasks_projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    // "team": everyone except guests can see it; "private": only its members (and task managers).
    visibility: projectVisibilityEnum("visibility").notNull().default("team"),
    isTemplate: boolean("is_template").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    search: tsvector("search").generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce("name", '')), 'A') || setweight(to_tsvector('simple', coalesce("description", '')), 'B')`,
    ),
  },
  (t) => [index("tasks_projects_search_idx").using("gin", t.search), index("tasks_projects_list_idx").on(t.isTemplate, t.archived, t.name)],
);

export const taskProjectMembers = pgTable(
  "tasks_project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => taskProjects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] }), index("tasks_project_members_user_idx").on(t.userId)],
);

// ── Tasks ────────────────────────────────────────────────────────────────────

export const tasks = pgTable(
  "tasks_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => taskProjects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: taskStatusEnum("status").notNull().default("todo"),
    priority: taskPriorityEnum("priority").notNull().default("normal"),
    dueOn: date("due_on", { mode: "string" }),
    // Only in templates: the due date is this many days after the project's start.
    dueOffsetDays: integer("due_offset_days"),
    labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
    // Order inside a board column (smaller first).
    position: doublePrecision("position").notNull().default(0),
    recurrence: taskRecurrenceEnum("recurrence").notNull().default("none"),
    // The task this one was repeated from. Unique: a task is repeated at most once.
    recurrenceOf: uuid("recurrence_of").references((): AnyPgColumn => tasks.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Where it came from, for people ("Imported: Proposal: Quote drafts") and a link back (a suite path).
    sourceLabel: text("source_label"),
    sourceUrl: text("source_url"),
    // An id in another system (the AHL Tasks export's externalId). Unique: importing again updates, never duplicates.
    externalId: text("external_id"),
    externalUpdatedAt: timestamp("external_updated_at", { withTimezone: true }),
    // Set when the task came from an approval (the ledger key): a second guard against duplicates.
    sourceKey: text("source_key").unique(),
    search: tsvector("search").generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce("title", '')), 'A') || setweight(to_tsvector('simple', coalesce("description", '')), 'B')`,
    ),
  },
  (t) => [
    index("tasks_tasks_search_idx").using("gin", t.search),
    index("tasks_tasks_project_idx").on(t.projectId, t.status, t.position),
    index("tasks_tasks_due_idx").on(t.dueOn),
    uniqueIndex("tasks_tasks_recurrence_of_idx").on(t.recurrenceOf),
    uniqueIndex("tasks_tasks_external_idx").on(t.externalId),
  ],
);

export const taskAssignees = pgTable(
  "tasks_assignees",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.userId] }), index("tasks_assignees_user_idx").on(t.userId)],
);

export const taskWatchers = pgTable(
  "tasks_watchers",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.userId] })],
);

export const taskChecklistItems = pgTable(
  "tasks_checklist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    done: boolean("done").notNull().default(false),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("tasks_checklist_task_idx").on(t.taskId, t.position)],
);

export const taskComments = pgTable(
  "tasks_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tasks_comments_task_idx").on(t.taskId, t.createdAt)],
);

export const taskAttachments = pgTable(
  "tasks_attachments",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.fileId] })],
);

/** What happened to a task, newest last. Written by the app only; never edited. */
export const taskActivity = pgTable(
  "tasks_activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorName: text("actor_name").notNull(),
    summary: text("summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tasks_activity_task_idx").on(t.taskId, t.createdAt)],
);

/** One row per reminder sent, so each is sent once even when many pages trigger the check. */
export const taskReminders = pgTable(
  "tasks_reminders",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    kind: reminderKindEnum("kind").notNull(),
    // The due date the reminder was about: moving the due date allows a new reminder.
    dueOn: date("due_on", { mode: "string" }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.kind, t.dueOn] })],
);
