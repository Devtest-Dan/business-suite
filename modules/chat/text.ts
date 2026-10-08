/**
 * Pure text helpers for chat, shared by the server and the browser: channel
 * names, @mentions, links and the pieces a message is drawn from. No I/O.
 */

export const REACTIONS = ["👍", "❤️", "😄", "🎉", "👀", "✅", "🙏", "😮", "😢", "🔥", "👏", "➕"] as const;
export type Reaction = (typeof REACTIONS)[number];

export const CHANNEL_MENTIONS = ["channel", "everyone", "here"] as const;

/** "Front Desk!" → "front-desk". Empty when nothing usable is left. */
export function channelName(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/[\s_.]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/** The same people always give the same key, whatever order they are picked in. */
export function dmKey(userIds: string[]): string {
  return [...new Set(userIds)].sort().join(":");
}

export interface Person {
  id: string;
  name: string;
}

const WORD = /[\p{L}\p{N}_]/u;

function boundaryBefore(text: string, at: number): boolean {
  return at === 0 || !WORD.test(text[at - 1]);
}

function boundaryAfter(text: string, end: number): boolean {
  return end >= text.length || !WORD.test(text[end]);
}

export interface MentionSpan {
  start: number;
  end: number;
  /** A person's id, or "channel" for @channel / @everyone / @here. */
  target: string;
}

/**
 * Finds "@Full Name" for the given people (longest name first, so "@Ann Lee"
 * beats "@Ann") and "@channel", "@everyone", "@here". Case does not matter.
 */
export function mentionSpans(body: string, people: Person[]): MentionSpan[] {
  const spans: MentionSpan[] = [];
  const lower = body.toLowerCase();
  const candidates = [
    ...people.filter((p) => p.name.trim()).map((p) => ({ key: p.name.trim().toLowerCase(), target: p.id })),
    ...CHANNEL_MENTIONS.map((k) => ({ key: k, target: "channel" })),
  ].sort((a, b) => b.key.length - a.key.length);
  let i = lower.indexOf("@");
  while (i !== -1) {
    if (boundaryBefore(body, i)) {
      const hit = candidates.find((c) => lower.startsWith(c.key, i + 1) && boundaryAfter(body, i + 1 + c.key.length));
      if (hit) {
        const end = i + 1 + hit.key.length;
        spans.push({ start: i, end, target: hit.target });
        i = lower.indexOf("@", end);
        continue;
      }
    }
    i = lower.indexOf("@", i + 1);
  }
  return spans;
}

export function findMentions(body: string, people: Person[]): { userIds: string[]; channel: boolean } {
  const spans = mentionSpans(body, people);
  return {
    userIds: [...new Set(spans.filter((s) => s.target !== "channel").map((s) => s.target))],
    channel: spans.some((s) => s.target === "channel"),
  };
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** Trailing punctuation is usually the sentence, not the link. */
function trimUrl(url: string): string {
  let out = url;
  while (/[.,;:!?)\]}'"]$/.test(out)) {
    if (out.endsWith(")") && (out.match(/\(/g)?.length ?? 0) >= (out.match(/\)/g)?.length ?? 0)) break;
    out = out.slice(0, -1);
  }
  return out;
}

export function urlsIn(body: string): string[] {
  return [...body.matchAll(URL_RE)].map((m) => trimUrl(m[0]));
}

export type Piece =
  | { type: "text"; text: string }
  | { type: "link"; text: string; href: string }
  | { type: "mention"; text: string; target: string; me: boolean }
  | { type: "code"; text: string };

/**
 * Splits a message into the pieces the page draws: plain text, links,
 * mentions and `inline code`. Nothing is ever rendered as HTML.
 */
export function pieces(body: string, people: Person[], viewerId: string): Piece[] {
  const out: Piece[] = [];
  const codeParts = body.split(/(`[^`\n]+`)/g);
  for (const part of codeParts) {
    if (!part) continue;
    if (/^`[^`\n]+`$/.test(part)) {
      out.push({ type: "code", text: part.slice(1, -1) });
      continue;
    }
    const marks: { start: number; end: number; piece: Piece }[] = [];
    for (const m of part.matchAll(URL_RE)) {
      const href = trimUrl(m[0]);
      marks.push({ start: m.index ?? 0, end: (m.index ?? 0) + href.length, piece: { type: "link", text: href, href } });
    }
    for (const s of mentionSpans(part, people)) {
      if (marks.some((mk) => s.start < mk.end && s.end > mk.start)) continue;
      marks.push({ start: s.start, end: s.end, piece: { type: "mention", text: part.slice(s.start, s.end), target: s.target, me: s.target === viewerId || s.target === "channel" } });
    }
    marks.sort((a, b) => a.start - b.start);
    let at = 0;
    for (const mk of marks) {
      if (mk.start > at) out.push({ type: "text", text: part.slice(at, mk.start) });
      out.push(mk.piece);
      at = mk.end;
    }
    if (at < part.length) out.push({ type: "text", text: part.slice(at) });
  }
  return out;
}

/** "@Ann Lee" query while typing: the text after the last "@" before the caret, if it can still be a name. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1 || !boundaryBefore(before, at)) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || /\n/.test(query) || /\s{2}/.test(query)) return null;
  return { start: at, query };
}

/** Slack export markup → plain chat text: <@U1>, <#C1|name>, <!channel>, <url|label>, &amp; ... */
export function slackToText(text: string, userName: (slackId: string) => string | undefined, channelLabel: (slackId: string) => string | undefined): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id: string, label?: string) => `@${userName(id) ?? label ?? "someone"}`)
    .replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => `#${label || channelLabel(id) || "channel"}`)
    .replace(/<!(channel|everyone|here)(?:\|[^>]*)?>/g, (_, k: string) => `@${k}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_, label?: string) => label ?? "@team")
    .replace(/<!date\^[0-9]+\^[^|>]*\|([^>]+)>/g, (_, label: string) => label)
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_, url: string, label: string) => (label === url ? url : `${label} (${url})`))
    .replace(/<(mailto:[^|>]+)\|([^>]+)>/g, (_, _url: string, label: string) => label)
    .replace(/<(https?:\/\/[^>]+)>/g, (_, url: string) => url)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * The badge that says where a message came from: "from Tasks" when another app
 * posted it, "drafted by the assistant", "from Slack", or null for a person's
 * own message. Messages are grouped under one header only when their badges
 * match, so grouping never hides a badge.
 */
export function sourceLabel(m: { via: "user" | "ai" | "import"; viaApp: string | null }): string | null {
  if (m.viaApp) return `from ${m.viaApp}`;
  if (m.via === "ai") return "drafted by the assistant";
  if (m.via === "import") return "from Slack";
  return null;
}

/** "1712345678.000200" → a Date. */
export function slackTsToDate(ts: string): Date {
  return new Date(Math.round(Number(ts) * 1000));
}
