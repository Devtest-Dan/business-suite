import type { ImportMessageInput } from "./schemas";
import { channelName, slackToText } from "./text";
import { readZip } from "./zip";

/**
 * Reads a Slack workspace export (the ZIP from Slack's "Export data") into
 * one record per message for the approvals ledger. Public channels come from
 * channels.json, private ones from groups.json when the export has them.
 * People are matched to suite accounts by email; messages from people who
 * have no account keep their Slack name. Direct messages are not imported
 * (they are private between people). Files are not downloaded (Slack's file
 * links need a Slack login): the message says which file was attached.
 */

interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: { email?: string; real_name?: string; display_name?: string };
}

interface SlackChannel {
  id: string;
  name: string;
  topic?: { value?: string };
  purpose?: { value?: string };
  members?: string[];
  is_archived?: boolean;
}

interface SlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  username?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  files?: { name?: string; title?: string }[];
  user_profile?: { real_name?: string; display_name?: string };
}

/** Messages that only record something happening in Slack, not something someone said. */
const SKIPPED_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
  "pinned_item",
  "unpinned_item",
  "reminder_add",
  "joiner_notification",
  "tombstone",
]);

export interface ImportPlan {
  items: ImportMessageInput[];
  keys: string[];
  channels: { slackId: string; name: string; kind: "public" | "private"; messages: number }[];
  people: { matched: number; unmatched: string[] };
  skipped: number;
}

function parseJson<T>(files: Map<string, Buffer>, name: string): T | null {
  const buf = files.get(name);
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    throw new Error(`${name} in the export is not valid JSON. Download the export from Slack again.`);
  }
}

/** The folder prefix when the export was zipped inside a top-level folder. */
function rootPrefix(files: Map<string, Buffer>): string {
  if (files.has("channels.json") || files.has("users.json")) return "";
  const hit = [...files.keys()].find((k) => /(^|\/)(channels|users)\.json$/.test(k));
  return hit ? hit.slice(0, hit.lastIndexOf("/") + 1) : "";
}

export function planSlackImport(zipBytes: Uint8Array, suiteUsers: { email: string; name: string }[]): ImportPlan {
  const files = readZip(zipBytes, (name) => name.endsWith(".json"));
  const prefix = rootPrefix(files);
  const get = <T>(name: string) => parseJson<T>(files, `${prefix}${name}`);
  const slackUsers = get<SlackUser[]>("users.json");
  const publicChannels = get<SlackChannel[]>("channels.json");
  if (!slackUsers || !publicChannels) {
    throw new Error("This ZIP does not look like a Slack export: it has no users.json or channels.json. Use Slack's “Export data” and upload that ZIP unchanged.");
  }
  const privateChannels = get<SlackChannel[]>("groups.json") ?? [];

  const byEmail = new Map(suiteUsers.map((u) => [u.email.toLowerCase(), u]));
  const users = new Map<string, { email: string | null; name: string; matched: boolean }>();
  const unmatched = new Set<string>();
  for (const u of slackUsers) {
    const email = u.profile?.email?.toLowerCase() ?? null;
    const suite = email ? byEmail.get(email) : undefined;
    const name = suite?.name ?? (u.profile?.real_name || u.real_name || u.profile?.display_name || u.name || "Someone from Slack");
    users.set(u.id, { email: suite ? email : null, name, matched: Boolean(suite) });
  }

  const allChannels = [...publicChannels.map((c) => ({ c, kind: "public" as const })), ...privateChannels.map((c) => ({ c, kind: "private" as const }))];
  const labelById = new Map(allChannels.map(({ c }) => [c.id, c.name]));
  const items: ImportMessageInput[] = [];
  const keys: string[] = [];
  const summary: ImportPlan["channels"] = [];
  let skipped = 0;

  for (const { c, kind } of allChannels) {
    const folder = `${prefix}${c.name}/`;
    const days = [...files.keys()].filter((k) => k.startsWith(folder) && /\/\d{4}-\d{2}-\d{2}\.json$/.test(k)).sort();
    const messages: SlackMessage[] = [];
    for (const day of days) messages.push(...(parseJson<SlackMessage[]>(files, day) ?? []));
    messages.sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
    const memberEmails = (c.members ?? []).map((id) => users.get(id)?.email).filter((e): e is string => Boolean(e));
    let count = 0;
    for (const m of messages) {
      if (!m.ts || (m.type && m.type !== "message") || (m.subtype && SKIPPED_SUBTYPES.has(m.subtype))) {
        skipped += 1;
        continue;
      }
      let text = slackToText(m.text ?? "", (id) => users.get(id)?.name, (id) => labelById.get(id));
      const fileNames = (m.files ?? []).map((f) => f.name || f.title).filter(Boolean);
      if (fileNames.length) text = `${text}${text ? "\n" : ""}[Attached in Slack: ${fileNames.join(", ")}]`;
      if (!text.trim()) {
        skipped += 1;
        continue;
      }
      const author = m.user ? users.get(m.user) : undefined;
      if (m.user && author && !author.matched) unmatched.add(author.name);
      const authorName = author?.name ?? m.user_profile?.real_name ?? m.username ?? "Someone from Slack";
      items.push({
        slackChannelId: c.id,
        channelName: channelName(c.name) || `slack-${c.id.toLowerCase()}`,
        channelKind: kind,
        channelTopic: (c.topic?.value || c.purpose?.value || "").slice(0, 250),
        channelArchived: Boolean(c.is_archived),
        memberEmails,
        ts: m.ts,
        threadTs: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : null,
        authorEmail: author?.email ?? null,
        authorName: authorName.slice(0, 120),
        text: text.slice(0, 40_000),
      });
      keys.push(`slack:${c.id}:${m.ts}`);
      count += 1;
    }
    summary.push({ slackId: c.id, name: c.name, kind, messages: count });
  }
  const matched = [...users.values()].filter((u) => u.matched).length;
  return { items, keys, channels: summary, people: { matched, unmatched: [...unmatched].sort() }, skipped };
}
