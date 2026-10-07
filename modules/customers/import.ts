import "server-only";
import { audit, userActor } from "@/lib/audit";
import type { ApplyContext, ApplyResult } from "@/lib/modules/contract";
import type { Db, DbTx } from "@/lib/db/client";
import { parseCsv } from "@/lib/csv";
import { contactValues, getContact, listFields, possibleMatches, saveContact, userIdByEmail } from "./data";
import { describeMerge, emailKey, findMatch, mergeContact, nameKey, phoneKey, planMerge, type ExistingContact } from "./dedupe";
import { checkCustomValues, contactInput, type ContactInput, type FieldDef, type ImportRowInput } from "./schemas";

/**
 * CSV import of contacts with duplicate detection. Every row becomes one
 * record of ONE approval: a new contact, or a merge into an existing one
 * (matched by email, then phone, then name). Rows that repeat the same
 * person inside the file are combined first. Nothing is written until a
 * person approves, and the ledger writes each row once.
 */

export const IMPORT_COLUMNS: Record<string, keyof ContactInput | "first_name" | "last_name"> = {
  name: "name",
  full_name: "name",
  contact: "name",
  first_name: "first_name",
  firstname: "first_name",
  given_name: "first_name",
  last_name: "last_name",
  lastname: "last_name",
  surname: "last_name",
  family_name: "last_name",
  email: "email",
  e_mail: "email",
  email_address: "email",
  phone: "phone",
  mobile: "phone",
  telephone: "phone",
  phone_number: "phone",
  company: "companyName",
  company_name: "companyName",
  organization: "companyName",
  organisation: "companyName",
  job_title: "jobTitle",
  title: "jobTitle",
  position: "jobTitle",
  role: "jobTitle",
  address: "address",
  notes: "notes",
  note: "notes",
  tags: "tags",
  labels: "tags",
  owner: "ownerEmail",
  owner_email: "ownerEmail",
};

export const MAX_IMPORT_ROWS = 1000;

export function columnKey(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export interface ImportPlan {
  items: ImportRowInput[];
  rows: number;
  creates: number;
  merges: { email: number; phone: number; name: number };
  combinedInFile: number;
  upToDate: number;
  invalid: { row: number; error: string }[];
  unknownColumns: string[];
}

/** Turns CSV text into the records of one approval (no writes). */
export async function planImport(q: Db | DbTx, csv: string): Promise<ImportPlan> {
  const { header, rows } = parseCsv(csv);
  const keys = header.map(columnKey);
  const fields = await listFields(q, "contact");
  const fieldByColumn = new Map<string, FieldDef>();
  for (const f of fields) {
    fieldByColumn.set(f.key, f);
    fieldByColumn.set(columnKey(f.label), f);
  }
  const unknownColumns = header.filter((h, i) => h && !IMPORT_COLUMNS[keys[i]] && !fieldByColumn.has(keys[i]));
  const plan: ImportPlan = { items: [], rows: rows.length, creates: 0, merges: { email: 0, phone: 0, name: 0 }, combinedInFile: 0, upToDate: 0, invalid: [], unknownColumns };

  // 1. Each row → a valid contact, or a reason it was left out.
  const parsed: { row: number; contact: ContactInput }[] = [];
  rows.forEach((raw, index) => {
    const row = index + 2; // the header is row 1
    const record: Record<string, unknown> = { custom: {} };
    let first = "";
    let last = "";
    const custom: Record<string, string> = {};
    header.forEach((h, i) => {
      const value = raw[h] ?? "";
      const target = IMPORT_COLUMNS[keys[i]];
      if (target === "first_name") first = value;
      else if (target === "last_name") last = value;
      else if (target) record[target] = value;
      else if (fieldByColumn.has(keys[i])) custom[fieldByColumn.get(keys[i])!.key] = value;
    });
    if (!record.name && (first || last)) record.name = `${first} ${last}`.trim();
    if (!record.name && record.email) record.name = String(record.email).split("@")[0];
    const checked = checkCustomValues(fields, custom);
    const firstFieldError = Object.values(checked.errors)[0];
    if (firstFieldError) {
      plan.invalid.push({ row, error: firstFieldError });
      return;
    }
    record.custom = checked.values;
    const result = contactInput.safeParse(record);
    if (!result.success) {
      plan.invalid.push({ row, error: result.error.issues.map((i) => i.message).join(" ") });
      return;
    }
    parsed.push({ row, contact: result.data });
  });

  // 2. Rows that are the same person inside the file are combined into the first one.
  const combined: { row: number; contact: ContactInput; keys: ExistingContact }[] = [];
  for (const p of parsed) {
    const hit = findMatch(p.contact, combined.map((c) => c.keys));
    if (hit) {
      const into = combined.find((c) => c.keys === hit.contact)!;
      into.contact = mergeContact(into.contact, p.contact);
      into.keys = keysOf(into.keys.id, into.contact);
      plan.combinedInFile += 1;
    } else {
      combined.push({ row: p.row, contact: p.contact, keys: keysOf(`row-${p.row}`, p.contact) });
    }
  }

  // 3. Each remaining row: a merge into an existing contact, or a new one.
  const existing = await possibleMatches(q, {
    emails: unique(combined.map((c) => c.keys.emailKey)),
    phones: unique(combined.map((c) => c.keys.phoneKey)),
    names: unique(combined.map((c) => c.keys.nameKey)),
  });
  for (const c of combined) {
    const match = findMatch(c.contact, existing);
    if (!match) {
      plan.items.push({ mode: "create", targetId: null, match: null, targetName: "", row: c.row, contact: c.contact });
      plan.creates += 1;
      continue;
    }
    const current = await getContact(q, match.contact.id);
    if (!current) continue;
    const merge = planMerge(contactValues(current), c.contact);
    if (!merge.filled.length && !merge.tagsAdded.length && !merge.notesAppended) {
      plan.upToDate += 1;
      continue;
    }
    plan.items.push({ mode: "merge", targetId: current.id, match: match.by, targetName: current.name, row: c.row, contact: c.contact });
    plan.merges[match.by] += 1;
  }
  return plan;
}

function keysOf(id: string, c: { name: string; email: string; phone: string }): ExistingContact {
  return { id, name: c.name, email: c.email, phone: c.phone, emailKey: emailKey(c.email), phoneKey: phoneKey(c.phone), nameKey: nameKey(c.name) };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** One line per record for the approver. */
export function previewImportRow(r: ImportRowInput): string {
  const who = [r.contact.name, r.contact.email ? `<${r.contact.email}>` : "", r.contact.companyName ? `at ${r.contact.companyName}` : ""].filter(Boolean).join(" ");
  if (r.mode === "create") return `Row ${r.row}: add a new contact ${who}`;
  return `Row ${r.row}: merge into the existing contact ${r.targetName} (same ${r.match}) from ${who}`;
}

/** The plan's summary, written on the approval. */
export function describePlan(p: ImportPlan, by: string): string {
  const merges = p.merges.email + p.merges.phone + p.merges.name;
  const parts = [
    `${by} imported a CSV with ${p.rows} row${p.rows === 1 ? "" : "s"}: ${p.creates} new contact${p.creates === 1 ? "" : "s"}, ${merges} merge${merges === 1 ? "" : "s"} into existing contacts (by email ${p.merges.email}, phone ${p.merges.phone}, name ${p.merges.name}).`,
  ];
  if (p.combinedInFile) parts.push(`${p.combinedInFile} row${p.combinedInFile === 1 ? " repeated" : "s repeated"} a person already in the file and ${p.combinedInFile === 1 ? "was" : "were"} combined with the first.`);
  if (p.upToDate) parts.push(`${p.upToDate} matched an existing contact that already has everything in the row, so ${p.upToDate === 1 ? "it was" : "they were"} left out.`);
  if (p.invalid.length) {
    const first = p.invalid
      .slice(0, 3)
      .map((i) => `row ${i.row}: ${i.error}`)
      .join("; ");
    parts.push(`${p.invalid.length} row${p.invalid.length === 1 ? " was" : "s were"} left out (${first}${p.invalid.length > 3 ? "; …" : ""}).`);
  }
  if (p.unknownColumns.length) parts.push(`Columns not used: ${p.unknownColumns.slice(0, 8).join(", ")}.`);
  parts.push("Merges only fill empty fields, add tags and add to the notes: nothing already filled in is overwritten.");
  return parts.join(" ");
}

/** Writes one approved row. Checks again at write time: the contact may have been added or deleted since. */
export async function applyImportRow(ctx: ApplyContext, input: ImportRowInput): Promise<ApplyResult> {
  const by = ctx.requestedBy ?? ctx.approver;
  const sourceKey = `${ctx.approvalId}:${ctx.dedupeKey}`;
  const ownerId = (await userIdByEmail(ctx.tx, input.contact.ownerEmail)) ?? by.id;

  let targetId = input.mode === "merge" ? input.targetId : null;
  let note = "";
  if (targetId && !(await getContact(ctx.tx, targetId))) {
    targetId = null;
    note = " (the contact it matched was deleted since, so a new one was added)";
  }
  if (!targetId) {
    const again = findMatch(
      input.contact,
      await possibleMatches(ctx.tx, { emails: [emailKey(input.contact.email)].filter(Boolean), phones: [phoneKey(input.contact.phone)].filter(Boolean), names: [nameKey(input.contact.name)].filter(Boolean) }),
    );
    if (again && input.mode === "create") {
      targetId = again.contact.id;
      note = ` (a contact with the same ${again.by} was added after the import was proposed, so the row was merged into it)`;
    }
  }

  if (!targetId) {
    const { ownerEmail: _o, ...rest } = input.contact;
    void _o;
    const made = await saveContact(ctx.tx, { ...rest, ownerId }, by, null, { sourceKey, via: "import" });
    return { targetId: made.id, summary: `Added ${made.name}${note}` };
  }
  const current = await getContact(ctx.tx, targetId);
  if (!current) throw new Error("The contact to merge into disappeared during the write.");
  const before = contactValues(current);
  const plan = planMerge(before, input.contact);
  const merged = mergeContact(before, input.contact);
  await saveContact(ctx.tx, merged, by, current.id);
  const summary = `Merged into ${current.name}: ${describeMerge(plan)}${note}`;
  await audit(
    { actor: userActor(by), action: "customers.contact_merged", module: "customers", target: { type: "contact", id: current.id }, summary: `${by.name} merged an imported row into "${current.name}" (approved): ${describeMerge(plan)}.` },
    ctx.tx,
  );
  return { targetId: current.id, summary };
}
