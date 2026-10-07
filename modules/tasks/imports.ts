/**
 * Turning files into records for ONE batch approval (pure: no database).
 *
 * - The AHL "Tasks" export (v1 JSON): each task is keyed by its externalId and
 *   updatedAt, so the same file twice adds nothing, and a later export of a
 *   changed task updates it instead of making a second copy.
 * - CSV: one task per row, keyed by the "key" column when there is one.
 */
import { UserError } from "@/lib/errors";
import { parseCsv } from "@/lib/csv";
import { parseLabels } from "./logic";
import { ahlExportHeader, ahlTaskRecord, type AhlTaskInput, type AhlTaskRecord } from "./schemas";

export interface ParsedAhlExport {
  businessName: string | null;
  tasks: AhlTaskRecord[];
  /** Tasks left out, with the reason (index is 0-based within the file's tasks). */
  invalid: { index: number; error: string }[];
}

export function parseAhlExport(text: string): ParsedAhlExport {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new UserError("The file is not valid JSON. Export it again from the platform and paste or choose the whole file.");
  }
  const head = ahlExportHeader.safeParse(data);
  if (!head.success) throw new UserError(head.error.issues[0]?.message ?? "This is not a Tasks export.");
  const tasks: AhlTaskRecord[] = [];
  const invalid: ParsedAhlExport["invalid"] = [];
  const seen = new Set<string>();
  head.data.tasks.forEach((raw, index) => {
    const parsed = ahlTaskRecord.safeParse(raw);
    if (!parsed.success) {
      invalid.push({ index, error: parsed.error.issues.map((i) => `${i.path.join(".") || "task"}: ${i.message}`).join("; ") });
      return;
    }
    if (seen.has(parsed.data.externalId)) {
      invalid.push({ index, error: `externalId ${parsed.data.externalId} appears twice in the file; the first one is used.` });
      return;
    }
    seen.add(parsed.data.externalId);
    tasks.push(parsed.data);
  });
  if (tasks.length === 0 && invalid.length === 0) throw new UserError("The export has no tasks in it.");
  return { businessName: head.data.business?.name?.trim() || null, tasks, invalid };
}

/** The ledger key of one exported task: the same task at the same moment is never imported twice. */
export function ahlDedupeKey(t: { externalId: string; externalUpdatedAt: string }): string {
  return `ahl:${t.externalId}:${new Date(t.externalUpdatedAt).toISOString()}`;
}

export function ahlRecordsToInputs(tasks: AhlTaskRecord[], target: { projectId: string; ownerId: string | null; internId: string | null }): AhlTaskInput[] {
  return tasks.map((t) => ({
    projectId: target.projectId,
    externalId: t.externalId,
    title: t.title.trim().slice(0, 200),
    detail: (t.detail ?? "").trim(),
    status: t.status,
    assigneeId: t.assignee === "intern" ? target.internId : target.ownerId,
    dueOn: t.dueOn,
    sourceLabel: t.source?.label?.trim().slice(0, 200) ?? "",
    externalUpdatedAt: t.updatedAt,
  }));
}

export const CSV_COLUMNS = ["title", "description", "status", "priority", "due", "assignees", "labels", "checklist", "key"] as const;

const STATUS_WORDS: Record<string, string> = {
  "": "todo",
  todo: "todo",
  "to do": "todo",
  open: "todo",
  doing: "doing",
  "in progress": "doing",
  started: "doing",
  waiting: "waiting",
  blocked: "waiting",
  "on hold": "waiting",
  done: "done",
  complete: "done",
  completed: "done",
  closed: "done",
};

/**
 * CSV rows → records for the "create_task" action, plus each row's ledger key.
 * Unknown status words are passed through so the approval lists them as invalid.
 */
export function csvToTaskRecords(csv: string, projectId: string): { records: Record<string, unknown>[]; keys: (string | null)[] } {
  const { header, rows } = parseCsv(csv);
  if (!header.includes("title")) {
    throw new UserError(`The first row must name the columns, with at least "title" (optional: ${CSV_COLUMNS.filter((c) => c !== "title").join(", ")}).`);
  }
  if (rows.length === 0) throw new UserError("The CSV has a header row but no tasks under it.");
  const list = (v: string | undefined) =>
    (v ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
  const records = rows.map((r) => ({
    project: projectId,
    title: r.title ?? "",
    description: r.description ?? "",
    status: STATUS_WORDS[(r.status ?? "").trim().toLowerCase()] ?? r.status,
    priority: (r.priority ?? "").trim().toLowerCase() || "normal",
    dueOn: (r.due ?? r.dueon ?? "").trim() || null,
    assignees: list(r.assignees ?? r.assignee),
    labels: parseLabels(list(r.labels)),
    checklist: list(r.checklist),
  }));
  const keys = rows.map((r) => (r.key?.trim() ? `csv:${projectId}:${r.key.trim()}` : null));
  return { records, keys };
}
