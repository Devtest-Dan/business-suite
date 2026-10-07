/**
 * The assistant's own tables. Every table name starts with "assistant_".
 * Imports are relative so drizzle-kit can load this file on its own.
 * After changing it: pnpm suite:db:generate assistant <short-name>
 *
 * The suite's database is the record of what the assistant knows: every
 * fact's text, where it came from, its earlier wordings and whether it was
 * withdrawn. When the brain (GBrain) is switched on, each fact is also
 * written there (gbrain_id), and coding agents read and add notes through it.
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, numeric, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../../lib/db/schema";
import { tsvector } from "../../lib/db/types";

/** Where a fact came from. */
export const assistantFactSourceEnum = pgEnum("assistant_fact_source", [
  // Typed by a person on "What the assistant knows" or "Remember this".
  "person",
  // Proposed by the assistant in a chat and approved by a person.
  "assistant",
  // From an imported AHL business-memory export, approved as one batch.
  "import",
  // Written by a coding agent through the brain's MCP address.
  "agent",
  // Found in the brain without a record here (written some other way); adopted on sight.
  "brain",
  // Invented demo data from the module's seed.
  "demo",
]);

export const assistantFactStatusEnum = pgEnum("assistant_fact_status", ["active", "corrected", "withdrawn"]);

/** GBrain's own kinds; anything else is stored as "fact". */
export const assistantFactKindEnum = pgEnum("assistant_fact_kind", ["fact", "preference", "commitment", "event", "belief"]);

export const assistantFacts = pgTable(
  "assistant_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    text: text("text").notNull(),
    kind: assistantFactKindEnum("kind").notNull().default("fact"),
    source: assistantFactSourceEnum("source").notNull(),
    /** Detail for the source: the app and page it came from, the agent token's label, the import's original source. */
    sourceDetail: text("source_detail").notNull().default(""),
    /** A link back to where it came from (inside the suite), when there is one. */
    sourceUrl: text("source_url"),
    status: assistantFactStatusEnum("status").notNull().default("active"),
    /**
     * GBrain's id for the current wording; null until it reaches the brain (or
     * when the brain is off). Not unique: GBrain answers an exact repeat of a
     * fact's text with the existing fact's id, so two records can share one.
     */
    gbrainId: text("gbrain_id"),
    /** The coding agent's client id when an agent wrote it (the replace guard checks this). */
    agentClientId: text("agent_client_id"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    withdrawnReason: text("withdrawn_reason"),
    /** The last time sending it to the brain failed, and why (shown to the owner). */
    brainError: text("brain_error"),
    // Set when the fact came from an approval or an import: a second guard against duplicates.
    sourceKey: text("source_key").unique(),
    search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('simple', coalesce("text", '') || ' ' || coalesce("source_detail", ''))`),
  },
  (t) => [
    index("assistant_facts_search_idx").using("gin", t.search),
    index("assistant_facts_status_idx").on(t.status, t.updatedAt),
    index("assistant_facts_gbrain_idx").on(t.gbrainId),
  ],
);

/** Earlier wordings of a fact, newest first when read. */
export const assistantFactVersions = pgTable(
  "assistant_fact_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    factId: uuid("fact_id")
      .notNull()
      .references(() => assistantFacts.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    /** Who wrote this earlier wording. */
    byName: text("by_name").notNull(),
    /** When this earlier wording was written. */
    writtenAt: timestamp("written_at", { withTimezone: true }).notNull(),
    replacedAt: timestamp("replaced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("assistant_fact_versions_fact_idx").on(t.factId, t.replacedAt)],
);

/** MCP access for coding agents. The token itself is shown once and never stored. */
export const assistantAgents = pgTable("assistant_agents", {
  clientId: text("client_id").primaryKey(),
  label: text("label").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdByName: text("created_by_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

/** Model calls per person per month (UTC month, "2026-10"). */
export const assistantUsage = pgTable(
  "assistant_usage",
  {
    month: text("month").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    calls: integer("calls").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.month, t.userId] })],
);

/**
 * The owner's settings for the assistant (one row, id 1): limits and fact privacy. Prices are the owner's own figures from
 * their provider's price page; the suite never assumes a price.
 */
export const assistantSettings = pgTable("assistant_settings", {
  id: integer("id").primaryKey().default(1),
  /** Most tokens (in + out) the whole team may use in a month; null = no token limit. */
  monthlyTokenCap: bigint("monthly_token_cap", { mode: "number" }),
  /** Most estimated spend in a month, in `currency`; null = no spend limit. Needs both prices. */
  monthlySpendCap: numeric("monthly_spend_cap", { precision: 12, scale: 2 }),
  /** The owner's price per million input tokens and per million output tokens. */
  pricePerMillionIn: numeric("price_per_million_in", { precision: 12, scale: 4 }),
  pricePerMillionOut: numeric("price_per_million_out", { precision: 12, scale: 4 }),
  currency: text("currency").notNull().default("USD"),
  /**
   * Replace names, emails, phone numbers and addresses with placeholders
   * before a fact is stored (coding agents read the brain too). Secrets and
   * card numbers are always removed, whatever this says.
   */
  redactFacts: boolean("redact_facts").notNull().default(true),
  /** The month the "limit reached" notice was last sent, so it goes once a month. */
  notifiedMonth: text("notified_month"),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The suite's own client on the brain (one row, id 1): created through
 * GBrain's owner API the first time the suite talks to the brain. The secret
 * is sealed with SUITE_SECRET_KEY.
 */
export const assistantBrainClient = pgTable("assistant_brain_client", {
  id: integer("id").primaryKey().default(1),
  clientId: text("client_id").notNull(),
  secret: text("secret").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
