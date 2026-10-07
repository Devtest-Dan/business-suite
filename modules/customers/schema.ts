/**
 * Customers' own tables. Every table and enum name starts with "customers_".
 * Imports are relative so drizzle-kit can load this file on its own.
 * After changing it: pnpm suite:db:generate customers <short-name>
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../../lib/db/schema";
import { tsvector } from "../../lib/db/types";

export const activityKindEnum = pgEnum("customers_activity_kind", ["call", "email", "meeting", "note", "stage_change"]);
export const stageKindEnum = pgEnum("customers_stage_kind", ["open", "won", "lost"]);
export const followUpStatusEnum = pgEnum("customers_follow_up_status", ["open", "done", "cancelled"]);
export const followUpViaEnum = pgEnum("customers_follow_up_via", ["here", "tasks"]);
export const fieldEntityEnum = pgEnum("customers_field_entity", ["contact", "company", "deal"]);
export const fieldTypeEnum = pgEnum("customers_field_type", ["text", "number", "date", "choice"]);
export const filterEntityEnum = pgEnum("customers_filter_entity", ["contacts", "companies", "deals"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const customerCompanies = pgTable(
  "customers_companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    website: text("website").notNull().default(""),
    phone: text("phone").notNull().default(""),
    email: text("email").notNull().default(""),
    address: text("address").notNull().default(""),
    notes: text("notes").notNull().default(""),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    custom: jsonb("custom").$type<Record<string, string>>().notNull().default({}),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Set when the record came from an approval (the ledger key): a second guard against duplicates.
    sourceKey: text("source_key").unique(),
    search: tsvector("search").generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce("name", '')), 'A') || setweight(to_tsvector('simple', coalesce("email", '') || ' ' || coalesce("website", '')), 'B') || setweight(to_tsvector('simple', coalesce("notes", '')), 'C')`,
    ),
  },
  (t) => [
    index("customers_companies_search_idx").using("gin", t.search),
    index("customers_companies_tags_idx").using("gin", t.tags),
    index("customers_companies_name_idx").on(sql`lower(${t.name})`),
  ],
);

export const customerContacts = pgTable(
  "customers_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull().default(""),
    phone: text("phone").notNull().default(""),
    jobTitle: text("job_title").notNull().default(""),
    companyId: uuid("company_id").references(() => customerCompanies.id, { onDelete: "set null" }),
    address: text("address").notNull().default(""),
    notes: text("notes").notNull().default(""),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    custom: jsonb("custom").$type<Record<string, string>>().notNull().default({}),
    // Normalised copies for duplicate detection (lower-case email, digits of the phone, folded name).
    emailKey: text("email_key").notNull().default(""),
    phoneKey: text("phone_key").notNull().default(""),
    nameKey: text("name_key").notNull().default(""),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    sourceKey: text("source_key").unique(),
    search: tsvector("search").generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce("name", '')), 'A') || setweight(to_tsvector('simple', coalesce("email", '') || ' ' || coalesce("phone", '') || ' ' || coalesce("job_title", '')), 'B') || setweight(to_tsvector('simple', coalesce("notes", '')), 'C')`,
    ),
  },
  (t) => [
    index("customers_contacts_search_idx").using("gin", t.search),
    index("customers_contacts_tags_idx").using("gin", t.tags),
    index("customers_contacts_email_key_idx").on(t.emailKey),
    index("customers_contacts_phone_key_idx").on(t.phoneKey),
    index("customers_contacts_name_key_idx").on(t.nameKey),
    index("customers_contacts_company_idx").on(t.companyId),
  ],
);

/** Pipeline stages, in the owner's order. "won" and "lost" stages close a deal. */
export const customerStages = pgTable("customers_stages", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  position: integer("position").notNull(),
  kind: stageKindEnum("kind").notNull().default("open"),
  createdAt: createdAt(),
});

export const customerDeals = pgTable(
  "customers_deals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    contactId: uuid("contact_id").references(() => customerContacts.id, { onDelete: "set null" }),
    companyId: uuid("company_id").references(() => customerCompanies.id, { onDelete: "set null" }),
    stageId: uuid("stage_id")
      .notNull()
      .references(() => customerStages.id, { onDelete: "restrict" }),
    // Whole cents in the business's currency; null when nobody has put a value on it.
    valueCents: bigint("value_cents", { mode: "number" }),
    expectedClose: date("expected_close"),
    notes: text("notes").notNull().default(""),
    custom: jsonb("custom").$type<Record<string, string>>().notNull().default({}),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    sourceKey: text("source_key").unique(),
    search: tsvector("search").generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce("title", '')), 'A') || setweight(to_tsvector('simple', coalesce("notes", '')), 'C')`,
    ),
  },
  (t) => [index("customers_deals_search_idx").using("gin", t.search), index("customers_deals_stage_idx").on(t.stageId)],
);

/** The timeline: calls, emails, meetings, notes, and stage changes. */
export const customerActivities = pgTable(
  "customers_activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: activityKindEnum("kind").notNull(),
    body: text("body").notNull(),
    contactId: uuid("contact_id").references(() => customerContacts.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => customerCompanies.id, { onDelete: "cascade" }),
    dealId: uuid("deal_id").references(() => customerDeals.id, { onDelete: "cascade" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull(),
    // "ai" when the assistant drafted it and a person approved it.
    via: text("via").notNull().default("user"),
    createdAt: createdAt(),
    sourceKey: text("source_key").unique(),
    search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('simple', coalesce("body", ''))`),
  },
  (t) => [
    index("customers_activities_contact_idx").on(t.contactId, t.occurredAt),
    index("customers_activities_company_idx").on(t.companyId, t.occurredAt),
    index("customers_activities_deal_idx").on(t.dealId, t.occurredAt),
    index("customers_activities_search_idx").using("gin", t.search),
  ],
);

/** Follow-up reminders. When the tasks app is on, the reminder lives there and this row links to it. */
export const customerFollowUps = pgTable(
  "customers_follow_ups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    notes: text("notes").notNull().default(""),
    dueOn: date("due_on").notNull(),
    contactId: uuid("contact_id").references(() => customerContacts.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => customerCompanies.id, { onDelete: "cascade" }),
    dealId: uuid("deal_id").references(() => customerDeals.id, { onDelete: "cascade" }),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    status: followUpStatusEnum("status").notNull().default("open"),
    via: followUpViaEnum("via").notNull().default("here"),
    // When via = "tasks": the approval that created the task, and the task's id once written.
    taskApprovalId: uuid("task_approval_id"),
    taskId: text("task_id"),
    // Set once the "due" notification has gone out, so it is sent once.
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    doneAt: timestamp("done_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    sourceKey: text("source_key").unique(),
  },
  (t) => [index("customers_follow_ups_due_idx").on(t.status, t.dueOn), index("customers_follow_ups_assignee_idx").on(t.assigneeId, t.status)],
);

/** A few custom fields per kind of record, defined by the owner. Values live in each record's `custom`. */
export const customerFields = pgTable(
  "customers_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entity: fieldEntityEnum("entity").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    type: fieldTypeEnum("type").notNull().default("text"),
    options: text("options").array().notNull().default(sql`'{}'::text[]`),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("customers_fields_entity_key_idx").on(t.entity, t.key)],
);

/** Saved filters: private to the person, or shared with the team. */
export const customerSavedFilters = pgTable("customers_saved_filters", {
  id: uuid("id").primaryKey().defaultRandom(),
  entity: filterEntityEnum("entity").notNull(),
  name: text("name").notNull(),
  query: jsonb("query").$type<Record<string, string>>().notNull(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  shared: boolean("shared").notNull().default(false),
  createdAt: createdAt(),
});
