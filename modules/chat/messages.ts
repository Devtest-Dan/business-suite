import "server-only";
import { and, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { audit, userActor } from "@/lib/audit";
import { db as rootDb, type Db, type DbTx } from "@/lib/db/client";
import { files, notifications } from "@/lib/db/schema";
import { UserError } from "@/lib/errors";
import type { ModuleContext, Viewer } from "@/lib/modules/contract";
import { notify } from "@/lib/notifications";
import { deleteStoredFile } from "@/lib/storage";
import { channelReaders, conversationLabel, isDirect, messageRow, MODULE_ID, P, type Access, type Channel } from "./data";
import { linkPreviewFor } from "./link-preview";
import { publish } from "./realtime";
import { chatChannels, chatMembers, chatMessages, chatReactions, type ChatAttachment } from "./schema";
import { findMentions, urlsIn } from "./text";

type Conn = Db | DbTx;

export interface NewMessage {
  channel: Channel;
  author: { id: string | null; name: string };
  body: string;
  parentId?: string | null;
  attachments?: ChatAttachment[];
  via?: "user" | "ai" | "import";
  sourceKey?: string | null;
  /** May the author alert everyone with @channel? */
  mayMentionAll?: boolean;
  /** Imported messages keep their original time. */
  createdAt?: Date;
}

/**
 * Writes one message (in the caller's transaction when given one) and tells
 * open browsers. Returns the message id and a function that sends the
 * notifications and fetches a link preview; call it after the commit.
 */
export async function insertMessage(db: Conn, input: NewMessage): Promise<{ id: string; cseq: number; existed: boolean; after: () => Promise<void> }> {
  if (input.channel.archivedAt && input.via !== "import") throw new UserError("This channel is archived, so nothing new can be posted. Ask its owner or an admin to unarchive it.");
  let parent: { id: string; parentId: string | null; authorId: string | null } | null = null;
  if (input.parentId) {
    const row = await messageRow(db, input.parentId);
    if (!row || row.channelId !== input.channel.id) throw new UserError("The thread you replied to is not in this conversation any more. Reload the page.");
    // Replies always hang off the thread's first message.
    parent = row.parentId ? { id: row.parentId, parentId: null, authorId: null } : { id: row.id, parentId: null, authorId: row.authorId };
  }
  const readers = await channelReaders(db, input.channel);
  const found = findMentions(input.body, readers);
  const mentionsChannel = found.channel && (input.mayMentionAll ?? false) && !isDirect(input.channel.kind);

  const [created] = await db
    .insert(chatMessages)
    .values({
      channelId: input.channel.id,
      parentId: parent?.id ?? null,
      authorId: input.author.id,
      authorName: input.author.name,
      body: input.body,
      mentionedIds: found.userIds,
      mentionsChannel,
      attachments: input.attachments ?? [],
      via: input.via ?? "user",
      sourceKey: input.sourceKey ?? null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .onConflictDoNothing({ target: chatMessages.sourceKey })
    .returning({ id: chatMessages.id, cseq: chatMessages.cseq, seq: chatMessages.seq, createdAt: chatMessages.createdAt });

  if (!created) {
    // Already written (same source key): a retry or a double click. Nothing more to do.
    const [existing] = await db.select({ id: chatMessages.id, cseq: chatMessages.cseq }).from(chatMessages).where(eq(chatMessages.sourceKey, input.sourceKey!));
    return { id: existing.id, cseq: existing.cseq, existed: true, after: async () => {} };
  }

  await db
    .update(chatChannels)
    .set({ lastMessageAt: sql`greatest(${chatChannels.lastMessageAt}, ${created.createdAt.toISOString()}::timestamptz)` })
    .where(eq(chatChannels.id, input.channel.id));
  if (parent) {
    await db
      .update(chatMessages)
      .set({ replyCount: sql`${chatMessages.replyCount} + 1`, lastReplyAt: created.createdAt, seq: sql`nextval('chat_seq')` })
      .where(eq(chatMessages.id, parent.id));
  }
  // The author has read their own message.
  if (input.author.id) {
    await db
      .update(chatMembers)
      .set({ lastReadCseq: sql`greatest(${chatMembers.lastReadCseq}, ${created.cseq})` })
      .where(and(eq(chatMembers.channelId, input.channel.id), eq(chatMembers.userId, input.author.id), parent ? sql`false` : sql`true`));
  }
  if (input.via === "import") {
    // Imported history arrives already read.
    await db.update(chatMembers).set({ lastReadCseq: sql`greatest(${chatMembers.lastReadCseq}, ${created.cseq})` }).where(eq(chatMembers.channelId, input.channel.id));
  }
  await publish(db, { k: "m", c: input.channel.id, s: Number(created.seq), p: parent?.id ?? null });

  const after = async () => {
    if (input.via === "import") return;
    await sendNotifications({ ...input, parentId: parent?.id ?? null, mentionedIds: found.userIds, mentionsChannel, messageId: created.id });
    void attachPreview(created.id, input.channel.id, input.body);
  };
  return { id: created.id, cseq: created.cseq, existed: false, after };
}

async function attachPreview(messageId: string, channelId: string, body: string): Promise<void> {
  const url = urlsIn(body)[0];
  if (!url) return;
  try {
    const preview = await linkPreviewFor(rootDb(), url);
    if (!preview) return;
    await rootDb().transaction(async (tx) => {
      const [row] = await tx
        .update(chatMessages)
        .set({ linkPreview: preview, seq: sql`nextval('chat_seq')` })
        .where(and(eq(chatMessages.id, messageId), isNull(chatMessages.deletedAt)))
        .returning({ seq: chatMessages.seq, parentId: chatMessages.parentId });
      if (row) await publish(tx, { k: "m", c: channelId, s: Number(row.seq), p: row.parentId });
    });
  } catch (error) {
    console.error("Link preview failed:", error instanceof Error ? error.message : error);
  }
}

function excerpt(body: string, attachments: ChatAttachment[] = []): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (text) return text.length > 140 ? `${text.slice(0, 139)}…` : text;
  return attachments.length ? `Sent ${attachments.length === 1 ? `a file: ${attachments[0].name}` : `${attachments.length} files`}` : "";
}

/**
 * Who hears about a new message, by each person's setting for the conversation:
 * - direct messages: everyone else in it, unless they chose "nothing";
 * - channels: "all" → every message; "mentions" → when named or @channel; "nothing" → never;
 * - thread replies: the thread's starter and earlier repliers (same rules), plus anyone named.
 * Someone named in a public channel they have not joined still hears about it.
 */
async function sendNotifications(m: NewMessage & { parentId: string | null; mentionedIds: string[]; mentionsChannel: boolean; messageId: string }): Promise<void> {
  const conn = rootDb();
  const members = await conn.select({ userId: chatMembers.userId, notify: chatMembers.notify }).from(chatMembers).where(eq(chatMembers.channelId, m.channel.id));
  const level = new Map(members.map((r) => [r.userId, r.notify]));
  const authorId = m.author.id;
  const label = await conversationLabel(conn, m.channel, authorId ?? "");
  const url = m.parentId ? `/m/${MODULE_ID}/${m.channel.id}/thread/${m.parentId}?m=${m.messageId}` : `/m/${MODULE_ID}/${m.channel.id}?m=${m.messageId}`;
  const body = excerpt(m.body, m.attachments);
  const done = new Set<string>(authorId ? [authorId] : []);

  const send = async (ids: string[], kind: string, title: string) => {
    const fresh = ids.filter((id) => !done.has(id));
    fresh.forEach((id) => done.add(id));
    if (fresh.length) await notify(fresh, { kind, title, body, url });
  };

  if (isDirect(m.channel.kind)) {
    const ids = members.filter((r) => r.notify !== "none").map((r) => r.userId);
    await send(ids, "chat.dm", m.channel.kind === "dm" ? `${m.author.name} sent you a message` : `${m.author.name} in ${label}`);
    return;
  }

  // Named people (members unless they muted the channel; non-members of a public channel always).
  const named = m.mentionedIds.filter((id) => level.get(id) !== "none");
  await send(named, "chat.mention", `${m.author.name} mentioned you in ${label}`);
  if (m.mentionsChannel) {
    await send(
      members.filter((r) => r.notify !== "none").map((r) => r.userId),
      "chat.mention",
      `${m.author.name} alerted everyone in ${label}`,
    );
  }
  if (m.parentId) {
    const thread = await conn
      .selectDistinct({ authorId: chatMessages.authorId })
      .from(chatMessages)
      .where(or(eq(chatMessages.id, m.parentId), eq(chatMessages.parentId, m.parentId)));
    const ids = thread.map((t) => t.authorId).filter((id): id is string => Boolean(id) && level.has(id!) && level.get(id!) !== "none");
    await send(ids, "chat.reply", `${m.author.name} replied in a thread in ${label}`);
    return;
  }
  await send(
    members.filter((r) => r.notify === "all").map((r) => r.userId),
    "chat.message",
    `${m.author.name} in ${label}`,
  );
}

/** Checks the files belong to the sender and were uploaded for chat; returns them as attachments. */
export async function attachmentsFor(db: Conn, viewer: Viewer, fileIds: string[]): Promise<ChatAttachment[]> {
  if (fileIds.length === 0) return [];
  const rows = await db.select().from(files).where(inArray(files.id, fileIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return fileIds.map((id) => {
    const f = byId.get(id);
    if (!f || f.uploadedBy !== viewer.id || f.module !== MODULE_ID) throw new UserError("One of the attachments is missing or is not yours. Remove it and attach the file again.");
    return { fileId: f.id, name: f.name, mime: f.mime, size: f.size };
  });
}

// ── Changes to a message ─────────────────────────────────────────────────────

async function bump(tx: DbTx, messageId: string, set: Partial<typeof chatMessages.$inferInsert> = {}): Promise<void> {
  const [row] = await tx
    .update(chatMessages)
    .set({ ...set, seq: sql`nextval('chat_seq')` })
    .where(eq(chatMessages.id, messageId))
    .returning({ seq: chatMessages.seq, channelId: chatMessages.channelId, parentId: chatMessages.parentId });
  if (row) await publish(tx, { k: "m", c: row.channelId, s: Number(row.seq), p: row.parentId });
}

async function editable(ctx: ModuleContext, access: Access, messageId: string) {
  const row = await messageRow(ctx.db, messageId);
  if (!row || row.channelId !== access.channel.id) throw new UserError("That message is not here any more. Reload the page.");
  if (row.deletedAt) throw new UserError("That message was deleted.");
  return row;
}

export async function editMessage(ctx: ModuleContext, access: Access, messageId: string, body: string): Promise<void> {
  const row = await editable(ctx, access, messageId);
  if (row.authorId !== ctx.viewer.id) throw new UserError("You can only edit your own messages.");
  if (access.channel.archivedAt) throw new UserError("This channel is archived, so its messages cannot be changed.");
  const readers = await channelReaders(ctx.db, access.channel);
  const found = findMentions(body, readers);
  await ctx.db.transaction(async (tx) => {
    await bump(tx, messageId, {
      body,
      editedAt: new Date(),
      mentionedIds: found.userIds,
      mentionsChannel: found.channel && ctx.can(P.mentionAll) && !isDirect(access.channel.kind),
      linkPreview: null,
    });
  });
  void attachPreview(messageId, access.channel.id, body);
}

/** Your own message, or anyone's for a chat admin (logged). The text and files go; a "deleted" line stays so threads still make sense. */
export async function deleteMessage(ctx: ModuleContext, access: Access, messageId: string): Promise<void> {
  const row = await editable(ctx, access, messageId);
  const own = row.authorId === ctx.viewer.id;
  if (!own && !ctx.can(P.manage)) throw new UserError("You can only delete your own messages. Ask a chat admin to remove someone else's.");
  await ctx.db.transaction(async (tx) => {
    await bump(tx, messageId, { deletedAt: new Date(), body: "", attachments: [], linkPreview: null, pinnedAt: null, pinnedBy: null, mentionedIds: [], mentionsChannel: false });
    await tx.delete(chatReactions).where(eq(chatReactions.messageId, messageId));
    if (row.parentId) {
      await tx
        .update(chatMessages)
        .set({ replyCount: sql`greatest(${chatMessages.replyCount} - 1, 0)`, seq: sql`nextval('chat_seq')` })
        .where(eq(chatMessages.id, row.parentId));
    }
    if (!own) {
      await audit(
        {
          actor: userActor(ctx.viewer),
          action: "chat.message_removed",
          module: MODULE_ID,
          target: { type: "chat_message", id: messageId },
          summary: `${ctx.viewer.name} removed a message by ${row.authorName} in ${await conversationLabel(tx, access.channel, ctx.viewer.id)}.`,
        },
        tx,
      );
    }
  });
  for (const a of row.attachments) await deleteStoredFile(a.fileId).catch(() => {});
}

export async function toggleReaction(ctx: ModuleContext, access: Access, messageId: string, emoji: string): Promise<void> {
  await editable(ctx, access, messageId);
  if (!access.canPost) throw new UserError(access.channel.archivedAt ? "This channel is archived." : "Join the conversation to react.");
  await ctx.db.transaction(async (tx) => {
    const removed = await tx
      .delete(chatReactions)
      .where(and(eq(chatReactions.messageId, messageId), eq(chatReactions.userId, ctx.viewer.id), eq(chatReactions.emoji, emoji)))
      .returning({ emoji: chatReactions.emoji });
    if (removed.length === 0) await tx.insert(chatReactions).values({ messageId, userId: ctx.viewer.id, emoji }).onConflictDoNothing();
    await bump(tx, messageId);
  });
}

export async function setPinned(ctx: ModuleContext, access: Access, messageId: string, pinned: boolean): Promise<void> {
  await editable(ctx, access, messageId);
  if (!access.canPost) throw new UserError("Only people in the conversation can pin messages.");
  await ctx.db.transaction(async (tx) => {
    await bump(tx, messageId, pinned ? { pinnedAt: new Date(), pinnedBy: ctx.viewer.id } : { pinnedAt: null, pinnedBy: null });
  });
}

/** Moves the person's read marker forward (never back) and clears chat notifications for the conversation. */
export async function markRead(ctx: ModuleContext, channelId: string, cseq: number): Promise<void> {
  const moved = await ctx.db
    .update(chatMembers)
    .set({ lastReadCseq: cseq })
    .where(and(eq(chatMembers.channelId, channelId), eq(chatMembers.userId, ctx.viewer.id), sql`${chatMembers.lastReadCseq} < ${cseq}`))
    .returning({ channelId: chatMembers.channelId });
  await ctx.db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, ctx.viewer.id), isNull(notifications.readAt), like(notifications.url, `/m/${MODULE_ID}/${channelId}%`), like(notifications.kind, "chat.%")));
  if (moved.length) await publish(ctx.db, { k: "r", c: channelId, u: [ctx.viewer.id] });
}
