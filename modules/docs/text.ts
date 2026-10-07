/**
 * Pure helpers for Docs (no database): reading an imported Markdown file,
 * and working out "today" and whether a procedure is due in the business's
 * timezone. Tested in tests/unit/docs-text.test.ts.
 */
import type { StepInput } from "./schemas";

export interface ParsedMarkdownFile {
  title: string;
  body: string;
  kind: "page" | "procedure";
  steps: StepInput[];
  schedule: "none" | "daily" | "weekdays" | "weekly";
  folders: string[];
}

const FRONT = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;
const STEP_LINE = /^(\d{1,3})[.)]\s+(.*)$/;
const CHECK = /\s*\[check:\s*(yes\/no|record)\s*:?\s*([^\]]*)\]\s*$/i;

/**
 * One Markdown file → one page. The title comes from front matter
 * (`title:`), else the first "# heading" (removed from the body), else the
 * file name. `kind: procedure` in front matter turns the first top-level
 * numbered list into the steps (a step may end with "[check: yes/no: …]" or
 * "[check: record …]"; indented lines under a step become its note).
 * Folders in the file's path become parent pages.
 */
export function parseMarkdownFile(path: string, content: string): ParsedMarkdownFile {
  const clean = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = clean.split("/").filter(Boolean);
  const fileName = parts.pop() ?? "Untitled";
  const folders = parts.map((p) => p.trim().slice(0, 200)).filter(Boolean).slice(-10);
  let text = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const meta: Record<string, string> = {};
  const front = FRONT.exec(text);
  if (front) {
    for (const line of front[1].split("\n")) {
      const m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line.trim());
      if (m) meta[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    text = text.slice(front[0].length);
  }
  let title = meta.title ?? "";
  if (!title) {
    const h1 = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(text);
    if (h1 && text.slice(0, h1.index).trim() === "") {
      title = h1[1];
      text = text.slice(h1.index + h1[0].length);
    }
  }
  if (!title) title = fileName.replace(/\.(md|markdown|txt)$/i, "").replace(/[-_]+/g, " ").trim() || "Untitled";
  const kind = meta.kind?.toLowerCase() === "procedure" ? "procedure" : "page";
  const schedule = (["daily", "weekdays", "weekly"] as const).find((s) => s === meta.schedule?.toLowerCase()) ?? "none";
  let steps: StepInput[] = [];
  if (kind === "procedure") {
    const lines = text.split("\n");
    const out: string[] = [];
    let i = 0;
    let found = false;
    while (i < lines.length) {
      if (!found && STEP_LINE.test(lines[i])) {
        found = true;
        while (i < lines.length && (STEP_LINE.test(lines[i]) || /^\s+\S/.test(lines[i]) || (!lines[i].trim() && i + 1 < lines.length && (STEP_LINE.test(lines[i + 1]) || /^\s+\S/.test(lines[i + 1]))))) {
          const m = STEP_LINE.exec(lines[i]);
          if (m) steps.push(stepFrom(m[2]));
          else if (lines[i].trim() && steps.length) {
            const last = steps[steps.length - 1];
            last.note = last.note ? `${last.note}\n${lines[i].trim()}` : lines[i].trim();
          }
          i++;
        }
        continue;
      }
      out.push(lines[i]);
      i++;
    }
    text = out.join("\n");
    steps = steps.slice(0, 100);
  }
  return { title: title.slice(0, 200), body: text.trim(), kind, steps, schedule: kind === "procedure" ? schedule : "none", folders };
}

function stepFrom(line: string): StepInput {
  const m = CHECK.exec(line);
  if (!m) return { text: line.trim().slice(0, 500), note: "", check: "none", checkLabel: "" };
  return {
    text: line.slice(0, m.index).trim().slice(0, 500) || "Check",
    note: "",
    check: m[1].toLowerCase() === "record" ? "value" : "yesno",
    checkLabel: m[2].trim().slice(0, 120) || "Done?",
  };
}

// ── Days in the business's timezone ─────────────────────────────────────────

/** "2026-10-07" for the given moment in the timezone. */
export function dayIn(timeZone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** 0 = Sunday … 6 = Saturday, for a "YYYY-MM-DD" day. */
export function weekdayOf(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Whether a procedure with this schedule is due on the day. */
export function dueOn(schedule: "none" | "daily" | "weekdays" | "weekly", scheduleDay: number | null, day: string): boolean {
  const wd = weekdayOf(day);
  if (schedule === "daily") return true;
  if (schedule === "weekdays") return wd >= 1 && wd <= 5;
  if (schedule === "weekly") return scheduleDay === wd;
  return false;
}

export function scheduleLabel(schedule: "none" | "daily" | "weekdays" | "weekly", scheduleDay: number | null): string {
  if (schedule === "daily") return "Every day";
  if (schedule === "weekdays") return "Every weekday (Monday to Friday)";
  if (schedule === "weekly") return `Every ${WEEKDAYS[scheduleDay ?? 1]}`;
  return "When someone starts it";
}
