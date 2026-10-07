/**
 * Docs' own tables. Every table name starts with "docs_".
 * Imports are relative so drizzle-kit can load this file on its own.
 * After changing it: pnpm suite:db:generate docs <short-name>
 */
import { sql } from "drizzle-orm";
import { boolean, date, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, unique, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { files, users } from "../../lib/db/schema";
import { tsvector } from "../../lib/db/types";

/** One step of a procedure. `check` asks for an answer before the step counts as done. */
export interface ProcedureStep {
  text: string;
  note: string;
  check: "none" | "yesno" | "value";
  checkLabel: string;
}

/** A space: a shelf of pages with its own people. "team": every non-guest can read; "private": only its members. */
export const docsSpaces = pgTable("docs_spaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  visibility: text("visibility", { enum: ["team", "private"] }).notNull().default("team"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

/** Who belongs to a space and what they may do there. Guests see only spaces they are listed in. */
export const docsSpaceMembers = pgTable(
  "docs_space_members",
  {
    spaceId: uuid("space_id")
      .notNull()
      .references(() => docsSpaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["viewer", "editor", "manager"] }).notNull().default("viewer"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.userId] }), index("docs_space_members_user_idx").on(t.userId)],
);

export const docsPages = pgTable(
  "docs_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => docsSpaces.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => docsPages.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    kind: text("kind", { enum: ["page", "procedure"] }).notNull().default("page"),
    steps: jsonb("steps").$type<ProcedureStep[]>().notNull().default([]),
    /** For procedures: when it should be run ("none" = only when someone starts it). */
    schedule: text("schedule", { enum: ["none", "daily", "weekdays", "weekly"] }).notNull().default("none"),
    /** For "weekly": 0 = Sunday … 6 = Saturday. */
    scheduleDay: smallint("schedule_day"),
    isTemplate: boolean("is_template").notNull().default(false),
    /** Goes up by one on every saved change; an edit must name the revision it started from. */
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedByName: text("updated_by_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /** Set for pages that came from a Markdown import: the file's path, so a re-import updates instead of duplicating. */
    importPath: text("import_path"),
    /** Set when the page came from an approval (the ledger key): a second guard against duplicates. */
    sourceKey: text("source_key").unique(),
    search: tsvector("search").generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce("title", '')), 'A') || setweight(to_tsvector('simple', coalesce("body", '')), 'B') || setweight(jsonb_to_tsvector('simple', "steps", '["string"]'), 'B')`,
    ),
  },
  (t) => [
    index("docs_pages_search_idx").using("gin", t.search),
    index("docs_pages_space_parent_idx").on(t.spaceId, t.parentId),
    index("docs_pages_updated_idx").on(t.updatedAt),
    unique("docs_pages_space_import_path_unique").on(t.spaceId, t.importPath),
  ],
);

/** Every saved version of a page, for history and restore. Append-only. */
export const docsRevisions = pgTable(
  "docs_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => docsPages.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    kind: text("kind", { enum: ["page", "procedure"] }).notNull(),
    steps: jsonb("steps").$type<ProcedureStep[]>().notNull().default([]),
    note: text("note").notNull().default(""),
    editedBy: uuid("edited_by").references(() => users.id, { onDelete: "set null" }),
    editedByName: text("edited_by_name").notNull(),
    /** "user", "ai" (a drafted change someone approved), "import" or "restore". */
    via: text("via", { enum: ["user", "ai", "import", "restore"] }).notNull().default("user"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("docs_revisions_page_revision_unique").on(t.pageId, t.revision)],
);

/** Internal links between pages, rebuilt from a page's text each time it is saved (for backlinks). */
export const docsLinks = pgTable(
  "docs_links",
  {
    fromPageId: uuid("from_page_id")
      .notNull()
      .references(() => docsPages.id, { onDelete: "cascade" }),
    toPageId: uuid("to_page_id")
      .notNull()
      .references(() => docsPages.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.fromPageId, t.toPageId] }), index("docs_links_to_idx").on(t.toPageId)],
);

export const docsAttachments = pgTable(
  "docs_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => docsPages.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("docs_attachments_page_idx").on(t.pageId), unique("docs_attachments_page_file_unique").on(t.pageId, t.fileId)],
);

/** One run of a procedure: a checklist copied from the procedure when it started. */
export const docsRuns = pgTable(
  "docs_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => docsPages.id, { onDelete: "cascade" }),
    /** The procedure's revision the steps were copied from. */
    revision: integer("revision").notNull(),
    title: text("title").notNull(),
    steps: jsonb("steps").$type<ProcedureStep[]>().notNull(),
    status: text("status", { enum: ["open", "completed", "cancelled"] }).notNull().default("open"),
    /** The day the run is for, in the business's timezone. */
    dueOn: date("due_on", { mode: "string" }).notNull(),
    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
    startedBy: uuid("started_by").references(() => users.id, { onDelete: "set null" }),
    startedByName: text("started_by_name").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedBy: uuid("completed_by").references(() => users.id, { onDelete: "set null" }),
    completedByName: text("completed_by_name"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** True when a yes/no check was answered "no". */
    flagged: boolean("flagged").notNull().default(false),
  },
  (t) => [index("docs_runs_page_idx").on(t.pageId, t.dueOn), index("docs_runs_status_idx").on(t.status, t.assignedTo)],
);

/** Who ticked each step of a run, and when, with the answer to its check. */
export const docsRunSteps = pgTable(
  "docs_run_steps",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => docsRuns.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    doneBy: uuid("done_by").references(() => users.id, { onDelete: "set null" }),
    doneByName: text("done_by_name").notNull(),
    doneAt: timestamp("done_at", { withTimezone: true }).notNull().defaultNow(),
    answer: text("answer").notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.runId, t.position] })],
);
