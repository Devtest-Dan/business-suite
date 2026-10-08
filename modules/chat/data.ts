import "server-only";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db, DbTx } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { UserError } from "@/lib/errors";
import type { ModuleContext, SearchHit, Viewer } from "@/lib/modules/contract";
import { chatChannels, chatMembers, chatMessages, chatReactions, chatSettings, type ChatAttachment, type ChatLinkPreview } from "./schema";
import type { Person } from "./text";

export const MODULE_ID = "chat";
export const P = {
  access: "chat.access",
  post: "chat.post",
  create: "chat.create_channel",
  mentionAll: "chat.mention_all",
  manage: "chat.manage",
  import: "chat.import",
} as const;

export type Channel = typeof chatChannels.$inferSelect;
export type Member = typeof chatMembers.$inferSelect;
export type ChannelKind = Channel["kind"];
export type NotifyLevel = Member["notify"];
type Conn = Db | DbTx;

/** Everything the pages need to know about one conversation for one person. */
export interface Access {
  channel: Channel;
  member: Member | null;
  canRead: boolean;
  canPost: boolean;
  /** Rename, archive, remove people: whoever made it, or a chat admin. Never for direct messages. */
  canManage: boolean;
  /** A public channel the person can read and join. */
  canJoin: boolean;
}

export function isDirect(kind: ChannelKind): boolean {
  return kind === "dm" || kind === "group";
}

export function computeAccess(ctx: Pick<ModuleContext, "viewer" | "can">, channel: Channel, member: Member | null): Access {
  const guest = ctx.viewer.role === "guest";
  const canRead = Boolean(member) || (channel.kind === "public" && !guest);
  const canPost = Boolean(member) && !channel.archivedAt && ctx.can(P.post);
  const canManage = !isDirect(channel.kind) && (ctx.can(P.manage) || (channel.createdBy === ctx.viewer.id && Boolean(member)));
  return { channel, member, canRead, canPost, canManage, canJoin: !member && channel.kind === "public" && !guest && !channel.archivedAt };
}

export async function getAccess(ctx: ModuleContext, channelId: string): Promise<Access | null> {
  const [row] = await ctx.db
    .select({ channel: chatChannels, member: chatMembers })
    .from(chatChannels)
    .leftJoin(chatMembers, and(eq(chatMembers.channelId, chatChannels.id), eq(chatMembers.userId, ctx.viewer.id)))
    .where(eq(chatChannels.id, channelId));
  if (!row) return null;
  const access = computeAccess(ctx, row.channel, row.member);
  return access.canRead ? access : null;
}

/** Like getAccess, but throws a plain message when the person cannot read it. */
export async function requireAccess(ctx: ModuleContext, channelId: string): Promise<Access> {
  const access = await getAccess(ctx, channelId);
  if (!access) throw new UserError("This conversation does not exist, or you are not in it. Ask someone in it to add you.");
  return access;
}

/** SQL: the viewer can read channel `c` (a member, or a public channel and not a guest). */
export function readableBy(viewer: Viewer, channelIdColumn = sql`${chatChannels.id}`, kindColumn = sql`${chatChannels.kind}`) {
  const member = sql`exists (select 1 from chat_members cm where cm.channel_id = ${channelIdColumn} and cm.user_id = ${viewer.id})`;
  return viewer.role === "guest" ? member : sql`(${member} or ${kindColumn} = 'public')`;
}

/** Channel ids the viewer can read right now (for the live stream). */
export async function readableChannelIds(db: Conn, viewer: Viewer): Promise<Set<string>> {
  const rows = await db.execute<{ id: string }>(sql`
    select c.id from chat_channels c
    where ${readableBy(viewer, sql`c.id`, sql`c.kind`)}`);
  return new Set(rows.map((r) => r.id));
}

// ── People ───────────────────────────────────────────────────────────────────

/**
 * The people this person may start a conversation with or mention: everyone
 * active, or for a guest only the people who share a conversation with them.
 */
export async function visiblePeople(db: Conn, viewer: Viewer): Promise<(Person & { role: string })[]> {
  if (viewer.role !== "guest") {
    return db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(eq(users.status, "active")).orderBy(asc(users.name));
  }
  const rows = await db.execute<{ id: string; name: string; role: string }>(sql`
    select distinct u.id, u.name, u.role from users u
    join chat_members other on other.user_id = u.id
    join chat_members mine on mine.channel_id = other.channel_id and mine.user_id = ${viewer.id}
    where u.status = 'active' order by u.name`);
  return [...rows];
}

/** People who can read a channel: its members, plus everyone but guests for a public channel. */
export async function channelReaders(db: Conn, channel: Pick<Channel, "id" | "kind">): Promise<Person[]> {
  if (channel.kind === "public") {
    const rows = await db.execute<{ id: string; name: string }>(sql`
      select u.id, u.name from users u
      where u.status = 'active' and (u.role <> 'guest' or exists (select 1 from chat_members m where m.channel_id = ${channel.id} and m.user_id = u.id))`);
    return [...rows];
  }
  return db
    .select({ id: users.id, name: users.name })
    .from(chatMembers)
    .innerJoin(users, eq(users.id, chatMembers.userId))
    .where(and(eq(chatMembers.channelId, channel.id), eq(users.status, "active")));
}

export async function channelMembers(db: Conn, channelId: string): Promise<{ id: string; name: string; role: string; notify: NotifyLevel }[]> {
  return db
    .select({ id: users.id, name: users.name, role: users.role, notify: chatMembers.notify })
    .from(chatMembers)
    .innerJoin(users, eq(users.id, chatMembers.userId))
    .where(eq(chatMembers.channelId, channelId))
    .orderBy(asc(users.name));
}

// ── The sidebar ──────────────────────────────────────────────────────────────

export interface SidebarItem {
  id: string;
  kind: ChannelKind;
  /** "general" for a channel, the other people's names for a direct message. */
  label: string;
  topic: string;
  unread: number;
  mentions: number;
  notify: NotifyLevel;
  lastMessageAt: string | null;
}

export interface Sidebar {
  channels: SidebarItem[];
  direct: SidebarItem[];
}

/** The conversations this person is in, with unread and mention counts (top-level messages only for unread). */
export async function sidebar(db: Conn, viewer: Viewer): Promise<Sidebar> {
  const rows = await db.execute<{
    id: string;
    kind: ChannelKind;
    name: string | null;
    topic: string;
    archived_at: Date | null;
    last_message_at: Date | string | null;
    notify: NotifyLevel;
    unread: number;
    mentions: number;
    others: string[] | null;
  }>(sql`
    select c.id, c.kind, c.name, c.topic, c.archived_at, c.last_message_at, m.notify,
      (select count(*) from chat_messages x
        where x.channel_id = c.id and x.parent_id is null and x.deleted_at is null
          and x.cseq > m.last_read_cseq and x.author_id is distinct from ${viewer.id})::int as unread,
      (select count(*) from chat_messages x
        where x.channel_id = c.id and x.deleted_at is null and x.cseq > m.last_read_cseq
          and x.author_id is distinct from ${viewer.id}
          and (${viewer.id}::uuid = any(x.mentioned_ids) or x.mentions_channel or c.kind in ('dm', 'group')))::int as mentions,
      case when c.kind in ('dm', 'group') then
        (select array_agg(u.name order by u.name) from chat_members o join users u on u.id = o.user_id
          where o.channel_id = c.id and o.user_id <> ${viewer.id})
      end as others
    from chat_members m join chat_channels c on c.id = m.channel_id
    where m.user_id = ${viewer.id} and c.archived_at is null
    order by c.name nulls last, c.last_message_at desc nulls last`);
  const items = rows.map(
    (r): SidebarItem => ({
      id: r.id,
      kind: r.kind,
      label: isDirect(r.kind) ? directLabel(r.others) : (r.name ?? "channel"),
      topic: r.topic,
      unread: r.unread,
      mentions: r.mentions,
      notify: r.notify,
      lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
    }),
  );
  return {
    channels: items.filter((i) => !isDirect(i.kind)),
    direct: items.filter((i) => isDirect(i.kind)).sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "")),
  };
}

export function directLabel(others: string[] | null | undefined): string {
  if (!others || others.length === 0) return "You (notes to self)";
  return others.join(", ");
}

/** A conversation's title for headers and notifications: "#general", or the other people's names. */
export async function conversationLabel(db: Conn, channel: Pick<Channel, "id" | "kind" | "name">, viewerId: string): Promise<string> {
  if (!isDirect(channel.kind)) return `#${channel.name}`;
  const others = await db
    .select({ name: users.name })
    .from(chatMembers)
    .innerJoin(users, eq(users.id, chatMembers.userId))
    .where(and(eq(chatMembers.channelId, channel.id), ne(chatMembers.userId, viewerId)))
    .orderBy(asc(users.name));
  return directLabel(others.map((o) => o.name));
}

/** Public channels to browse (with whether the person is in them), and archived ones they can read. */
export async function browseChannels(db: Conn, viewer: Viewer) {
  const rows = await db.execute<{ id: string; name: string; kind: ChannelKind; topic: string; archived_at: Date | null; members: number; joined: boolean }>(sql`
    select c.id, c.name, c.kind, c.topic, c.archived_at,
      (select count(*) from chat_members m where m.channel_id = c.id)::int as members,
      exists (select 1 from chat_members m where m.channel_id = c.id and m.user_id = ${viewer.id}) as joined
    from chat_channels c
    where c.kind in ('public', 'private') and ${readableBy(viewer, sql`c.id`, sql`c.kind`)}
    order by c.archived_at nulls first, c.name`);
  return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, topic: r.topic, archived: Boolean(r.archived_at), members: r.members, joined: r.joined }));
}

// ── Messages ─────────────────────────────────────────────────────────────────

export interface ReactionView {
  emoji: string;
  count: number;
  mine: boolean;
  names: string[];
}

/** One message, as the browser receives it (dates as ISO strings). */
export interface MessageView {
  id: string;
  channelId: string;
  parentId: string | null;
  authorId: string | null;
  authorName: string;
  body: string;
  mentionedIds: string[];
  mentionsChannel: boolean;
  attachments: ChatAttachment[];
  linkPreview: ChatLinkPreview | null;
  replyCount: number;
  lastReplyAt: string | null;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  pinned: boolean;
  via: "user" | "ai" | "import";
  /** The name of the app that posted it through Chat's action (e.g. "Tasks"), if one did. */
  viaApp: string | null;
  cseq: number;
  seq: number;
  reactions: ReactionView[];
}

type MessageRow = typeof chatMessages.$inferSelect;

const messageColumns = {
  id: chatMessages.id,
  channelId: chatMessages.channelId,
  parentId: chatMessages.parentId,
  authorId: chatMessages.authorId,
  authorName: chatMessages.authorName,
  body: chatMessages.body,
  mentionedIds: chatMessages.mentionedIds,
  mentionsChannel: chatMessages.mentionsChannel,
  attachments: chatMessages.attachments,
  linkPreview: chatMessages.linkPreview,
  replyCount: chatMessages.replyCount,
  lastReplyAt: chatMessages.lastReplyAt,
  createdAt: chatMessages.createdAt,
  editedAt: chatMessages.editedAt,
  deletedAt: chatMessages.deletedAt,
  pinnedAt: chatMessages.pinnedAt,
  via: chatMessages.via,
  viaApp: chatMessages.viaApp,
  cseq: chatMessages.cseq,
  seq: chatMessages.seq,
};
type MessageSelect = Omit<MessageRow, "search" | "sourceKey" | "pinnedBy">;

async function withReactions(db: Conn, rows: MessageSelect[], viewerId: string): Promise<MessageView[]> {
  const ids = rows.map((r) => r.id);
  const reactions = ids.length
    ? await db
        .select({ messageId: chatReactions.messageId, emoji: chatReactions.emoji, userId: chatReactions.userId, name: users.name })
        .from(chatReactions)
        .innerJoin(users, eq(users.id, chatReactions.userId))
        .where(inArray(chatReactions.messageId, ids))
        .orderBy(asc(chatReactions.createdAt))
    : [];
  const byMessage = new Map<string, ReactionView[]>();
  for (const r of reactions) {
    const list = byMessage.get(r.messageId) ?? [];
    let entry = list.find((e) => e.emoji === r.emoji);
    if (!entry) {
      entry = { emoji: r.emoji, count: 0, mine: false, names: [] };
      list.push(entry);
    }
    entry.count += 1;
    entry.mine ||= r.userId === viewerId;
    entry.names.push(r.name);
    byMessage.set(r.messageId, list);
  }
  return rows.map((r) => toView(r, byMessage.get(r.id) ?? []));
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function toView(r: MessageSelect, reactions: ReactionView[]): MessageView {
  const deleted = Boolean(r.deletedAt);
  return {
    id: r.id,
    channelId: r.channelId,
    parentId: r.parentId,
    authorId: r.authorId,
    authorName: r.authorName,
    body: deleted ? "" : r.body,
    mentionedIds: deleted ? [] : r.mentionedIds,
    mentionsChannel: !deleted && r.mentionsChannel,
    attachments: deleted ? [] : r.attachments,
    linkPreview: deleted ? null : r.linkPreview,
    replyCount: r.replyCount,
    lastReplyAt: iso(r.lastReplyAt),
    createdAt: r.createdAt.toISOString(),
    editedAt: iso(r.editedAt),
    deleted,
    pinned: Boolean(r.pinnedAt) && !deleted,
    via: r.via,
    viaApp: r.viaApp,
    cseq: r.cseq,
    seq: r.seq,
    reactions: deleted ? [] : reactions,
  };
}

function scope(channelId: string, parentId: string | null) {
  // A thread is its first message plus every reply to it.
  return parentId
    ? and(eq(chatMessages.channelId, channelId), sql`(${chatMessages.id} = ${parentId} or ${chatMessages.parentId} = ${parentId})`)
    : and(eq(chatMessages.channelId, channelId), isNull(chatMessages.parentId));
}

/** The newest `limit` messages (oldest first), or those before `beforeCseq`. */
export async function listMessages(
  db: Conn,
  viewer: Viewer,
  channelId: string,
  options: { parentId?: string | null; beforeCseq?: number; limit?: number } = {},
): Promise<{ messages: MessageView[]; more: boolean }> {
  const limit = Math.min(options.limit ?? 50, 300);
  const rows = await db
    .select(messageColumns)
    .from(chatMessages)
    .where(and(scope(channelId, options.parentId ?? null), options.beforeCseq ? sql`${chatMessages.cseq} < ${options.beforeCseq}` : undefined))
    .orderBy(desc(chatMessages.cseq))
    .limit(limit + 1);
  const more = rows.length > limit;
  return { messages: await withReactions(db, rows.slice(0, limit).reverse(), viewer.id), more };
}

/** Every message in the scope that changed after `cursor` (new, edited, deleted, reacted, pinned, replied to). */
export async function changesSince(db: Conn, viewer: Viewer, channelId: string, parentId: string | null, cursor: number): Promise<MessageView[]> {
  const rows = await db
    .select(messageColumns)
    .from(chatMessages)
    .where(and(scope(channelId, parentId), sql`${chatMessages.seq} > ${cursor}`))
    .orderBy(asc(chatMessages.cseq))
    .limit(500);
  return withReactions(db, rows, viewer.id);
}

export async function getMessage(db: Conn, viewer: Viewer, messageId: string): Promise<MessageView | null> {
  const rows = await db.select(messageColumns).from(chatMessages).where(eq(chatMessages.id, messageId));
  if (!rows[0]) return null;
  return (await withReactions(db, rows, viewer.id))[0];
}

export async function messageRow(db: Conn, messageId: string): Promise<MessageRow | null> {
  const [row] = await db.select().from(chatMessages).where(eq(chatMessages.id, messageId));
  return row ?? null;
}

export async function pinnedMessages(db: Conn, viewer: Viewer, channelId: string): Promise<MessageView[]> {
  const rows = await db
    .select(messageColumns)
    .from(chatMessages)
    .where(and(eq(chatMessages.channelId, channelId), sql`${chatMessages.pinnedAt} is not null`, isNull(chatMessages.deletedAt)))
    .orderBy(desc(chatMessages.pinnedAt))
    .limit(100);
  return withReactions(db, rows, viewer.id);
}

/** How many top-level messages arrived after the person's last read (not their own). */
export async function unreadIn(db: Conn, viewerId: string, channelId: string, lastReadCseq: number): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from chat_messages
    where channel_id = ${channelId} and parent_id is null and deleted_at is null and cseq > ${lastReadCseq}
      and author_id is distinct from ${viewerId}`);
  return row?.n ?? 0;
}

// ── Search ───────────────────────────────────────────────────────────────────

export interface MessageHit {
  id: string;
  channelId: string;
  parentId: string | null;
  channelKind: ChannelKind;
  channelName: string | null;
  authorName: string;
  createdAt: Date;
  snippet: string;
  rank: number;
}

export async function searchMessages(db: Conn, viewer: Viewer, query: string, limit: number, channelId?: string): Promise<MessageHit[]> {
  const q = sql`websearch_to_tsquery('simple', ${query})`;
  const rows = await db.execute<{
    id: string;
    channel_id: string;
    parent_id: string | null;
    kind: ChannelKind;
    name: string | null;
    author_name: string;
    created_at: Date | string;
    snippet: string;
    rank: number;
  }>(sql`
    select m.id, m.channel_id, m.parent_id, c.kind, c.name, m.author_name, m.created_at,
      ts_headline('simple', m.body, ${q}, 'MaxWords=24, MinWords=8, StartSel=«, StopSel=»') as snippet,
      ts_rank(m.search, ${q}) as rank
    from chat_messages m join chat_channels c on c.id = m.channel_id
    where m.search @@ ${q} and m.deleted_at is null
      and ${readableBy(viewer, sql`c.id`, sql`c.kind`)}
      ${channelId ? sql`and m.channel_id = ${channelId}` : sql``}
    order by rank desc, m.created_at desc
    limit ${limit}`);
  return rows.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    parentId: r.parent_id,
    channelKind: r.kind,
    channelName: r.name,
    authorName: r.author_name,
    createdAt: new Date(r.created_at),
    snippet: r.snippet,
    rank: Number(r.rank),
  }));
}

export function messageUrl(m: { id: string; channelId: string; parentId: string | null }): string {
  return m.parentId ? `/m/${MODULE_ID}/${m.channelId}/thread/${m.parentId}?m=${m.id}` : `/m/${MODULE_ID}/${m.channelId}?m=${m.id}`;
}

export async function searchProvider(ctx: ModuleContext, query: string, limit: number): Promise<SearchHit[]> {
  const hits = await searchMessages(ctx.db, ctx.viewer, query, limit);
  return hits.map((h) => ({
    title: `${h.authorName} in ${isDirect(h.channelKind) ? "a direct message" : `#${h.channelName}`}`,
    snippet: h.snippet,
    url: messageUrl(h),
    rank: h.rank,
    at: h.createdAt,
  }));
}

// ── Settings ─────────────────────────────────────────────────────────────────

export async function previewHosts(db: Conn): Promise<string[]> {
  const [row] = await db.select().from(chatSettings).where(eq(chatSettings.id, 1));
  return row?.previewHosts ?? [];
}

/** Looks a channel up by id, "#name" or "name" among the ones the person can read. */
export async function findChannel(db: Conn, viewer: Viewer, ref: string): Promise<Channel | null> {
  const trimmed = ref.trim().replace(/^#/, "").toLowerCase();
  const isId = /^[0-9a-f-]{36}$/.test(trimmed);
  const rows = await db.execute<{ id: string }>(sql`
    select c.id from chat_channels c
    where ${isId ? sql`c.id = ${trimmed}::uuid` : sql`c.name = ${trimmed}`}
      and ${readableBy(viewer, sql`c.id`, sql`c.kind`)}
    limit 1`);
  if (!rows[0]) return null;
  const [channel] = await db.select().from(chatChannels).where(eq(chatChannels.id, rows[0].id));
  return channel ?? null;
}
