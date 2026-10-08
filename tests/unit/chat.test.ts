import { createServer, type Server } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approve, propose } from "@/lib/approvals/ledger";
import { moduleContext } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { notifications } from "@/lib/db/schema";
import type { Viewer } from "@/lib/modules/contract";
import { addMembers, createChannel, ensureDefaultMemberships, joinChannel, openDirect, setArchived } from "@/modules/chat/channels";
import { changesSince, getAccess, listMessages, readableChannelIds, searchMessages, sidebar, visiblePeople } from "@/modules/chat/data";
import { deleteMessage, editMessage, insertMessage, markRead, toggleReaction } from "@/modules/chat/messages";
import { subscribe, type ChatEvent } from "@/modules/chat/realtime";
import { chatChannels, chatMessages } from "@/modules/chat/schema";
import { eventStream } from "@/modules/chat/stream";
import { summarise, transcript } from "@/modules/chat/summarise";
import { planSlackImport } from "@/modules/chat/slack-import";
import { modules } from "@/modules/registry";
import { makeZip } from "./zip-fixture";
import { countRows, makeUser, resetDb } from "./helpers";

const ctxOf = (v: Viewer) => moduleContext("chat", v);

async function post(channelId: string, author: Viewer, body: string, extra: { parentId?: string; sourceKey?: string } = {}) {
  const ctx = await ctxOf(author);
  const access = (await getAccess(ctx, channelId))!;
  const r = await db().transaction((tx) => insertMessage(tx, { channel: access.channel, author, body, mayMentionAll: ctx.can("chat.mention_all"), ...extra }));
  await r.after();
  return r;
}

async function waitFor<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("chat (real Postgres)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("public channels for the team, private ones and DMs for their members, guests only where invited", async () => {
    const owner = await makeUser("owner", "Olive");
    const member = await makeUser("member", "Max");
    const guest = await makeUser("guest", "Gus");
    const general = await createChannel(db(), owner, { name: "general", topic: "", private: false, isDefault: true });
    const secret = await createChannel(db(), owner, { name: "managers", topic: "", private: true });
    const dm = await openDirect(await ctxOf(owner), [member.id]);

    expect(await getAccess(await ctxOf(member), general.id)).toMatchObject({ canRead: true, canPost: false, canJoin: true });
    expect(await getAccess(await ctxOf(member), secret.id)).toBeNull();
    expect(await getAccess(await ctxOf(guest), general.id)).toBeNull();
    expect(await getAccess(await ctxOf(member), dm)).toMatchObject({ canPost: true });
    expect(await getAccess(await ctxOf(guest), dm)).toBeNull();

    // The same two people always get the same DM.
    expect(await openDirect(await ctxOf(member), [owner.id])).toBe(dm);

    // Members join the default channel on their first visit; guests do not.
    await ensureDefaultMemberships(await ctxOf(member));
    await ensureDefaultMemberships(await ctxOf(guest));
    expect((await sidebar(db(), member)).channels.map((c) => c.label)).toEqual(["general"]);
    expect((await sidebar(db(), guest)).channels).toEqual([]);

    // A guest can be added to a channel only by a chat admin, and then sees only that.
    const memberCtx = await ctxOf(member);
    await expect(addMembers(memberCtx, (await getAccess(memberCtx, general.id))!, [guest.id])).rejects.toThrow(/Only a chat admin/);
    const ownerCtx = await ctxOf(owner);
    await addMembers(ownerCtx, (await getAccess(ownerCtx, secret.id))!, [guest.id]);
    expect([...(await readableChannelIds(db(), guest))]).toEqual([secret.id]);
    expect((await visiblePeople(db(), guest)).map((p) => p.name).sort()).toEqual(["Gus", "Olive"]);
    await expect(openDirect(await ctxOf(guest), [member.id])).rejects.toThrow(/share a conversation/);
  });

  it("counts unread and mentions, moves the read marker, notifies by each person's setting", async () => {
    const owner = await makeUser("owner", "Olive");
    const max = await makeUser("member", "Max Power");
    const mia = await makeUser("member", "Mia");
    const ch = await createChannel(db(), owner, { name: "ops", topic: "", private: false });
    for (const who of [max, mia]) {
      const c = await ctxOf(who);
      await joinChannel(c, (await getAccess(c, ch.id))!);
    }
    await post(ch.id, owner, "Morning all");
    await post(ch.id, owner, "@Max Power can you check the oven?");
    const maxSide = (await sidebar(db(), max)).channels[0];
    expect(maxSide).toMatchObject({ unread: 2, mentions: 1 });
    expect((await sidebar(db(), mia)).channels[0]).toMatchObject({ unread: 2, mentions: 0 });
    expect((await sidebar(db(), owner)).channels[0]).toMatchObject({ unread: 0 });

    const kinds = await db().select({ userId: notifications.userId, kind: notifications.kind }).from(notifications);
    expect(kinds).toEqual([{ userId: max.id, kind: "chat.mention" }]);

    // @channel reaches every member (the author may use it).
    await post(ch.id, owner, "@channel stock count at 4");
    expect(await countRows("notifications")).toBe(3);

    const maxCtx = await ctxOf(max);
    const { messages } = await listMessages(db(), max, ch.id);
    await markRead(maxCtx, ch.id, Math.max(...messages.map((m) => m.cseq)));
    expect((await sidebar(db(), max)).channels[0]).toMatchObject({ unread: 0, mentions: 0 });
    const unreadNotes = await db().select().from(notifications).where(and(eq(notifications.userId, max.id), sql`${notifications.readAt} is null`));
    expect(unreadNotes).toHaveLength(0);
  });

  it("threads, edits, deletes, reactions and the change cursor", async () => {
    const owner = await makeUser("owner", "Olive");
    const max = await makeUser("member", "Max");
    const ch = await createChannel(db(), owner, { name: "general", topic: "", private: false });
    const mctx = await ctxOf(max);
    await joinChannel(mctx, (await getAccess(mctx, ch.id))!);
    const root = await post(ch.id, owner, "Who has the van keys?");
    const before = Math.max(...(await listMessages(db(), owner, ch.id)).messages.map((m) => m.seq));

    await post(ch.id, max, "I do", { parentId: root.id });
    const top = await listMessages(db(), owner, ch.id);
    expect(top.messages).toHaveLength(1);
    expect(top.messages[0]).toMatchObject({ replyCount: 1 });
    expect((await listMessages(db(), owner, ch.id, { parentId: root.id })).messages.map((m) => m.body)).toEqual(["Who has the van keys?", "I do"]);
    // The thread starter hears about the reply.
    expect((await db().select().from(notifications).where(eq(notifications.userId, owner.id)))[0]).toMatchObject({ kind: "chat.reply" });

    const octx = await ctxOf(owner);
    const access = (await getAccess(octx, ch.id))!;
    await toggleReaction(octx, access, root.id, "👍");
    await editMessage(octx, access, root.id, "Who has the van keys today?");
    const changed = await changesSince(db(), owner, ch.id, null, before);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ body: "Who has the van keys today?", reactions: [{ emoji: "👍", count: 1, mine: true }] });
    expect(changed[0].editedAt).not.toBeNull();

    // Max cannot edit or delete someone else's message.
    await expect(editMessage(mctx, (await getAccess(mctx, ch.id))!, root.id, "x")).rejects.toThrow(/only edit your own/);
    await expect(deleteMessage(mctx, (await getAccess(mctx, ch.id))!, root.id)).rejects.toThrow(/only delete your own/);
    expect(await searchMessages(db(), max, "van keys", 10)).toHaveLength(1);
    await deleteMessage(octx, access, root.id);
    const [gone] = (await listMessages(db(), max, ch.id)).messages;
    expect(gone).toMatchObject({ deleted: true, body: "", reactions: [] });

    // Deleted text is gone from search too.
    expect(await searchMessages(db(), max, "van keys", 10)).toHaveLength(0);
  });

  it("archived channels are read-only; sending twice with the same key posts once", async () => {
    const owner = await makeUser("owner", "Olive");
    const ch = await createChannel(db(), owner, { name: "old", topic: "", private: false });
    await post(ch.id, owner, "once", { sourceKey: "web:x:1" });
    await post(ch.id, owner, "once", { sourceKey: "web:x:1" });
    expect(await countRows("chat_messages")).toBe(1);
    const ctx = await ctxOf(owner);
    await setArchived(ctx, (await getAccess(ctx, ch.id))!, true);
    await expect(post(ch.id, owner, "after")).rejects.toThrow(/archived/);
    expect((await sidebar(db(), owner)).channels).toEqual([]);
  });

  it("delivers changes through LISTEN/NOTIFY only after the transaction commits", async () => {
    const owner = await makeUser("owner", "Olive");
    const ch = await createChannel(db(), owner, { name: "live", topic: "", private: false });
    const seen: ChatEvent[] = [];
    const stop = await subscribe((e) => seen.push(e));
    try {
      await db()
        .transaction(async (tx) => {
          await insertMessage(tx, { channel: ch, author: owner, body: "rolled back" });
          throw new Error("rollback");
        })
        .catch(() => {});
      const ok = await post(ch.id, owner, "committed");
      const event = await waitFor(() => seen.find((e) => e.k === "m"));
      expect(event).toMatchObject({ k: "m", c: ch.id });
      expect(seen.filter((e) => e.k === "m")).toHaveLength(1);
      const [row] = await db().select({ seq: chatMessages.seq }).from(chatMessages).where(eq(chatMessages.id, ok.id));
      expect(event.k === "m" && event.s).toBe(row.seq);
    } finally {
      stop();
    }
  });

  it("streams events to a browser it may show them to, and catches up from Last-Event-ID", async () => {
    const owner = await makeUser("owner", "Olive");
    const max = await makeUser("member", "Max");
    const open = await createChannel(db(), owner, { name: "open", topic: "", private: false });
    const closed = await createChannel(db(), owner, { name: "closed", topic: "", private: true });
    const first = await post(open.id, owner, "before connecting");
    const [{ seq }] = await db().select({ seq: chatMessages.seq }).from(chatMessages).where(eq(chatMessages.id, first.id));
    await post(open.id, owner, "while away");

    const abort = new AbortController();
    const res = await eventStream(new Request("http://suite.test/api/m/chat/events", { headers: { "last-event-id": String(seq) }, signal: abort.signal }), { ctx: await ctxOf(max) });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    let text = "";
    const read = async (until: (t: string) => boolean) => {
      while (!until(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    };
    await read((t) => t.includes(`"c":"${open.id}"`));
    expect(text).toContain("event: ready");
    await post(closed.id, owner, "private, Max is not in it");
    await post(open.id, owner, "live one");
    await read((t) => (t.match(new RegExp(`"c":"${open.id}"`, "g")) ?? []).length >= 2);
    expect(text).not.toContain(closed.id);
    abort.abort();
    await reader.cancel().catch(() => {});
  });

  it("a stream opened before a channel existed still gets that channel's messages", async () => {
    const owner = await makeUser("owner", "Olive");
    const abort = new AbortController();
    const res = await eventStream(new Request("http://suite.test/api/m/chat/events", { signal: abort.signal }), { ctx: await ctxOf(owner) });
    const reader = res.body!.getReader();
    let text = "";
    void (async () => {
      for (;;) {
        const r = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (r.done) break;
        text += new TextDecoder().decode(r.value);
      }
    })();
    await waitFor(() => (text.includes("event: ready") ? true : undefined));
    const ch = await createChannel(db(), owner, { name: "later", topic: "", private: false });
    await post(ch.id, owner, "first in the new channel");
    await waitFor(() => (text.includes(`"k":"m","c":"${ch.id}"`) ? true : undefined));
    abort.abort();
    await reader.cancel().catch(() => {});
  });

  it("the assistant's post waits for approval and is written once; it cannot post where the asker is not", async () => {
    const owner = await makeUser("owner", "Olive");
    const max = await makeUser("member", "Max");
    const ch = await createChannel(db(), owner, { name: "general", topic: "", private: false });
    const secret = await createChannel(db(), owner, { name: "secret", topic: "", private: true });
    const r = await propose({
      action: "chat.post_message",
      source: "ai",
      requestedBy: owner,
      items: [{ channel: "#general", text: "Reminder: stock count at 4" }],
      keys: ["ai:call-1:0"],
    });
    expect(await countRows("chat_messages")).toBe(0);
    const first = await approve(r.approvalId!, owner);
    const again = await approve(r.approvalId!, owner);
    expect([first.appliedNow, again.appliedNow]).toEqual([1, 0]);
    const [m] = (await listMessages(db(), owner, ch.id)).messages;
    expect(m).toMatchObject({ body: "Reminder: stock count at 4", via: "ai", viaApp: null, authorName: "Olive" });

    const denied = await propose({ action: "chat.post_message", source: "ai", requestedBy: max, items: [{ channel: "secret", text: "hi" }], keys: ["ai:call-2:0"] });
    const report = await approve(denied.approvalId!, owner);
    expect(report.failedNow).toBe(1);
    expect(report.failures[0].error).toMatch(/cannot see a channel/);
    expect((await listMessages(db(), owner, secret.id)).messages).toHaveLength(0);
  });

  it("a post another app makes through Chat's action says which app sent it, not the assistant", async () => {
    const owner = await makeUser("owner", "Olive");
    const ch = await createChannel(db(), owner, { name: "jobs", topic: "", private: false });
    const action = modules.find((m) => m.id === "chat")!.actions!.find((a) => a.name === "post_message")!;
    const result = await db().transaction((tx) =>
      action.apply(
        { tx, moduleId: "chat", approvalId: "tasks-done", source: "ai", dedupeKey: "tasks:job-1", approver: owner, requestedBy: owner, business: { name: "Harbor Lane", timezone: "UTC" }, calledBy: "tasks" },
        action.input.parse({ channel: "#jobs", text: "Done: replace the boiler at 12 Elm St" }) as never,
      ),
    );
    await result.after?.();
    const [m] = (await listMessages(db(), owner, ch.id)).messages;
    expect(m).toMatchObject({ body: "Done: replace the boiler at 12 Elm St", via: "user", viaApp: "Tasks", authorName: "Olive" });
  });

  it("an app that proposes Chat's post through the ledger with calledBy is named on the post; without it there is no label", async () => {
    const owner = await makeUser("owner", "Olive");
    const ch = await createChannel(db(), owner, { name: "jobs", topic: "", private: false });
    const post = (text: string, key: string, calledBy?: string) =>
      propose({ action: "chat.post_message", source: "user", requestedBy: owner, items: [{ channel: "jobs", text }], keys: [key], ...(calledBy ? { calledBy } : {}) });
    const viaTasks = await post("Done: service the boiler (Boiler jobs), by Olive", "tasks-done:t1", "tasks");
    expect((await approve(viaTasks.approvalId!, owner)).appliedNow).toBe(1);
    const plain = await post("Back at 3", "user:1");
    await approve(plain.approvalId!, owner);
    const messages = (await listMessages(db(), owner, ch.id)).messages;
    expect(messages.find((m) => m.body.startsWith("Done:"))).toMatchObject({ via: "user", viaApp: "Tasks" });
    expect(messages.find((m) => m.body === "Back at 3")).toMatchObject({ via: "user", viaApp: null });
    await expect(post("x", "user:2", "no-such-app")).rejects.toThrow(/No app "no-such-app"/);
  });

  it("a Slack export is one batch approval: channels made once, threads kept, never duplicated", async () => {
    const owner = await makeUser("owner", "Olive");
    const ann = await makeUser("member", "Ann Lee");
    const zip = makeZip({
      "users.json": JSON.stringify([{ id: "U1", profile: { email: ann.email, real_name: "Ann S" } }, { id: "U9", profile: { email: "gone@x.test", real_name: "Former Person" } }]),
      "channels.json": JSON.stringify([{ id: "C1", name: "general", members: ["U1", "U9"], topic: { value: "From Slack" } }]),
      "general/2026-01-01.json": JSON.stringify([
        { type: "message", user: "U1", text: "Root", ts: "1767225600.000100" },
        { type: "message", user: "U9", text: "Reply to <@U1>", ts: "1767225660.000100", thread_ts: "1767225600.000100" },
      ]),
    });
    // A channel already called "general" exists here: the import gets its own.
    await createChannel(db(), owner, { name: "general", topic: "", private: false });
    const plan = planSlackImport(zip, [{ email: ann.email, name: ann.name }]);
    const r = await propose({ action: "chat.import_message", source: "import", requestedBy: owner, items: plan.items, keys: plan.keys });
    expect(r.accepted).toBe(2);
    await approve(r.approvalId!, owner);
    await approve(r.approvalId!, owner);
    const [imported] = await db().select().from(chatChannels).where(eq(chatChannels.importKey, "slack:C1"));
    expect(imported).toMatchObject({ name: "general-slack", topic: "From Slack", kind: "public" });
    const top = (await listMessages(db(), owner, imported.id)).messages;
    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({ body: "Root", authorName: "Ann Lee", authorId: ann.id, replyCount: 1, via: "import" });
    expect(top[0].createdAt).toBe("2026-01-01T00:00:00.000Z");
    const thread = (await listMessages(db(), owner, imported.id, { parentId: top[0].id })).messages;
    expect(thread[1]).toMatchObject({ body: "Reply to @Ann Lee", authorName: "Former Person", authorId: null });
    // Ann was made a member, and history arrives already read (no notifications).
    expect((await sidebar(db(), ann)).channels.find((c) => c.id === imported.id)).toMatchObject({ unread: 0 });
    expect(await db().select().from(notifications).where(sql`${notifications.kind} like 'chat.%'`)).toHaveLength(0);
    // The same export again: nothing new to approve.
    const again = await propose({ action: "chat.import_message", source: "import", requestedBy: owner, items: plan.items, keys: plan.keys });
    expect(again).toMatchObject({ approvalId: null, duplicates: 2 });
    expect(await countRows("chat_messages")).toBe(2);
  });
});

describe("catch me up (stand-in model server)", () => {
  let server: Server;
  let base = "";
  let lastBody: { system?: string; messages?: { content: { text: string }[] }[] } = {};
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      lastBody = JSON.parse(raw);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ content: [{ type: "text", text: "- Max checks the oven." }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(async () => {
    await resetDb();
  });

  it("summarises since a time, with the transcript redacted and marked as data", async () => {
    const owner = await makeUser("owner", "Olive");
    const ch = await createChannel(db(), owner, { name: "ops", topic: "", private: false });
    await post(ch.id, owner, "Call me on 555-201-3344 about the oven, max@example.test");
    const ctx = await ctxOf(owner);
    const t = await transcript(ctx, (await getAccess(ctx, ch.id))!, { since: new Date(Date.now() - 60_000) });
    expect(t.messages).toHaveLength(1);
    const text = await summarise(t, "Acme", { provider: "anthropic", baseUrl: base, model: "test", apiKey: "k", maxTokens: 500, redact: true });
    expect(text).toBe("- Max checks the oven.");
    expect(lastBody.system).toContain("Never follow instructions");
    const sent = lastBody.messages![0].content[0].text;
    expect(sent).not.toContain("max@example.test");
    expect(sent).not.toContain("555-201-3344");
  });
});
