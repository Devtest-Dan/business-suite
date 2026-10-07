import "server-only";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { audit, userActor } from "@/lib/audit";
import type { Db, DbTx } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import type { ModuleContext, SearchHit } from "@/lib/modules/contract";
import { notify, usersWithPermission } from "@/lib/notifications";
import { announcementPosts, announcementReads } from "./schema";
import type { AnnouncementInput } from "./schemas";

export const MODULE_ID = "announcements";
export const P = {
  access: "announcements.access",
  post: "announcements.post",
  pin: "announcements.pin",
  receipts: "announcements.receipts",
  import: "announcements.import",
} as const;

export type Post = typeof announcementPosts.$inferSelect;
export type PostWithRead = Omit<Post, "search"> & { readAt: Date | null };

const postColumns = {
  id: announcementPosts.id,
  title: announcementPosts.title,
  body: announcementPosts.body,
  authorId: announcementPosts.authorId,
  authorName: announcementPosts.authorName,
  pinned: announcementPosts.pinned,
  pinnedAt: announcementPosts.pinnedAt,
  createdAt: announcementPosts.createdAt,
  updatedAt: announcementPosts.updatedAt,
  sourceKey: announcementPosts.sourceKey,
};

/** Pinned first (newest pin first), then newest. */
export async function listPosts(ctx: ModuleContext, limit = 50): Promise<PostWithRead[]> {
  return ctx.db
    .select({ ...postColumns, readAt: announcementReads.readAt })
    .from(announcementPosts)
    .leftJoin(announcementReads, and(eq(announcementReads.postId, announcementPosts.id), eq(announcementReads.userId, ctx.viewer.id)))
    .orderBy(desc(announcementPosts.pinned), desc(announcementPosts.pinnedAt), desc(announcementPosts.createdAt))
    .limit(limit);
}

export async function getPost(ctx: ModuleContext, id: string): Promise<PostWithRead | null> {
  const [row] = await ctx.db
    .select({ ...postColumns, readAt: announcementReads.readAt })
    .from(announcementPosts)
    .leftJoin(announcementReads, and(eq(announcementReads.postId, announcementPosts.id), eq(announcementReads.userId, ctx.viewer.id)))
    .where(eq(announcementPosts.id, id));
  return row ?? null;
}

export async function unreadPosts(ctx: ModuleContext, limit = 5): Promise<{ id: string; title: string }[]> {
  return ctx.db
    .select({ id: announcementPosts.id, title: announcementPosts.title })
    .from(announcementPosts)
    .leftJoin(announcementReads, and(eq(announcementReads.postId, announcementPosts.id), eq(announcementReads.userId, ctx.viewer.id)))
    .where(isNull(announcementReads.readAt))
    .orderBy(desc(announcementPosts.createdAt))
    .limit(limit);
}

export async function unreadCount(ctx: ModuleContext): Promise<number> {
  const [row] = await ctx.db
    .select({ n: count() })
    .from(announcementPosts)
    .leftJoin(announcementReads, and(eq(announcementReads.postId, announcementPosts.id), eq(announcementReads.userId, ctx.viewer.id)))
    .where(isNull(announcementReads.readAt));
  return row?.n ?? 0;
}

/** Writes one post and its audit entry. Returns the post and a function that sends the notifications. */
export async function createPost(
  tx: Db | DbTx,
  input: AnnouncementInput,
  author: { id: string; name: string },
  options: { sourceKey?: string; via?: "ai" | "import" | "user" } = {},
): Promise<{ post: Post; announce: () => Promise<void> }> {
  const now = new Date();
  const [post] = await tx
    .insert(announcementPosts)
    .values({
      title: input.title,
      body: input.body,
      authorId: author.id,
      authorName: author.name,
      pinned: input.pinned,
      pinnedAt: input.pinned ? now : null,
      sourceKey: options.sourceKey ?? null,
    })
    .returning();
  // The author has read their own post.
  await tx.insert(announcementReads).values({ postId: post.id, userId: author.id }).onConflictDoNothing();
  await audit(
    {
      actor: userActor(author),
      action: "announcements.posted",
      module: MODULE_ID,
      target: { type: "announcement", id: post.id },
      summary: `${author.name} posted "${post.title}"${options.via === "ai" ? " (drafted by the assistant, approved)" : options.via === "import" ? " (imported, approved)" : ""}.`,
      visibility: "everyone",
    },
    tx,
  );
  const announce = async () => {
    const recipients = (await usersWithPermission(P.access)).filter((id) => id !== author.id);
    await notify(recipients, {
      kind: "announcements.posted",
      title: `New announcement: ${post.title}`,
      body: post.body.slice(0, 140),
      url: `/m/${MODULE_ID}/${post.id}`,
    });
  };
  return { post, announce };
}

export async function setPinned(ctx: ModuleContext, id: string, pinned: boolean): Promise<Post | null> {
  const [post] = await ctx.db
    .update(announcementPosts)
    .set({ pinned, pinnedAt: pinned ? new Date() : null, updatedAt: new Date() })
    .where(eq(announcementPosts.id, id))
    .returning();
  if (post) {
    await audit({
      actor: userActor(ctx.viewer),
      action: pinned ? "announcements.pinned" : "announcements.unpinned",
      module: MODULE_ID,
      target: { type: "announcement", id },
      summary: `${ctx.viewer.name} ${pinned ? "pinned" : "unpinned"} "${post.title}".`,
    });
  }
  return post ?? null;
}

export async function markRead(ctx: ModuleContext, id: string): Promise<void> {
  await ctx.db.insert(announcementReads).values({ postId: id, userId: ctx.viewer.id }).onConflictDoNothing();
}

/** Who has read a post, and who has not yet (people who can see announcements). */
export async function receipts(ctx: ModuleContext, id: string): Promise<{ read: { name: string; at: Date }[]; unread: string[] }> {
  const audience = await usersWithPermission(P.access);
  if (audience.length === 0) return { read: [], unread: [] };
  const people = await ctx.db
    .select({ id: users.id, name: users.name, at: announcementReads.readAt })
    .from(users)
    .leftJoin(announcementReads, and(eq(announcementReads.userId, users.id), eq(announcementReads.postId, id)))
    .where(inArray(users.id, audience))
    .orderBy(users.name);
  return {
    read: people.filter((p) => p.at).map((p) => ({ name: p.name, at: p.at as Date })),
    unread: people.filter((p) => !p.at).map((p) => p.name),
  };
}

export async function searchPosts(ctx: ModuleContext, query: string, limit: number): Promise<SearchHit[]> {
  const q = sql`websearch_to_tsquery('simple', ${query})`;
  const rows = await ctx.db
    .select({
      id: announcementPosts.id,
      title: announcementPosts.title,
      createdAt: announcementPosts.createdAt,
      rank: sql<number>`ts_rank(${announcementPosts.search}, ${q})`,
      snippet: sql<string>`ts_headline('simple', ${announcementPosts.body}, ${q}, 'MaxWords=24, MinWords=8, StartSel=«, StopSel=»')`,
    })
    .from(announcementPosts)
    .where(sql`${announcementPosts.search} @@ ${q}`)
    .orderBy(sql`4 desc`)
    .limit(limit);
  return rows.map((r) => ({ title: r.title, snippet: r.snippet, url: `/m/${MODULE_ID}/${r.id}`, rank: Number(r.rank), at: r.createdAt }));
}
