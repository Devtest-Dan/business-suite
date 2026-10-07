/**
 * Chat's own tables. Every table name starts with "chat_".
 * Imports are relative so drizzle-kit can load this file on its own.
 * After changing it: pnpm suite:db:generate chat <name>
 *
 * Cursors: one sequence, chat_seq, numbers every change. A message gets
 * `cseq` once, when it is created (unread counts and "jump to unread" use it),
 * and `seq` again on every change (edit, delete, reaction, pin, new reply), so
 * "everything since cursor N" is one indexed query and a reconnecting browser
 * catches up without missing an edit.
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, pgEnum, pgSequence, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../../lib/db/schema";
import { tsvector } from "../../lib/db/types";

export const chatSeq = pgSequence("chat_seq", { startWith: 1, increment: 1 });

export const chatChannelKind = pgEnum("chat_channel_kind", ["public", "private", "dm", "group"]);
export const chatNotifyLevel = pgEnum("chat_notify_level", ["all", "mentions", "none"]);
export const chatVia = pgEnum("chat_via", ["user", "ai", "import"]);

export const chatChannels = pgTable(
  "chat_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: chatChannelKind("kind").notNull(),
    /** Lower-case, dashes; null for direct messages. Unique among channels. */
    name: text("name").unique(),
    topic: text("topic").notNull().default(""),
    /** Everyone who is not a guest joins it on their first visit. */
    isDefault: boolean("is_default").notNull().default(false),
    /** Sorted member ids for direct messages, so the same people always get the same conversation. */
    dmKey: text("dm_key").unique(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    /** Where it came from when imported, e.g. "slack:C024BE91L". */
    importKey: text("import_key").unique(),
  },
  (t) => [index("chat_channels_kind_idx").on(t.kind, t.archivedAt)],
);

export const chatMembers = pgTable(
  "chat_members",
  {
    channelId: uuid("channel_id")
      .notNull()
      .references(() => chatChannels.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    /** The `cseq` of the newest message this person has seen here. */
    lastReadCseq: bigint("last_read_cseq", { mode: "number" }).notNull().default(0),
    notify: chatNotifyLevel("notify").notNull().default("mentions"),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.userId] }), index("chat_members_user_idx").on(t.userId)],
);

export interface ChatAttachment {
  fileId: string;
  name: string;
  mime: string;
  size: number;
}

export interface ChatLinkPreview {
  url: string;
  host: string;
  title: string;
  description: string;
  siteName: string;
}

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => chatChannels.id, { onDelete: "cascade" }),
    /** The thread's first message; null for a message in the channel itself. */
    parentId: uuid("parent_id"),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull(),
    body: text("body").notNull(),
    mentionedIds: uuid("mentioned_ids").array().notNull().default(sql`'{}'::uuid[]`),
    mentionsChannel: boolean("mentions_channel").notNull().default(false),
    attachments: jsonb("attachments").$type<ChatAttachment[]>().notNull().default(sql`'[]'::jsonb`),
    linkPreview: jsonb("link_preview").$type<ChatLinkPreview | null>(),
    replyCount: integer("reply_count").notNull().default(0),
    lastReplyAt: timestamp("last_reply_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    pinnedBy: uuid("pinned_by").references(() => users.id, { onDelete: "set null" }),
    via: chatVia("via").notNull().default("user"),
    /** Set when a message is created once, then changes: never. Orders messages; unread counts compare with it. */
    cseq: bigint("cseq", { mode: "number" }).notNull().unique().default(sql`nextval('chat_seq')`),
    /** Bumped on every change: the realtime cursor. */
    seq: bigint("seq", { mode: "number" }).notNull().default(sql`nextval('chat_seq')`),
    /** The approval ledger key or the import key: a second guard against writing a message twice. */
    sourceKey: text("source_key").unique(),
    search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('simple', coalesce("body", ''))`),
  },
  (t) => [
    index("chat_messages_channel_idx").on(t.channelId, t.parentId, t.cseq),
    index("chat_messages_seq_idx").on(t.channelId, t.seq),
    index("chat_messages_parent_idx").on(t.parentId, t.cseq),
    index("chat_messages_search_idx").using("gin", t.search),
  ],
);

export const chatReactions = pgTable(
  "chat_reactions",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
);

/** One row per person who has opened chat: when they were put in the default channels (once, so leaving one sticks). */
export const chatPeople = pgTable("chat_people", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  defaultsJoinedAt: timestamp("defaults_joined_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row (id = 1): the owner's chat settings. */
export const chatSettings = pgTable("chat_settings", {
  id: integer("id").primaryKey().default(1),
  /** Hosts whose page title and description may be shown under a link. Empty: no previews. */
  previewHosts: text("preview_hosts").array().notNull().default(sql`'{}'::text[]`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
