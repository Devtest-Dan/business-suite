"use server";

import { refresh } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { approve, canDecide, propose } from "@/lib/approvals/ledger";
import { db } from "@/lib/db/client";
import { approvals, users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { messageFor, UserError } from "@/lib/errors";
import { formAction, type FormState } from "@/lib/forms";
import { enabledModules } from "@/lib/modules/registry-access";
import { requireModule } from "@/lib/modules/server";
import { eq } from "drizzle-orm";
import {
  addMembers,
  createChannel,
  joinChannel,
  leaveChannel,
  openDirect,
  removeMember,
  renameChannel,
  setArchived,
  setNotify,
  setTopic,
} from "./channels";
import { findTarget, payloadFor, TARGETS, titleFrom, type CrossAppKind } from "./cross-app";
import { changesSince, conversationLabel, getMessage, listMessages, messageRow, MODULE_ID, P, requireAccess, sidebar, type MessageView, type Sidebar } from "./data";
import { attachmentsFor, deleteMessage, editMessage, insertMessage, markRead, setPinned, toggleReaction } from "./messages";
import { chatSettings } from "./schema";
import {
  addMembersForm,
  channelForm,
  channelIdInput,
  dmPeople,
  editInput,
  memberInput,
  messageIdInput,
  notifyForm,
  olderInput,
  previewHostsForm,
  reactInput,
  readInput,
  renameForm,
  sendInput,
  sinceInput,
  summariseForm,
  topicForm,
} from "./schemas";
import { planSlackImport } from "./slack-import";
import { firstUnreadAt, sinceDate, summarise, transcript } from "./summarise";

/** What the chat page's own calls get back: data, or a message to show. */
export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function run<T extends object>(body: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, ...(await body()) };
  } catch (error) {
    unstable_rethrow(error);
    if (!(error instanceof UserError) && !(error instanceof z.ZodError)) console.error("Chat action failed:", error);
    if (error instanceof z.ZodError) return { ok: false, error: error.issues[0]?.message ?? "That did not look right. Check it and try again." };
    return { ok: false, error: messageFor(error) };
  }
}

// ── Messages (called from the conversation view) ─────────────────────────────

export async function sendMessage(raw: z.input<typeof sendInput>): Promise<Result<{ message: MessageView }>> {
  return run(async () => {
    const input = sendInput.parse(raw);
    const ctx = await requireModule(MODULE_ID, P.post);
    let access = await requireAccess(ctx, input.channelId);
    if (!access.member && access.canJoin) {
      await joinChannel(ctx, access);
      access = await requireAccess(ctx, input.channelId);
    }
    if (!access.canPost) throw new UserError(access.channel.archivedAt ? "This channel is archived, so nothing new can be posted." : "You are not in this conversation.");
    const attachments = await attachmentsFor(ctx.db, ctx.viewer, input.fileIds);
    const posted = await ctx.db.transaction((tx) =>
      insertMessage(tx, {
        channel: access.channel,
        author: ctx.viewer,
        body: input.body,
        parentId: input.parentId,
        attachments,
        sourceKey: `web:${ctx.viewer.id}:${input.clientKey}`,
        mayMentionAll: ctx.can(P.mentionAll),
      }),
    );
    await posted.after();
    const message = await getMessage(ctx.db, ctx.viewer, posted.id);
    if (!message) throw new UserError("The message was sent but could not be shown. Reload the page.");
    return { message };
  });
}

export async function editMessageAction(raw: z.input<typeof editInput>): Promise<Result> {
  return run(async () => {
    const input = editInput.parse(raw);
    const ctx = await requireModule(MODULE_ID, P.access);
    const row = await messageRow(ctx.db, input.messageId);
    if (!row) throw new UserError("That message is not here any more.");
    await editMessage(ctx, await requireAccess(ctx, row.channelId), input.messageId, input.body);
    return {};
  });
}

export async function deleteMessageAction(raw: z.input<typeof messageIdInput>): Promise<Result> {
  return run(async () => {
    const input = messageIdInput.parse(raw);
    const ctx = await requireModule(MODULE_ID, P.access);
    const row = await messageRow(ctx.db, input.messageId);
    if (!row) throw new UserError("That message is not here any more.");
    await deleteMessage(ctx, await requireAccess(ctx, row.channelId), input.messageId);
    return {};
  });
}

export async function reactAction(raw: z.input<typeof reactInput>): Promise<Result> {
  return run(async () => {
    const input = reactInput.parse(raw);
    const ctx = await requireModule(MODULE_ID, P.post);
    const row = await messageRow(ctx.db, input.messageId);
    if (!row) throw new UserError("That message is not here any more.");
    await toggleReaction(ctx, await requireAccess(ctx, row.channelId), input.messageId, input.emoji);
    return {};
  });
}

export async function pinAction(raw: { messageId: string; pinned: boolean }): Promise<Result> {
  return run(async () => {
    const input = messageIdInput.extend({ pinned: z.boolean() }).parse(raw);
    const ctx = await requireModule(MODULE_ID, P.post);
    const row = await messageRow(ctx.db, input.messageId);
    if (!row) throw new UserError("That message is not here any more.");
    await setPinned(ctx, await requireAccess(ctx, row.channelId), input.messageId, input.pinned);
    return {};
  });
}

export async function fetchChanges(raw: z.input<typeof sinceInput>): Promise<Result<{ messages: MessageView[] }>> {
  return run(async () => {
    const input = sinceInput.parse(raw);
    const ctx = await requireModule(MODULE_ID, P.access);
    await requireAccess(ctx, input.channelId);
    return { messages: await changesSince(ctx.db, ctx.viewer, input.channelId, input.parentId, input.cursor) };
  });
}

export async function fetchOlder(raw: z.input<typeof olderInput>): Promise<Result<{ messages: MessageView[]; more: boolean }>> {
  return run(async () => {
    const input = olderInput.parse(raw);
    const ctx = await requireModule(MODULE_ID, P.access);
    await requireAccess(ctx, input.channelId);
    return listMessages(ctx.db, ctx.viewer, input.channelId, { parentId: input.parentId, beforeCseq: input.beforeCseq, limit: 50 });
  });
}

export async function markReadAction(raw: z.input<typeof readInput>): Promise<Result> {
  return run(async () => {
    const input = readInput.parse(raw);
    const ctx = await requireModule(MODULE_ID, P.access);
    await requireAccess(ctx, input.channelId);
    await markRead(ctx, input.channelId, input.cseq);
    return {};
  });
}

export async function sidebarAction(): Promise<Result<{ sidebar: Sidebar }>> {
  return run(async () => {
    const ctx = await requireModule(MODULE_ID, P.access);
    return { sidebar: await sidebar(ctx.db, ctx.viewer) };
  });
}

/**
 * "Create a task" / "Save to docs": proposes the other app's own write action
 * through the approvals ledger (keyed by the message, so it happens once). If
 * the person may decide it themselves, it is approved straight away.
 */
export async function crossAppAction(raw: { messageId: string; kind: CrossAppKind }): Promise<Result<{ message: string; url: string }>> {
  return run(async () => {
    const input = messageIdInput.extend({ kind: z.enum(["task", "doc"]) }).parse(raw);
    const ctx = await requireModule(MODULE_ID, P.access);
    const target = findTarget(input.kind, await enabledModules());
    const meta = TARGETS[input.kind];
    if (!target) throw new UserError(`The ${meta.appName} app is not switched on in this suite.`);
    const row = await messageRow(ctx.db, input.messageId);
    if (!row || row.deletedAt) throw new UserError("That message is not here any more.");
    const access = await requireAccess(ctx, row.channelId);
    const label = await conversationLabel(ctx.db, access.channel, ctx.viewer.id);
    const path = `/m/${MODULE_ID}/${row.channelId}${row.parentId ? `/thread/${row.parentId}` : ""}?m=${row.id}`;
    const payload = payloadFor(input.kind, {
      title: titleFrom(row.body, `Message from ${row.authorName}`),
      body: row.body,
      authorName: row.authorName,
      conversation: label,
      date: new Intl.DateTimeFormat("en-CA", { timeZone: ctx.business.timezone }).format(row.createdAt),
      path,
      url: `${env().publicUrl}${path}`,
    });
    const proposed = await propose({
      action: `${target.module.id}.${target.action.name}`,
      items: [payload],
      source: "user",
      requestedBy: ctx.viewer,
      title: `${meta.label} from a chat message`,
      note: `${ctx.viewer.name} asked from a message by ${row.authorName} in ${label}.`,
      keys: [`chat:${row.id}:${input.kind}`],
    });
    const approvalId = proposed.approvalId;
    if (!approvalId) {
      if (proposed.invalid[0]) throw new UserError(`The ${meta.appName} app did not accept it: ${proposed.invalid[0].error}`);
      return { message: `This message was already sent to ${meta.appName}.`, url: "/approvals" };
    }
    const [approval] = await db().select().from(approvals).where(eq(approvals.id, approvalId));
    if (await canDecide(ctx.viewer, approval)) {
      const report = await approve(approvalId, ctx.viewer);
      if (report.failedNow) throw new UserError(`The ${meta.appName} app could not save it: ${report.failures[0]?.error ?? "unknown reason"}`);
      return { message: `Done: saved in ${meta.appName}.`, url: `/approvals/${approvalId}` };
    }
    return { message: `Sent for approval. It appears in ${meta.appName} once someone approves it.`, url: `/approvals/${approvalId}` };
  });
}

// ── Forms ────────────────────────────────────────────────────────────────────

export const createChannelAction = formAction(channelForm, async (input) => {
  const ctx = await requireModule(MODULE_ID, P.create);
  if (ctx.viewer.role === "guest") throw new UserError("Guests cannot create channels.");
  const channel = await createChannel(ctx.db, ctx.viewer, { name: input.name, topic: input.topic, private: input.private });
  redirect(`/m/${MODULE_ID}/${channel.id}`);
});

export const topicAction = formAction(topicForm, async ({ channelId, topic }) => {
  const ctx = await requireModule(MODULE_ID, P.post);
  await setTopic(ctx, await requireAccess(ctx, channelId), topic);
  refresh();
  return { ok: topic ? "Topic saved." : "Topic cleared." };
});

export const renameAction = formAction(renameForm, async ({ channelId, name }) => {
  const ctx = await requireModule(MODULE_ID, P.access);
  await renameChannel(ctx, await requireAccess(ctx, channelId), name);
  refresh();
  return { ok: `Renamed to #${name}.` };
});

export const notifyAction = formAction(notifyForm, async ({ channelId, notify }) => {
  const ctx = await requireModule(MODULE_ID, P.access);
  await setNotify(ctx, await requireAccess(ctx, channelId), notify);
  refresh();
  return { ok: notify === "all" ? "You will be notified of every message." : notify === "mentions" ? "You will be notified when someone mentions you." : "This conversation will not notify you." };
});

export const addMembersAction = formAction(addMembersForm, async ({ channelId }, formData) => {
  const ctx = await requireModule(MODULE_ID, P.access);
  const ids = z.array(z.string().uuid()).parse(formData.getAll("user").map(String));
  const added = await addMembers(ctx, await requireAccess(ctx, channelId), ids);
  refresh();
  return { ok: added ? `Added ${added} ${added === 1 ? "person" : "people"}.` : "They were already in the channel." };
});

export async function removeMemberAction(raw: z.input<typeof memberInput>): Promise<void> {
  const input = memberInput.parse(raw);
  const ctx = await requireModule(MODULE_ID, P.access);
  await removeMember(ctx, await requireAccess(ctx, input.channelId), input.userId);
  refresh();
}

export async function joinAction(channelId: string): Promise<void> {
  const { channelId: id } = channelIdInput.parse({ channelId });
  const ctx = await requireModule(MODULE_ID, P.access);
  await joinChannel(ctx, await requireAccess(ctx, id));
  redirect(`/m/${MODULE_ID}/${id}`);
}

export async function leaveAction(channelId: string): Promise<void> {
  const { channelId: id } = channelIdInput.parse({ channelId });
  const ctx = await requireModule(MODULE_ID, P.access);
  await leaveChannel(ctx, await requireAccess(ctx, id));
  redirect(`/m/${MODULE_ID}`);
}

export async function archiveAction(channelId: string, archived: boolean): Promise<void> {
  const { channelId: id } = channelIdInput.parse({ channelId });
  const ctx = await requireModule(MODULE_ID, P.access);
  await setArchived(ctx, await requireAccess(ctx, id), z.boolean().parse(archived));
  refresh();
}

export const openDmAction = formAction(z.object({}), async (_input, formData) => {
  const ctx = await requireModule(MODULE_ID, P.access);
  const picked = dmPeople.safeParse(formData.getAll("user").map(String));
  if (!picked.success) throw new UserError(picked.error.issues[0]?.message ?? "Pick the people to message.");
  const id = await openDirect(ctx, picked.data);
  redirect(`/m/${MODULE_ID}/${id}`);
});

export const previewHostsAction = formAction(previewHostsForm, async ({ hosts }) => {
  const ctx = await requireModule(MODULE_ID, P.manage);
  await ctx.db
    .insert(chatSettings)
    .values({ id: 1, previewHosts: hosts })
    .onConflictDoUpdate({ target: chatSettings.id, set: { previewHosts: hosts, updatedAt: new Date() } });
  refresh();
  return { ok: hosts.length ? `Previews are on for ${hosts.length} ${hosts.length === 1 ? "site" : "sites"}.` : "Link previews are off." };
});

export const summariseAction = formAction(summariseForm, async ({ channelId, parentId, since }): Promise<FormState> => {
  const ctx = await requireModule(MODULE_ID, P.access);
  if (!ctx.can("assistant.use")) throw new UserError("Your role cannot use the AI assistant. Ask the owner.");
  const access = await requireAccess(ctx, channelId);
  const from = sinceDate(since, since === "unread" ? await firstUnreadAt(ctx, access) : null);
  const t = await transcript(ctx, access, { since: from, threadId: parentId });
  const text = await summarise(t, ctx.business.name);
  return { ok: `Summary of ${t.messages.length} message${t.messages.length === 1 ? "" : "s"}${t.truncated ? " (the latest ones)" : ""}.`, data: { summary: text } };
});

/** Slack export → approvals. One approval per 1,000 messages (the most one approval holds). */
export const importSlackAction = formAction(z.object({}), async (_input, formData) => {
  const ctx = await requireModule(MODULE_ID, P.import);
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) throw new UserError("Choose the Slack export ZIP file first.");
  if (file.size > 12 * 1024 * 1024) throw new UserError("The ZIP is larger than 12 MB. Export a shorter date range (or fewer channels) from Slack and import each part.");
  const people = await ctx.db.select({ email: users.email, name: users.name }).from(users).where(eq(users.status, "active"));
  let plan;
  try {
    plan = planSlackImport(new Uint8Array(await file.arrayBuffer()), people);
  } catch (error) {
    throw new UserError(error instanceof Error ? error.message : "The ZIP could not be read.");
  }
  if (plan.items.length === 0) throw new UserError("The export has no messages to import.");
  const ids: string[] = [];
  let duplicates = 0;
  for (let i = 0; i < plan.items.length; i += 1000) {
    const items = plan.items.slice(i, i + 1000);
    const part = plan.items.length > 1000 ? ` (part ${i / 1000 + 1} of ${Math.ceil(plan.items.length / 1000)})` : "";
    const result = await propose({
      action: `${MODULE_ID}.import_message`,
      source: "import",
      requestedBy: ctx.viewer,
      title: `Import ${items.length} Slack message${items.length === 1 ? "" : "s"}${part}`,
      note: `${ctx.viewer.name} uploaded a Slack export: ${plan.channels.length} channel${plan.channels.length === 1 ? "" : "s"}, ${plan.people.matched} ${plan.people.matched === 1 ? "person" : "people"} matched by email${plan.people.unmatched.length ? `; kept as names only: ${plan.people.unmatched.slice(0, 10).join(", ")}${plan.people.unmatched.length > 10 ? "…" : ""}` : ""}.`,
      items,
      keys: plan.keys.slice(i, i + 1000),
    });
    duplicates += result.duplicates;
    if (result.approvalId) ids.push(result.approvalId);
  }
  if (ids.length === 0) throw new UserError(duplicates ? "Every message in this export was imported (or proposed) before, so there is nothing new to approve." : "No message could be used.");
  redirect(ids.length === 1 ? `/approvals/${ids[0]}` : "/approvals");
});
