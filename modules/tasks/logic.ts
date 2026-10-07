/**
 * Pure helpers (no database, no server-only imports): dates as "YYYY-MM-DD"
 * strings, repeating tasks, @mentions, labels, board positions and the
 * calendar grid. Unit-tested in tests/unit/tasks-logic.test.ts.
 */
import type { TaskRecurrence } from "./constants";

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function toDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Today's date in the business's timezone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const fmt = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  try {
    return fmt(timeZone || "UTC");
  } catch {
    return fmt("UTC");
  }
}

export function addDays(iso: string, days: number): string {
  return toIso(new Date(toDate(iso).getTime() + days * DAY_MS));
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / DAY_MS);
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(iso: string): number {
  return (toDate(iso).getUTCDay() + 6) % 7;
}

function addMonthsClamped(iso: string, months: number): string {
  const d = toDate(iso);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return toIso(target);
}

/** The next date after `iso` for a repeating task (31 Jan monthly → 28/29 Feb; 29 Feb yearly → 28 Feb). */
export function nextOccurrence(iso: string, recurrence: Exclude<TaskRecurrence, "none">): string {
  switch (recurrence) {
    case "daily":
      return addDays(iso, 1);
    case "weekdays": {
      let next = addDays(iso, 1);
      while (weekdayIndex(next) > 4) next = addDays(next, 1);
      return next;
    }
    case "weekly":
      return addDays(iso, 7);
    case "monthly":
      return addMonthsClamped(iso, 1);
    case "yearly":
      return addMonthsClamped(iso, 12);
  }
}

/**
 * The due date of the next copy when a repeating task is done: the next
 * occurrence after its due date (or after today when it had none), moved on
 * until it is today or later, so finishing late never makes a copy that is
 * already overdue.
 */
export function nextDueDate(dueOn: string | null, recurrence: TaskRecurrence, today: string): string | null {
  if (recurrence === "none") return null;
  let next = nextOccurrence(dueOn ?? today, recurrence);
  for (let guard = 0; next < today && guard < 5000; guard++) next = nextOccurrence(next, recurrence);
  return next;
}

export type DueState = "overdue" | "today" | "soon" | "later" | "none";

export function dueState(dueOn: string | null, today: string, done = false): DueState {
  if (!dueOn || done) return "none";
  if (dueOn < today) return "overdue";
  if (dueOn === today) return "today";
  return daysBetween(today, dueOn) <= 7 ? "soon" : "later";
}

/** "Today", "Tomorrow", "3 days late", or the date. */
export function describeDue(dueOn: string | null, today: string): string {
  if (!dueOn) return "No due date";
  const diff = daysBetween(today, dueOn);
  if (diff === 0) return "Due today";
  if (diff === 1) return "Due tomorrow";
  if (diff === -1) return "1 day late";
  if (diff < 0) return `${-diff} days late`;
  const label = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: dueOn.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric", timeZone: "UTC" }).format(toDate(dueOn));
  return `Due ${label}`;
}

// ── @mentions ─────────────────────────────────────────────────────────────────

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The people a comment mentions: "@Full Name" always counts; "@First" counts
 * when only one person has that first name. Matching ignores case.
 */
export function findMentions(body: string, people: { id: string; name: string }[]): string[] {
  const found = new Set<string>();
  const firstCounts = new Map<string, number>();
  for (const p of people) {
    const first = p.name.trim().split(/\s+/)[0]?.toLowerCase();
    if (first) firstCounts.set(first, (firstCounts.get(first) ?? 0) + 1);
  }
  const mentions = (name: string) => new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, "iu").test(body);
  for (const p of people) {
    const full = p.name.trim();
    if (!full) continue;
    const first = full.split(/\s+/)[0];
    if (mentions(full) || (firstCounts.get(first.toLowerCase()) === 1 && mentions(first))) found.add(p.id);
  }
  return [...found];
}

/** Whether a comment says "@everyone" or "@channel" (it notifies the task's watchers anyway). */
export function mentionsEveryone(body: string): boolean {
  return /(^|[^\p{L}\p{N}_])@(everyone|channel)(?![\p{L}\p{N}_])/iu.test(body);
}

// ── Labels ────────────────────────────────────────────────────────────────────

export const MAX_LABELS = 10;
export const MAX_LABEL_LENGTH = 30;

/** "Urgent, shop;  Shop , ,front" → ["Urgent", "shop", "front"]: trimmed, de-duplicated ignoring case. */
export function parseLabels(input: string | string[]): string[] {
  const parts = Array.isArray(input) ? input : input.split(/[,;]/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const label = raw.trim().replace(/\s+/g, " ").slice(0, MAX_LABEL_LENGTH);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push(label);
  }
  return out.slice(0, MAX_LABELS);
}

// ── Board positions ──────────────────────────────────────────────────────────

/**
 * The position for a card dropped at `index` in a column whose other cards
 * have `positions` (already sorted, without the moved card).
 */
export function positionAt(positions: number[], index: number): number {
  const i = Math.max(0, Math.min(index, positions.length));
  if (positions.length === 0) return 1;
  if (i === 0) return positions[0] - 1;
  if (i === positions.length) return positions[positions.length - 1] + 1;
  return (positions[i - 1] + positions[i]) / 2;
}

// ── Calendar ─────────────────────────────────────────────────────────────────

/** "2026-10" for the month containing `iso`. */
export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

export function isMonth(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value));
}

export function shiftMonth(month: string, by: number): string {
  return addMonthsClamped(`${month}-01`, by).slice(0, 7);
}

/** The weeks (Monday first) that show a month, each a list of 7 dates. */
export function monthGrid(month: string): string[][] {
  const first = `${month}-01`;
  const start = addDays(first, -weekdayIndex(first));
  const lastOfMonth = addDays(`${shiftMonth(month, 1)}-01`, -1);
  const weeks: string[][] = [];
  for (let day = start; day <= lastOfMonth || weeks.length === 0; ) {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(day);
      day = addDays(day, 1);
    }
    weeks.push(week);
    if (day > lastOfMonth) break;
  }
  return weeks;
}

export function monthTitle(month: string): string {
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(toDate(`${month}-01`));
}

/** A path inside the suite that is safe to link to (no other site, no scheme). */
export function isSafeSuitePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && !/[\s<>"]/.test(value) && value.length <= 300;
}
