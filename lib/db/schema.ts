/**
 * The core schema: accounts, sessions, settings, permissions, the audit log,
 * notifications, files and the shared approvals ledger. Modules keep their own
 * tables in `modules/<id>/schema.ts` (prefixed with the module id) and their own
 * migrations in `modules/<id>/migrations/`.
 *
 * Imports are relative (not "@/") so drizzle-kit can load this file on its own.
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ── Enums (the TypeScript unions are derived from these, never typed by hand) ──

export const roleEnum = pgEnum("role", ["owner", "admin", "member", "guest"]);
export const userStatusEnum = pgEnum("user_status", ["active", "disabled"]);
export const actorKindEnum = pgEnum("actor_kind", ["user", "ai", "system"]);
export const visibilityEnum = pgEnum("visibility", ["everyone", "admins"]);
export const approvalSourceEnum = pgEnum("approval_source", ["ai", "import", "user"]);
export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "running",
  "applied",
  "partially_applied",
  "failed",
  "declined",
]);
export const approvalItemStatusEnum = pgEnum("approval_item_status", [
  "pending",
  "claimed",
  "applied",
  "failed",
  "skipped",
]);
export const storageEnum = pgEnum("storage_driver", ["local", "s3"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ── Accounts ─────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Always stored lower-case (lib/auth/normalize.ts).
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: roleEnum("role").notNull().default("member"),
  status: userStatusEnum("status").notNull().default("active"),
  createdAt: createdAt(),
  lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
});

export const sessions = pgTable(
  "sessions",
  {
    // SHA-256 of the cookie token; the token itself is never stored.
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: text("user_agent"),
    ip: text("ip"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const authAttempts = pgTable(
  "auth_attempts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    success: boolean("success").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("auth_attempts_lookup_idx").on(t.kind, t.key, t.at)],
);

export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  email: text("email").notNull(),
  role: roleEnum("role").notNull(),
  invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
  emailed: boolean("emailed").notNull().default(false),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  acceptedUserId: uuid("accepted_user_id").references(() => users.id, { onDelete: "set null" }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const passwordResets = pgTable("password_resets", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Null when the person asked for it themselves by email.
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

// ── Settings and permissions ─────────────────────────────────────────────────

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
});

/** Overrides of a permission's default roles (the defaults live in code). */
export const rolePermissions = pgTable(
  "role_permissions",
  {
    role: roleEnum("role").notNull(),
    permission: text("permission").notNull(),
    allowed: boolean("allowed").notNull(),
  },
  (t) => [primaryKey({ columns: [t.role, t.permission] })],
);

/** One row per installed module: switched on or off, and when its seed data ran. */
export const moduleState = pgTable("module_state", {
  moduleId: text("module_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  seededAt: timestamp("seeded_at", { withTimezone: true }),
});

// ── Audit log (append-only: a trigger refuses UPDATE, DELETE and TRUNCATE) ────

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    // No foreign key: the log must outlive the rows it talks about.
    actorId: uuid("actor_id"),
    actorName: text("actor_name").notNull(),
    actorKind: actorKindEnum("actor_kind").notNull(),
    action: text("action").notNull(),
    module: text("module"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    summary: text("summary").notNull(),
    data: jsonb("data"),
    visibility: visibilityEnum("visibility").notNull().default("admins"),
  },
  (t) => [index("audit_log_at_idx").on(t.at)],
);

// ── Notifications ────────────────────────────────────────────────────────────

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    url: text("url"),
    createdAt: createdAt(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.readAt)],
);

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
});

export const notificationPrefs = pgTable(
  "notification_prefs",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    push: boolean("push").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] })],
);

// ── Files ────────────────────────────────────────────────────────────────────

export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  storage: storageEnum("storage").notNull(),
  storageKey: text("storage_key").notNull(),
  module: text("module"),
  // Files a guest may open (e.g. the business logo).
  isPublic: boolean("is_public").notNull().default(false),
  uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

// ── Approvals: one approval per proposal, one ledger row per record ──────────

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    module: text("module").notNull(),
    // The write action's full name, e.g. "announcements.post".
    action: text("action").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    source: approvalSourceEnum("source").notNull(),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    // The app that proposed it from its own code (e.g. "tasks" posting in Chat); apply sees it as ctx.calledBy.
    calledBy: text("called_by"),
    status: approvalStatusEnum("status").notNull().default("pending"),
    total: integer("total").notNull(),
    appliedCount: integer("applied_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    // Records left out at creation because the ledger already held their key.
    duplicateCount: integer("duplicate_count").notNull().default(0),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("approvals_status_idx").on(t.status, t.createdAt)],
);

export const approvalItems = pgTable(
  "approval_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    approvalId: uuid("approval_id")
      .notNull()
      .references(() => approvals.id, { onDelete: "cascade" }),
    // Copied from the approval so the ledger can be unique per action.
    action: text("action").notNull(),
    position: integer("position").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload").notNull(),
    preview: text("preview").notNull(),
    status: approvalItemStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    claimToken: uuid("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    error: text("error"),
    result: jsonb("result"),
  },
  (t) => [
    // The ledger: one record per dedupe key per action, across every batch.
    uniqueIndex("approval_items_ledger_idx").on(t.action, t.dedupeKey),
    index("approval_items_approval_idx").on(t.approvalId, t.position),
  ],
);

// ── AI assistant conversations ───────────────────────────────────────────────

export const aiConversations = pgTable("ai_conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  messages: jsonb("messages").notNull().default(sql`'[]'::jsonb`),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Role = (typeof roleEnum.enumValues)[number];
export type UserStatus = (typeof userStatusEnum.enumValues)[number];
export type ActorKind = (typeof actorKindEnum.enumValues)[number];
export type Visibility = (typeof visibilityEnum.enumValues)[number];
export type ApprovalSource = (typeof approvalSourceEnum.enumValues)[number];
export type ApprovalStatus = (typeof approvalStatusEnum.enumValues)[number];
export type ApprovalItemStatus = (typeof approvalItemStatusEnum.enumValues)[number];
export type User = typeof users.$inferSelect;
