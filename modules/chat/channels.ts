import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { audit, userActor } from "@/lib/audit";
import type { Db, DbTx } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { UserError } from "@/lib/errors";
import type { ModuleContext, Viewer } from "@/lib/modules/contract";
import { isDirect, MODULE_ID, P, visiblePeople, type Access, type Channel, type NotifyLevel } from "./data";
import { publish } from "./realtime";
import { chatChannels, chatMembers, chatPeople } from "./schema";
import { MAX_GROUP_DM } from "./schemas";
import { dmKey } from "./text";

type Conn = Db | DbTx;

async function nameTaken(db: Conn, name: string, exceptId?: string): Promise<boolean> {
  const rows = await db
    .select({ id: chatChannels.id })
    .from(chatChannels)
    .where(and(eq(chatChannels.name, name), exceptId ? sql`${chatChannels.id} <> ${exceptId}` : undefined));
  return rows.length > 0;
}

export async function createChannel(
  db: Conn,
  creator: Viewer,
  input: { name: string; topic: string; private: boolean; isDefault?: boolean },
): Promise<Channel> {
  if (await nameTaken(db, input.name)) throw new UserError(`There is already a channel called #${input.name}. Pick another name, or open that one from Browse channels.`);
  const channel = await (db as Db).transaction(async (tx) => {
    const [c] = await tx
      .insert(chatChannels)
      .values({ kind: input.private ? "private" : "public", name: input.name, topic: input.topic, createdBy: creator.id, isDefault: input.isDefault ?? false })
      .returning();
    await tx.insert(chatMembers).values({ channelId: c.id, userId: creator.id });
    await audit(
      {
        actor: userActor(creator),
        action: "chat.channel_created",
        module: MODULE_ID,
        target: { type: "chat_channel", id: c.id },
        summary: `${creator.name} created the ${input.private ? "private" : "public"} channel #${c.name}.`,
        visibility: input.private ? "admins" : "everyone",
      },
      tx,
    );
    await publish(tx, { k: "c", c: c.id, u: [creator.id] });
    return c;
  });
  return channel;
}

/** On the first visit to chat, everyone except guests joins the default channels (they may leave later). */
export async function ensureDefaultMemberships(ctx: ModuleContext): Promise<void> {
  if (ctx.viewer.role === "guest") return;
  const first = await ctx.db.insert(chatPeople).values({ userId: ctx.viewer.id }).onConflictDoNothing().returning({ userId: chatPeople.userId });
  if (first.length === 0) return;
  const defaults = await ctx.db
    .select({ id: chatChannels.id })
    .from(chatChannels)
    .where(and(eq(chatChannels.isDefault, true), eq(chatChannels.kind, "public"), sql`${chatChannels.archivedAt} is null`));
  if (defaults.length === 0) return;
  // New arrivals start with everything already there marked as read.
  await ctx.db
    .insert(chatMembers)
    .values(defaults.map((d) => ({ channelId: d.id, userId: ctx.viewer.id, lastReadCseq: sql`coalesce((select max(cseq) from chat_messages where channel_id = ${d.id}), 0)` })))
    .onConflictDoNothing();
}

export async function joinChannel(ctx: ModuleContext, access: Access): Promise<void> {
  if (access.member) return;
  if (!access.canJoin) throw new UserError(access.channel.archivedAt ? "This channel is archived, so nobody can join it." : "This is not a public channel. Ask someone in it to add you.");
  await ctx.db.transaction(async (tx) => {
    await tx
      .insert(chatMembers)
      .values({ channelId: access.channel.id, userId: ctx.viewer.id, lastReadCseq: sql`coalesce((select max(cseq) from chat_messages where channel_id = ${access.channel.id}), 0)` })
      .onConflictDoNothing();
    await publish(tx, { k: "c", c: access.channel.id, u: [ctx.viewer.id] });
  });
}

export async function leaveChannel(ctx: ModuleContext, access: Access): Promise<void> {
  if (!access.member) return;
  if (isDirect(access.channel.kind)) throw new UserError("You cannot leave a direct conversation. Set its notifications to “Nothing” instead.");
  await ctx.db.transaction(async (tx) => {
    await tx.delete(chatMembers).where(and(eq(chatMembers.channelId, access.channel.id), eq(chatMembers.userId, ctx.viewer.id)));
    await publish(tx, { k: "c", c: access.channel.id, u: [ctx.viewer.id] });
  });
}

/** Adds people to a channel. Anyone in it may add teammates; adding a guest takes the chat admin permission. */
export async function addMembers(ctx: ModuleContext, access: Access, userIds: string[]): Promise<number> {
  if (isDirect(access.channel.kind)) throw new UserError("Direct conversations keep the people they started with. Start a new one with everyone you need.");
  if (!access.member && !ctx.can(P.manage)) throw new UserError("Only people in the channel can add others to it.");
  if (access.channel.archivedAt) throw new UserError("This channel is archived. Unarchive it first.");
  const wanted = [...new Set(userIds)];
  if (wanted.length === 0) throw new UserError("Pick at least one person to add.");
  const people = await ctx.db.select({ id: users.id, role: users.role, status: users.status }).from(users).where(inArray(users.id, wanted));
  if (people.length !== wanted.length || people.some((p) => p.status !== "active")) throw new UserError("One of those people is not an active account any more. Reload the page and try again.");
  if (people.some((p) => p.role === "guest") && !ctx.can(P.manage)) throw new UserError("Only a chat admin can add a guest to a channel.");
  const added = await ctx.db.transaction(async (tx) => {
    const rows = await tx
      .insert(chatMembers)
      .values(wanted.map((userId) => ({ channelId: access.channel.id, userId, notify: "mentions" as NotifyLevel })))
      .onConflictDoNothing()
      .returning({ userId: chatMembers.userId });
    if (rows.length) {
      await audit(
        {
          actor: userActor(ctx.viewer),
          action: "chat.members_added",
          module: MODULE_ID,
          target: { type: "chat_channel", id: access.channel.id },
          summary: `${ctx.viewer.name} added ${rows.length} ${rows.length === 1 ? "person" : "people"} to #${access.channel.name}.`,
          data: { userIds: rows.map((r) => r.userId) },
        },
        tx,
      );
      await publish(tx, { k: "c", c: access.channel.id, u: rows.map((r) => r.userId) });
    }
    return rows.length;
  });
  return added;
}

export async function removeMember(ctx: ModuleContext, access: Access, userId: string): Promise<void> {
  if (!access.canManage) throw new UserError("Only the person who made this channel, or a chat admin, can remove people from it.");
  if (userId === ctx.viewer.id) throw new UserError("Use “Leave channel” to leave it yourself.");
  await ctx.db.transaction(async (tx) => {
    const gone = await tx.delete(chatMembers).where(and(eq(chatMembers.channelId, access.channel.id), eq(chatMembers.userId, userId))).returning({ userId: chatMembers.userId });
    if (gone.length === 0) return;
    await audit(
      {
        actor: userActor(ctx.viewer),
        action: "chat.member_removed",
        module: MODULE_ID,
        target: { type: "chat_channel", id: access.channel.id },
        summary: `${ctx.viewer.name} removed someone from #${access.channel.name}.`,
        data: { userId },
      },
      tx,
    );
    await publish(tx, { k: "c", c: access.channel.id, u: [userId] });
  });
}

export async function setTopic(ctx: ModuleContext, access: Access, topic: string): Promise<void> {
  if (!access.member) throw new UserError("Join the channel to change its topic.");
  if (access.channel.archivedAt) throw new UserError("This channel is archived. Unarchive it first.");
  await ctx.db.transaction(async (tx) => {
    await tx.update(chatChannels).set({ topic }).where(eq(chatChannels.id, access.channel.id));
    await publish(tx, { k: "c", c: access.channel.id });
  });
}

export async function renameChannel(ctx: ModuleContext, access: Access, name: string): Promise<void> {
  if (!access.canManage) throw new UserError("Only the person who made this channel, or a chat admin, can rename it.");
  if (await nameTaken(ctx.db, name, access.channel.id)) throw new UserError(`There is already a channel called #${name}. Pick another name.`);
  await ctx.db.transaction(async (tx) => {
    await tx.update(chatChannels).set({ name }).where(eq(chatChannels.id, access.channel.id));
    await audit(
      {
        actor: userActor(ctx.viewer),
        action: "chat.channel_renamed",
        module: MODULE_ID,
        target: { type: "chat_channel", id: access.channel.id },
        summary: `${ctx.viewer.name} renamed #${access.channel.name} to #${name}.`,
        visibility: access.channel.kind === "public" ? "everyone" : "admins",
      },
      tx,
    );
    await publish(tx, { k: "c", c: access.channel.id });
  });
}

export async function setArchived(ctx: ModuleContext, access: Access, archived: boolean): Promise<void> {
  if (!access.canManage) throw new UserError("Only the person who made this channel, or a chat admin, can archive it.");
  if (archived && access.channel.isDefault) throw new UserError("This is the channel everyone joins first, so it cannot be archived. Make another channel the default first.");
  await ctx.db.transaction(async (tx) => {
    await tx.update(chatChannels).set({ archivedAt: archived ? new Date() : null }).where(eq(chatChannels.id, access.channel.id));
    await audit(
      {
        actor: userActor(ctx.viewer),
        action: archived ? "chat.channel_archived" : "chat.channel_unarchived",
        module: MODULE_ID,
        target: { type: "chat_channel", id: access.channel.id },
        summary: `${ctx.viewer.name} ${archived ? "archived" : "unarchived"} #${access.channel.name}.`,
        visibility: access.channel.kind === "public" ? "everyone" : "admins",
      },
      tx,
    );
    await publish(tx, { k: "c", c: access.channel.id });
  });
}

export async function setNotify(ctx: ModuleContext, access: Access, level: NotifyLevel): Promise<void> {
  if (!access.member) throw new UserError("Join the conversation first; then choose how it notifies you.");
  await ctx.db.update(chatMembers).set({ notify: level }).where(and(eq(chatMembers.channelId, access.channel.id), eq(chatMembers.userId, ctx.viewer.id)));
}

/**
 * Opens (or finds) the direct conversation between the viewer and these
 * people: one other person is a direct message, more is a small group, none
 * is notes to self. The same people always land in the same conversation.
 */
export async function openDirect(ctx: ModuleContext, otherIds: string[]): Promise<string> {
  const others = [...new Set(otherIds.filter((id) => id !== ctx.viewer.id))];
  if (others.length + 1 > MAX_GROUP_DM) throw new UserError(`A group conversation can have at most ${MAX_GROUP_DM} people. Make a private channel for more.`);
  const allowed = new Set((await visiblePeople(ctx.db, ctx.viewer)).map((p) => p.id));
  if (others.some((id) => !allowed.has(id))) throw new UserError("You can only message people you share a conversation with. Ask an admin to add you to a channel with them.");
  const everyone = [ctx.viewer.id, ...others];
  const key = dmKey(everyone);
  const [existing] = await ctx.db.select({ id: chatChannels.id }).from(chatChannels).where(eq(chatChannels.dmKey, key));
  if (existing) return existing.id;
  return ctx.db.transaction(async (tx) => {
    const [c] = await tx
      .insert(chatChannels)
      .values({ kind: others.length > 1 ? "group" : "dm", dmKey: key, createdBy: ctx.viewer.id })
      .onConflictDoNothing({ target: chatChannels.dmKey })
      .returning({ id: chatChannels.id });
    if (!c) {
      const [again] = await tx.select({ id: chatChannels.id }).from(chatChannels).where(eq(chatChannels.dmKey, key));
      return again.id;
    }
    await tx.insert(chatMembers).values(everyone.map((userId) => ({ channelId: c.id, userId, notify: "all" as NotifyLevel })));
    await publish(tx, { k: "c", c: c.id, u: everyone });
    return c.id;
  });
}
