/**
 * Announcements' own tables. Every table a module owns starts with its id.
 * Imports are relative so drizzle-kit can load this file on its own.
 */
import { sql } from "drizzle-orm";
import { boolean, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../../lib/db/schema";
import { tsvector } from "../../lib/db/types";

export const announcementPosts = pgTable(
  "announcements_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull(),
    pinned: boolean("pinned").notNull().default(false),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Set when the post came from an approval: the ledger key, unique, a second guard against duplicates.
    sourceKey: text("source_key").unique(),
    search: tsvector("search").generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce("title", '')), 'A') || setweight(to_tsvector('simple', coalesce("body", '')), 'B')`,
    ),
  },
  (t) => [index("announcements_posts_search_idx").using("gin", t.search), index("announcements_posts_created_idx").on(t.pinned, t.createdAt)],
);

export const announcementReads = pgTable(
  "announcements_reads",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => announcementPosts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.userId] })],
);
