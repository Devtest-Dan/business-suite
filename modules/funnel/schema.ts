/**
 * Leads' own tables. Every table and enum name starts with "funnel_".
 * Imports are relative so drizzle-kit can load this file on its own.
 * After changing it: pnpm suite:db:generate funnel <short-name>
 */
import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../../lib/db/schema";
import { tsvector } from "../../lib/db/types";

export const leadStatusEnum = pgEnum("funnel_lead_status", ["new", "contacted", "qualified", "converted", "disqualified"]);
export const leadSourceEnum = pgEnum("funnel_lead_source", ["form", "phone", "walk_in", "email", "referral", "import", "other"]);
export const enrollmentStatusEnum = pgEnum("funnel_enrollment_status", ["active", "stopped", "finished"]);
export const sendStatusEnum = pgEnum("funnel_send_status", ["scheduled", "sending", "sent", "failed", "cancelled"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** One row (id 1): the owner's settings for Leads. */
export const funnelSettings = pgTable(
  "funnel_settings",
  {
    id: integer("id").primaryKey().default(1),
    /** Speed to lead: a new lead not contacted within this many minutes is flagged. */
    targetMinutes: integer("target_minutes").notNull().default(15),
    /** The business's postal address, printed at the foot of every sequence email (CAN-SPAM). */
    postalAddress: text("postal_address").notNull().default(""),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: updatedAt(),
  },
  (t) => [check("funnel_settings_one_row", sql`${t.id} = 1`)],
);

/** A lead form: a hosted public page and an embed snippet for the owner's website. */
export const funnelForms = pgTable("funnel_forms", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The public address segment (/api/m/funnel/f/<slug>): random, not the id. */
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  heading: text("heading").notNull().default(""),
  /** Which optional fields the form shows: email, phone, company, message, service, contact_method. */
  fields: text("fields").array().notNull().default(sql`'{}'::text[]`),
  /** The choices for "service wanted". */
  services: text("services").array().notNull().default(sql`'{}'::text[]`),
  /** The owner's own consent wording; the visitor must tick it. */
  consentText: text("consent_text").notNull(),
  thankYouMessage: text("thank_you_message").notNull().default(""),
  /** Optional: send the visitor to this page after they submit, instead of the thank-you message. */
  redirectUrl: text("redirect_url").notNull().default(""),
  /** Websites allowed to show the form in an iframe (origins). Empty: any website. */
  embedOrigins: text("embed_origins").array().notNull().default(sql`'{}'::text[]`),
  /** New leads from this form go to this person; empty: everyone who gets new-lead alerts. */
  assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
  active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const funnelLeads = pgTable(
  "funnel_leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull().default(""),
    phone: text("phone").notNull().default(""),
    company: text("company").notNull().default(""),
    message: text("message").notNull().default(""),
    service: text("service").notNull().default(""),
    /** How they prefer to be contacted: "", "email", "phone" or "text". */
    contactMethod: text("contact_method").notNull().default(""),
    status: leadStatusEnum("status").notNull().default("new"),
    disqualifyReason: text("disqualify_reason").notNull().default(""),
    source: leadSourceEnum("source").notNull(),
    /** The form's name, or the person's note for a lead added by hand ("Saw the van"). */
    sourceDetail: text("source_detail").notNull().default(""),
    formId: uuid("form_id").references(() => funnelForms.id, { onDelete: "set null" }),
    pageUrl: text("page_url").notNull().default(""),
    referrer: text("referrer").notNull().default(""),
    utmSource: text("utm_source").notNull().default(""),
    utmMedium: text("utm_medium").notNull().default(""),
    utmCampaign: text("utm_campaign").notNull().default(""),
    /** The consent wording the visitor ticked, as it read then. */
    consentText: text("consent_text").notNull().default(""),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Speed to lead is firstContactAt − createdAt. */
    firstContactAt: timestamp("first_contact_at", { withTimezone: true }),
    qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    disqualifiedAt: timestamp("disqualified_at", { withTimezone: true }),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    /** Set once by conversion through Customers' write action: the ids it returned. */
    customerContactId: text("customer_contact_id"),
    customerDealId: text("customer_deal_id"),
    conversionApprovalId: uuid("conversion_approval_id"),
    conversionAttempt: integer("conversion_attempt").notNull().default(0),
    emailKey: text("email_key").notNull().default(""),
    phoneKey: text("phone_key").notNull().default(""),
    /** Set when the lead came from an approval (an import): a second guard against duplicates. */
    sourceKey: text("source_key").unique(),
    search: tsvector("search").generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce("name", '') || ' ' || coalesce("company", '')), 'A') || setweight(to_tsvector('simple', coalesce("email", '') || ' ' || coalesce("phone", '') || ' ' || coalesce("service", '')), 'B') || setweight(to_tsvector('simple', coalesce("message", '')), 'C')`,
    ),
  },
  (t) => [
    index("funnel_leads_status_idx").on(t.status, t.createdAt),
    index("funnel_leads_assignee_idx").on(t.assigneeId, t.status),
    index("funnel_leads_created_idx").on(t.createdAt),
    index("funnel_leads_email_key_idx").on(t.emailKey),
    index("funnel_leads_phone_key_idx").on(t.phoneKey),
    index("funnel_leads_search_idx").using("gin", t.search),
  ],
);

/** A lead's timeline: contacts logged, status changes, assignment, conversion, emails. */
export const funnelLeadEvents = pgTable(
  "funnel_lead_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => funnelLeads.id, { onDelete: "cascade" }),
    /** received, contact, status, assigned, converted, sequence, email, unsubscribed, replied, note */
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("funnel_lead_events_lead_idx").on(t.leadId, t.at)],
);

/** A short follow-up email sequence. */
export const funnelSequences = pgTable("funnel_sequences", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(false),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const funnelSequenceSteps = pgTable(
  "funnel_sequence_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sequenceId: uuid("sequence_id")
      .notNull()
      .references(() => funnelSequences.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** Days after the enrolment was approved (0: straight away). */
    delayDays: integer("delay_days").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
  },
  (t) => [uniqueIndex("funnel_sequence_steps_position_idx").on(t.sequenceId, t.position)],
);

/** A lead in a sequence (written once, by the approved enrolment). */
export const funnelEnrollments = pgTable(
  "funnel_enrollments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => funnelLeads.id, { onDelete: "cascade" }),
    sequenceId: uuid("sequence_id")
      .notNull()
      .references(() => funnelSequences.id, { onDelete: "cascade" }),
    status: enrollmentStatusEnum("status").notNull().default("active"),
    stopReason: text("stop_reason").notNull().default(""),
    approvalId: uuid("approval_id"),
    sourceKey: text("source_key").unique(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("funnel_enrollments_lead_sequence_idx").on(t.leadId, t.sequenceId), index("funnel_enrollments_status_idx").on(t.status)],
);

/** One email of an enrolment, sent once at its due time (claimed with a conditional UPDATE). */
export const funnelSends = pgTable(
  "funnel_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => funnelEnrollments.id, { onDelete: "cascade" }),
    stepId: uuid("step_id")
      .notNull()
      .references(() => funnelSequenceSteps.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    status: sendStatusEnum("status").notNull().default("scheduled"),
    claimToken: text("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    toEmail: text("to_email").notNull().default(""),
    subject: text("subject").notNull().default(""),
    error: text("error"),
  },
  (t) => [uniqueIndex("funnel_sends_enrollment_step_idx").on(t.enrollmentId, t.stepId), index("funnel_sends_due_idx").on(t.status, t.dueAt)],
);

/** Public form submissions counted per key (hashed network address, or form) and minute window. */
export const funnelRateHits = pgTable(
  "funnel_rate_hits",
  {
    bucket: text("bucket").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    hits: integer("hits").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.windowStart] }), index("funnel_rate_hits_window_idx").on(t.windowStart)],
);
