import { z } from "zod";
import { channelName, REACTIONS } from "./text";

export const MAX_MESSAGE = 8000;
export const MAX_ATTACHMENTS = 10;
export const MAX_GROUP_DM = 9;

const uuid = z.string().uuid();

export const messageBody = z.string().trim().max(MAX_MESSAGE, `Keep a message under ${MAX_MESSAGE.toLocaleString("en")} characters, or split it in two.`);

/** A message sent from the composer (attachments are file ids from /api/files). */
export const sendInput = z
  .object({
    channelId: uuid,
    parentId: uuid.nullable().default(null),
    body: messageBody,
    fileIds: z.array(uuid).max(MAX_ATTACHMENTS, `Attach at most ${MAX_ATTACHMENTS} files to one message.`).default([]),
    /** A random id from the browser, so pressing Send twice (or a retry) posts once. */
    clientKey: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  })
  .refine((v) => v.body.length > 0 || v.fileIds.length > 0, { message: "Write a message or attach a file.", path: ["body"] });
export type SendInput = z.output<typeof sendInput>;

export const editInput = z.object({ messageId: uuid, body: messageBody.min(1, "A message cannot be empty. Delete it instead.") });
export const messageIdInput = z.object({ messageId: uuid });
export const reactInput = z.object({ messageId: uuid, emoji: z.enum(REACTIONS, "Pick one of the reactions offered.") });
export const sinceInput = z.object({ channelId: uuid, parentId: uuid.nullable().default(null), cursor: z.number().int().min(0) });
export const olderInput = z.object({ channelId: uuid, parentId: uuid.nullable().default(null), beforeCseq: z.number().int().min(1) });
export const readInput = z.object({ channelId: uuid, cseq: z.number().int().min(0) });

const nameField = z
  .string()
  .trim()
  .min(1, "Give the channel a name.")
  .max(60, "Keep the name short (under 40 letters).")
  .transform(channelName)
  .refine((n) => n.length >= 2, "Use at least two letters or digits in the name (spaces become dashes).");

/** The "new channel" form (checkbox arrives as "on" or not at all). */
export const channelForm = z.object({
  name: nameField,
  topic: z.string().trim().max(250, "Keep the topic under 250 characters.").default(""),
  private: z
    .string()
    .optional()
    .transform((v) => v === "on"),
});

export const topicForm = z.object({
  channelId: uuid,
  topic: z.string().trim().max(250, "Keep the topic under 250 characters."),
});

export const renameForm = z.object({ channelId: uuid, name: nameField });

export const notifyForm = z.object({
  channelId: uuid,
  notify: z.enum(["all", "mentions", "none"], "Choose all messages, mentions only, or nothing."),
});

export const addMembersForm = z.object({ channelId: uuid });

/** Direct message: one person (or yourself), or a small group. */
export const dmForm = z.object({});
export const dmPeople = z
  .array(uuid)
  .min(1, "Pick at least one person.")
  .max(MAX_GROUP_DM - 1, `A group conversation can have at most ${MAX_GROUP_DM} people. Make a private channel for more.`);

export const channelIdInput = z.object({ channelId: uuid });

export const memberInput = z.object({ channelId: uuid, userId: uuid });

export const previewHostsForm = z.object({
  hosts: z
    .string()
    .max(4000, "That list is too long. Keep it to the sites your team links to most.")
    .transform((s) =>
      [
        ...new Set(
          s
            .split(/[\s,]+/)
            .map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
            .filter(Boolean),
        ),
      ],
    )
    .refine((hosts) => hosts.every((h) => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(h)), "Write each site as a plain host name, e.g. docs.example.com (one per line)."),
});

export const summariseForm = z.object({
  channelId: uuid,
  parentId: uuid.nullable().default(null),
  since: z.enum(["unread", "day", "week"]).default("day"),
});

export const importForm = z.object({});

/**
 * One message the assistant drafts. `channel` is a channel name ("general",
 * "#general") or id. It waits in Approvals; the person who asked is the author.
 */
export const postMessageInput = z.object({
  channel: z.string().trim().min(1, "Say which channel.").max(80),
  text: z.string().trim().min(1, "Write the message.").max(MAX_MESSAGE),
  threadId: uuid.optional(),
});
export type PostMessageInput = z.output<typeof postMessageInput>;

/** One message from a Slack export (the import proposes one record per message). */
export const importMessageInput = z.object({
  slackChannelId: z.string().min(1).max(40),
  channelName: z.string().min(1).max(80),
  channelKind: z.enum(["public", "private"]),
  channelTopic: z.string().max(250).default(""),
  channelArchived: z.boolean().default(false),
  /** Emails of the channel's members that matched people in the suite. */
  memberEmails: z.array(z.string().email()).max(500).default([]),
  ts: z.string().regex(/^\d+(\.\d+)?$/),
  threadTs: z.string().regex(/^\d+(\.\d+)?$/).nullable().default(null),
  authorEmail: z.string().email().nullable().default(null),
  authorName: z.string().min(1).max(120),
  text: z.string().max(40_000),
});
export type ImportMessageInput = z.output<typeof importMessageInput>;
