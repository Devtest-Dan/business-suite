import type { ModuleManifest, WriteAction } from "@/lib/modules/contract";

/**
 * "Create a task from this message" and "Save to docs" — without importing
 * the other apps' code. Chat only uses what those apps register in their
 * manifests: a write action, proposed through the shared approvals ledger
 * (so a double click never makes two tasks). When the app is not installed or
 * switched off, the menu item is simply not there.
 *
 * The actions (docs/ADD_AN_APP.md, "Cross-app writes"):
 * - `tasks.create_task`: chat files into the team project "From chat", made on
 *   first use (`createProjectIfMissing`), with a link back to the message.
 * - `docs.create_page`: a page in the default docs space.
 */

export type CrossAppKind = "task" | "doc";

export const TARGETS: Record<CrossAppKind, { module: string; action: string; label: string; appName: string }> = {
  task: { module: "tasks", action: "create_task", label: "Create a task", appName: "Tasks" },
  doc: { module: "docs", action: "create_page", label: "Save to docs", appName: "Docs" },
};

/** The Tasks project chat's tasks go in (made on first use). */
export const CHAT_TASK_PROJECT = "From chat";

const MAX_TITLE = 200;
const MAX_TASK_DESCRIPTION = 10_000;
const MAX_LABEL = 200;

export interface CrossAppTarget {
  module: ModuleManifest;
  action: WriteAction<unknown>;
}

/** The installed, switched-on app and action for a kind, or null. */
export function findTarget(kind: CrossAppKind, enabled: ModuleManifest[]): CrossAppTarget | null {
  const t = TARGETS[kind];
  const mod = enabled.find((m) => m.id === t.module);
  const action = mod?.actions?.find((a) => a.name === t.action);
  return mod && action ? { module: mod, action: action as unknown as WriteAction<unknown> } : null;
}

/** What chat knows about the message it is sending on. */
export interface MessageForApps {
  title: string;
  body: string;
  authorName: string;
  /** "#general" or the other person's name. */
  conversation: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Path inside the suite, e.g. "/m/chat/<channel>?m=<message>". */
  path: string;
  /** The same link with the suite's address in front, for text people copy. */
  url: string;
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The raw input for the other app's action (its own schema checks it when proposed). */
export function payloadFor(kind: CrossAppKind, m: MessageForApps): Record<string, unknown> {
  const credit = `— ${m.authorName} in ${m.conversation}, ${m.date}`;
  if (kind === "task") {
    return {
      project: CHAT_TASK_PROJECT,
      createProjectIfMissing: true,
      title: cut(m.title, MAX_TITLE),
      description: cut(`${m.body}\n\n${credit}`, MAX_TASK_DESCRIPTION),
      sourceLabel: cut(`From chat: ${m.conversation}`, MAX_LABEL),
      sourceUrl: m.path,
    };
  }
  return {
    title: cut(m.title, MAX_TITLE),
    body: `${m.body}\n\n${credit}\n\n[Open the message in chat](${m.url})`,
    note: cut(`From chat: ${m.conversation}`, MAX_LABEL),
  };
}

/** A short title from a message: its first line, trimmed. */
export function titleFrom(body: string, fallback: string): string {
  const line = body.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const clean = line.replace(/\s+/g, " ");
  if (!clean) return fallback;
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}
