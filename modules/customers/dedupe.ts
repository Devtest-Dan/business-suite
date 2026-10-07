/**
 * Duplicate detection for contacts (pure: no database). A contact is the same
 * person when the email matches, or the phone matches, or the name matches
 * and nothing contradicts it (no different email or phone on both sides).
 */
import type { ContactInput } from "./schemas";

export function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

/** The last 10 digits, so "+1 (415) 555-0100" and "415 555 0100" match. Short numbers are ignored. */
export function phoneKey(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return "";
  return digits.slice(-10);
}

export function nameKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface ExistingContact {
  id: string;
  name: string;
  email: string;
  phone: string;
  emailKey: string;
  phoneKey: string;
  nameKey: string;
}

export type MatchKind = "email" | "phone" | "name";

export interface Match {
  contact: ExistingContact;
  by: MatchKind;
}

/** The best match among `existing` for one incoming contact, or null. Email beats phone beats name. */
export function findMatch(incoming: { name: string; email: string; phone: string }, existing: ExistingContact[]): Match | null {
  const e = emailKey(incoming.email);
  const p = phoneKey(incoming.phone);
  const n = nameKey(incoming.name);
  if (e) {
    const hit = existing.find((c) => c.emailKey === e);
    if (hit) return { contact: hit, by: "email" };
  }
  if (p) {
    const hit = existing.find((c) => c.phoneKey === p && !(e && c.emailKey && c.emailKey !== e));
    if (hit) return { contact: hit, by: "phone" };
  }
  if (n) {
    const hit = existing.find(
      (c) => c.nameKey === n && !(e && c.emailKey && c.emailKey !== e) && !(p && c.phoneKey && c.phoneKey !== p),
    );
    if (hit) return { contact: hit, by: "name" };
  }
  return null;
}

type MergeableContact = Pick<ContactInput, "name" | "email" | "phone" | "jobTitle" | "companyName" | "address" | "notes" | "tags" | "custom">;

export interface MergePlan {
  /** Fields that were empty and the import fills. */
  filled: string[];
  /** Fields where both have a different value: the existing one is kept. */
  kept: string[];
  tagsAdded: string[];
  notesAppended: boolean;
}

const LABELS: Record<string, string> = { email: "email", phone: "phone", jobTitle: "job title", address: "address", companyName: "company" };

/** What merging `incoming` into `current` changes. Nothing that is already filled in is overwritten. */
export function planMerge(current: MergeableContact, incoming: MergeableContact): MergePlan {
  const filled: string[] = [];
  const kept: string[] = [];
  for (const field of ["email", "phone", "jobTitle", "address", "companyName"] as const) {
    const now = current[field].trim();
    const next = incoming[field].trim();
    if (!next) continue;
    if (!now) filled.push(LABELS[field]);
    else if (normaliseForCompare(field, now) !== normaliseForCompare(field, next)) kept.push(LABELS[field]);
  }
  for (const [key, value] of Object.entries(incoming.custom)) {
    if (value && !current.custom[key]) filled.push(key);
  }
  const tagsAdded = incoming.tags.filter((t) => !current.tags.includes(t));
  const notesAppended = Boolean(incoming.notes.trim()) && !current.notes.includes(incoming.notes.trim());
  return { filled, kept, tagsAdded, notesAppended };
}

function normaliseForCompare(field: string, value: string): string {
  if (field === "email") return emailKey(value);
  if (field === "phone") return phoneKey(value) || value;
  return value.toLowerCase();
}

/** The merged record (blanks filled, tags joined, notes appended). */
export function mergeContact<T extends MergeableContact>(current: T, incoming: MergeableContact): T {
  const out = { ...current, custom: { ...current.custom }, tags: [...current.tags] };
  for (const field of ["email", "phone", "jobTitle", "address", "companyName"] as const) {
    if (!out[field].trim() && incoming[field].trim()) out[field] = incoming[field].trim();
  }
  for (const [key, value] of Object.entries(incoming.custom)) if (value && !out.custom[key]) out.custom[key] = value;
  for (const tag of incoming.tags) if (!out.tags.includes(tag)) out.tags.push(tag);
  const extra = incoming.notes.trim();
  if (extra && !out.notes.includes(extra)) out.notes = out.notes.trim() ? `${out.notes.trim()}\n\n${extra}` : extra;
  return out;
}

export function describeMerge(plan: MergePlan): string {
  const parts: string[] = [];
  if (plan.filled.length) parts.push(`fills ${plan.filled.join(", ")}`);
  if (plan.tagsAdded.length) parts.push(`adds tag${plan.tagsAdded.length === 1 ? "" : "s"} ${plan.tagsAdded.join(", ")}`);
  if (plan.notesAppended) parts.push("adds to the notes");
  if (plan.kept.length) parts.push(`keeps the existing ${plan.kept.join(", ")} (the file's differs)`);
  return parts.length ? parts.join("; ") : "nothing new: the contact already has all of it";
}
