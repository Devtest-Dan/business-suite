import { describe, expect, it } from "vitest";
import { fetchPreview, hostAllowed, isPrivateAddress, parseMeta } from "@/modules/chat/link-preview";
import { planSlackImport } from "@/modules/chat/slack-import";
import { channelName, dmKey, findMentions, mentionQuery, pieces, slackToText } from "@/modules/chat/text";
import { readZip } from "@/modules/chat/zip";
import { makeZip } from "./zip-fixture";

describe("chat text", () => {
  it("makes channel names", () => {
    expect(channelName("Front Desk!")).toBe("front-desk");
    expect(channelName("#Café  news_2026")).toBe("cafe-news-2026");
    expect(channelName("!!!")).toBe("");
  });

  it("keeps one key for the same people in any order", () => {
    expect(dmKey(["b", "a", "b"])).toBe(dmKey(["a", "b"]));
  });

  it("finds @mentions, longest name first, with word boundaries", () => {
    const people = [
      { id: "1", name: "Ann" },
      { id: "2", name: "Ann Lee" },
      { id: "3", name: "Bo" },
    ];
    expect(findMentions("Hi @ann lee and @Bo!", people)).toEqual({ userIds: ["2", "3"], channel: false });
    expect(findMentions("Hi @Ann, @Bob is not Bo", people)).toEqual({ userIds: ["1"], channel: false });
    expect(findMentions("mail me at bo@bo.test", people).userIds).toEqual([]);
    expect(findMentions("@channel lunch is here", people).channel).toBe(true);
  });

  it("splits a message into text, links, mentions and code, never HTML", () => {
    const out = pieces("See https://example.com/a?b=1. @Ann <b>`x<y`", [{ id: "u1", name: "Ann" }], "u1");
    expect(out).toEqual([
      { type: "text", text: "See " },
      { type: "link", text: "https://example.com/a?b=1", href: "https://example.com/a?b=1" },
      { type: "text", text: ". " },
      { type: "mention", text: "@Ann", target: "u1", me: true },
      { type: "text", text: " <b>" },
      { type: "code", text: "x<y" },
    ]);
  });

  it("knows when the caret is in a mention being typed", () => {
    expect(mentionQuery("hello @an", 9)).toEqual({ start: 6, query: "an" });
    expect(mentionQuery("mail a@b", 8)).toBeNull();
  });

  it("turns Slack markup into plain text", () => {
    const text = slackToText(
      "Hi <@U1>, see <#C2|ops> and <https://x.test|the doc> &amp; <!channel>",
      (id) => (id === "U1" ? "Ann Lee" : undefined),
      () => undefined,
    );
    expect(text).toBe("Hi @Ann Lee, see #ops and the doc (https://x.test) & @channel");
  });
});

describe("Slack export import plan", () => {
  const zip = makeZip({
    "users.json": JSON.stringify([
      { id: "U1", name: "ann", profile: { email: "Ann@Example.test", real_name: "Ann Slack" } },
      { id: "U2", name: "bo", profile: { email: "bo@elsewhere.test", real_name: "Bo Slack" } },
    ]),
    "channels.json": JSON.stringify([{ id: "C1", name: "General", topic: { value: "All hands" }, members: ["U1", "U2"], is_archived: false }]),
    "groups.json": JSON.stringify([{ id: "G1", name: "managers", members: ["U1"] }]),
    "General/2026-01-02.json": JSON.stringify([
      { type: "message", user: "U2", text: "reply", ts: "1767312000.000200", thread_ts: "1767312000.000100" },
      { type: "message", subtype: "channel_join", user: "U2", text: "<@U2> has joined", ts: "1767311000.000001" },
    ]),
    "General/2026-01-01.json": JSON.stringify([{ type: "message", user: "U1", text: "Hello <@U2>", ts: "1767312000.000100", thread_ts: "1767312000.000100", files: [{ name: "plan.pdf" }] }]),
    "managers/2026-01-01.json": JSON.stringify([{ type: "message", user: "U1", text: "Private note", ts: "1767313000.000100" }]),
  });

  it("reads the ZIP", () => {
    expect([...readZip(zip).keys()]).toContain("users.json");
  });

  it("makes one record per message, in time order, matched by email", () => {
    const plan = planSlackImport(zip, [{ email: "ann@example.test", name: "Ann Lee" }]);
    expect(plan.items.map((i) => i.text)).toEqual(["Hello @Bo Slack\n[Attached in Slack: plan.pdf]", "reply", "Private note"]);
    expect(plan.items[0]).toMatchObject({ channelName: "general", channelKind: "public", authorEmail: "ann@example.test", authorName: "Ann Lee", threadTs: null, memberEmails: ["ann@example.test"] });
    expect(plan.items[1]).toMatchObject({ authorEmail: null, authorName: "Bo Slack", threadTs: "1767312000.000100" });
    expect(plan.items[2]).toMatchObject({ channelKind: "private", channelName: "managers" });
    expect(plan.keys).toEqual(["slack:C1:1767312000.000100", "slack:C1:1767312000.000200", "slack:G1:1767313000.000100"]);
    expect(plan.skipped).toBe(1);
    expect(plan.people).toEqual({ matched: 1, unmatched: ["Bo Slack"] });
  });

  it("refuses something that is not a Slack export, in plain words", () => {
    expect(() => planSlackImport(makeZip({ "notes.json": "[]" }), [])).toThrow(/does not look like a Slack export/);
    expect(() => planSlackImport(new Uint8Array([1, 2, 3]), [])).toThrow(/not a ZIP file/);
  });
});

describe("link previews", () => {
  it("reads only text metadata", () => {
    expect(parseMeta('<head><title>Plain &amp; simple</title><meta property="og:description" content="A &quot;doc&quot;"><meta name="og:site_name" content=\'Docs\'></head>')).toEqual({
      title: "Plain & simple",
      description: 'A "doc"',
      siteName: "Docs",
    });
  });

  it("refuses private and local addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });

  it("only fetches allow-listed hosts over HTTPS and never follows a redirect elsewhere", async () => {
    expect(hostAllowed("www.docs.test", ["docs.test"])).toBe(true);
    expect(hostAllowed("evil.test", ["docs.test"])).toBe(false);
    const calls: string[] = [];
    const fake = (async (url: URL | string) => {
      calls.push(String(url));
      if (String(url).includes("/moved")) return new Response(null, { status: 302, headers: { location: "https://evil.test/x" } });
      return new Response("<title>Hello</title>", { headers: { "content-type": "text/html; charset=utf-8" } });
    }) as typeof fetch;
    // IP literals skip DNS, so the test needs no network.
    expect(await fetchPreview("https://93.184.216.34/page", ["93.184.216.34"], fake)).toMatchObject({ title: "Hello", host: "93.184.216.34" });
    expect(await fetchPreview("http://93.184.216.34/page", ["93.184.216.34"], fake)).toBeNull();
    expect(await fetchPreview("https://93.184.216.34/moved", ["93.184.216.34"], fake)).toBeNull();
    expect(await fetchPreview("https://127.0.0.1/page", ["127.0.0.1"], fake)).toBeNull();
    expect(calls).toEqual(["https://93.184.216.34/page", "https://93.184.216.34/moved"]);
  });
});
