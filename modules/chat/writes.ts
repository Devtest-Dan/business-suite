import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { audit } from "@/lib/audit";
import { users } from "@/lib/db/schema";
import { UserError } from "@/lib/errors";
import type { ApplyContext, ApplyResult } from "@/lib/modules/contract";
import { permissionsFor } from "@/lib/permissions";
import { computeAccess, findChannel, messageRow, MODULE_ID, P } from "./data";
import { insertMessage } from "./messages";
import { publish } from "./realtime";
import { chatChannels, chatMembers } from "./schema";
import type { ImportMessageInput, PostMessageInput } from "./schemas";
import { slackTsToDate } from "./text";

/**
 * Applies one approved "post a message" from the assistant. The person who
 * asked is the author, so the message goes only where they could post it
 * themselves; otherwise the record fails with a plain reason.
 */
export async function applyPostMessage(ctx: ApplyContext, input: PostMessageInput): Promise<ApplyResult> {
  const author = ctx.requestedBy ?? ctx.approver;
  const held = await permissionsFor(author.role);
  const channel = await findChannel(ctx.tx, author, input.channel);
  if (!channel) throw new UserError(`${author.name} cannot see a channel called “${input.channel}”. Check the name.`);
  const [member] = await ctx.tx.select().from(chatMembers).where(and(eq(chatMembers.channelId, channel.id), eq(chatMembers.userId, author.id)));
  const access = computeAccess({ viewer: author, can: (p) => held.has(p) }, channel, member ?? null);
  if (!access.canPost) {
    throw new UserError(channel.archivedAt ? `#${channel.name} is archived.` : `${author.name} is not in ${channel.name ? `#${channel.name}` : "that conversation"}, so the message cannot be posted as them.`);
  }
  if (input.threadId) {
    const root = await messageRow(ctx.tx, input.threadId);
    if (!root || root.channelId !== channel.id) throw new UserError("The thread to reply in is not in that channel.");
  }
  const posted = await insertMessage(ctx.tx, {
    channel,
    author,
    body: input.text,
    parentId: input.threadId ?? null,
    via: "ai",
    sourceKey: `${ctx.approvalId}:${ctx.dedupeKey}`,
    mayMentionAll: held.has(P.mentionAll),
  });
  return { targetId: posted.id, summary: `Posted in ${channel.name ? `#${channel.name}` : "a direct conversation"} as ${author.name}`, after: posted.after };
}

/**
 * Applies one message from a Slack export: makes its channel the first time
 * (keyed by the Slack channel id), adds the members whose emails matched, and
 * writes the message with its original time. The ledger key and the
 * message's source key both stop it being written twice.
 */
export async function applyImportMessage(ctx: ApplyContext, input: ImportMessageInput): Promise<ApplyResult> {
  const importKey = `slack:${input.slackChannelId}`;
  let [channel] = await ctx.tx.select().from(chatChannels).where(eq(chatChannels.importKey, importKey));
  if (!channel) {
    let name = input.channelName;
    for (let n = 2; ; n++) {
      const [taken] = await ctx.tx.select({ id: chatChannels.id }).from(chatChannels).where(eq(chatChannels.name, name));
      if (!taken) break;
      name = `${input.channelName.slice(0, 34)}-slack${n > 2 ? `-${n}` : ""}`;
    }
    [channel] = await ctx.tx
      .insert(chatChannels)
      .values({
        kind: input.channelKind,
        name,
        topic: input.channelTopic,
        importKey,
        createdBy: ctx.approver.id,
        archivedAt: input.channelArchived ? new Date() : null,
      })
      .returning();
    await audit(
      {
        actor: { id: ctx.approver.id, name: ctx.approver.name, kind: "user" },
        action: "chat.channel_imported",
        module: MODULE_ID,
        target: { type: "chat_channel", id: channel.id },
        summary: `#${channel.name} was imported from Slack (approved by ${ctx.approver.name}).`,
        visibility: input.channelKind === "public" ? "everyone" : "admins",
      },
      ctx.tx,
    );
  }
  const emails = [...new Set([...input.memberEmails, ...(input.authorEmail ? [input.authorEmail] : [])].map((e) => e.toLowerCase()))];
  const people = emails.length ? await ctx.tx.select({ id: users.id }).from(users).where(and(inArray(users.email, emails), eq(users.status, "active"))) : [];
  if (people.length) {
    const added = await ctx.tx
      .insert(chatMembers)
      .values(people.map((p) => ({ channelId: channel.id, userId: p.id })))
      .onConflictDoNothing()
      .returning({ userId: chatMembers.userId });
    if (added.length) await publish(ctx.tx, { k: "c", c: channel.id, u: added.map((a) => a.userId) });
  }
  const [author] = input.authorEmail ? await ctx.tx.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, input.authorEmail.toLowerCase())) : [];
  let parentId: string | null = null;
  if (input.threadTs) {
    const [parent] = await ctx.tx.execute<{ id: string }>(sql`select id from chat_messages where source_key = ${`slack:${input.slackChannelId}:${input.threadTs}`}`);
    parentId = parent?.id ?? null;
  }
  const posted = await insertMessage(ctx.tx, {
    channel,
    author: author ? { id: author.id, name: author.name } : { id: null, name: input.authorName },
    body: input.text,
    parentId,
    via: "import",
    sourceKey: `slack:${input.slackChannelId}:${input.ts}`,
    mayMentionAll: false,
    createdAt: slackTsToDate(input.ts),
  });
  return { targetId: posted.id, summary: posted.existed ? `Already in #${channel.name}` : `Imported into #${channel.name}` };
}
