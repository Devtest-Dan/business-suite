import "server-only";
import { inArray, or } from "drizzle-orm";
import { parseCsv } from "@/lib/csv";
import type { Db, DbTx } from "@/lib/db/client";
import { UserError } from "@/lib/errors";
import type { ApplyContext, ApplyResult } from "@/lib/modules/contract";
import { createLead } from "./data";
import { emailKey, phoneKey } from "./logic";
import { funnelLeads } from "./schema";
import { importLeadInput, type ImportLeadInput } from "./schemas";

/**
 * CSV import of leads (for example from a trade show list or an old
 * spreadsheet). The whole file is ONE approval; each row is one record.
 * Rows that repeat an email or phone number inside the file, or that match a
 * lead already here, are left out and counted. Nothing is written until a
 * person approves, and the ledger writes each row once.
 */

export const MAX_IMPORT_ROWS = 1000;

const COLUMNS: Record<string, keyof ImportLeadInput | "first_name" | "last_name"> = {
  name: "name",
  full_name: "name",
  contact: "name",
  first_name: "first_name",
  firstname: "first_name",
  last_name: "last_name",
  lastname: "last_name",
  surname: "last_name",
  email: "email",
  e_mail: "email",
  email_address: "email",
  phone: "phone",
  mobile: "phone",
  telephone: "phone",
  phone_number: "phone",
  company: "company",
  company_name: "company",
  organization: "company",
  organisation: "company",
  message: "message",
  notes: "message",
  note: "message",
  service: "service",
  interest: "service",
  source: "sourceDetail",
};

const columnKey = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

export interface LeadImportPlan {
  items: ImportLeadInput[];
  rows: number;
  duplicatesInFile: number;
  alreadyHere: number;
  invalid: { row: number; error: string }[];
  unknownColumns: string[];
}

export async function planLeadImport(q: Db | DbTx, csv: string): Promise<LeadImportPlan> {
  const { header, rows } = parseCsv(csv);
  const keys = header.map(columnKey);
  const plan: LeadImportPlan = { items: [], rows: rows.length, duplicatesInFile: 0, alreadyHere: 0, invalid: [], unknownColumns: header.filter((h, i) => h && !COLUMNS[keys[i]]) };
  const seen = new Set<string>();
  const parsed: ImportLeadInput[] = [];
  rows.forEach((raw, index) => {
    const row = index + 2;
    const record: Record<string, unknown> = { row };
    let first = "";
    let last = "";
    header.forEach((h, i) => {
      const target = COLUMNS[keys[i]];
      const value = raw[h] ?? "";
      if (target === "first_name") first = value;
      else if (target === "last_name") last = value;
      else if (target) record[target] = value;
    });
    if (!record.name && (first || last)) record.name = `${first} ${last}`.trim();
    const result = importLeadInput.safeParse(record);
    if (!result.success) {
      plan.invalid.push({ row, error: result.error.issues.map((i) => i.message).join(" ") });
      return;
    }
    const lead = result.data;
    if (!lead.email && !lead.phone) {
      plan.invalid.push({ row, error: "It has no email and no phone number." });
      return;
    }
    const ek = emailKey(lead.email);
    const pk = phoneKey(lead.phone);
    if ((ek && seen.has(`e:${ek}`)) || (pk && seen.has(`p:${pk}`))) {
      plan.duplicatesInFile += 1;
      return;
    }
    if (ek) seen.add(`e:${ek}`);
    if (pk) seen.add(`p:${pk}`);
    parsed.push(lead);
  });
  const emails = parsed.map((l) => emailKey(l.email)).filter(Boolean);
  const phones = parsed.map((l) => phoneKey(l.phone)).filter(Boolean);
  const existing = emails.length || phones.length ? await existingKeys(q, emails, phones) : new Set<string>();
  for (const lead of parsed) {
    const ek = emailKey(lead.email);
    const pk = phoneKey(lead.phone);
    if ((ek && existing.has(`e:${ek}`)) || (pk && existing.has(`p:${pk}`))) plan.alreadyHere += 1;
    else plan.items.push(lead);
  }
  return plan;
}

async function existingKeys(q: Db | DbTx, emails: string[], phones: string[]): Promise<Set<string>> {
  const conds = [];
  if (emails.length) conds.push(inArray(funnelLeads.emailKey, emails));
  if (phones.length) conds.push(inArray(funnelLeads.phoneKey, phones));
  const rows = await q.select({ e: funnelLeads.emailKey, p: funnelLeads.phoneKey }).from(funnelLeads).where(or(...conds));
  const out = new Set<string>();
  for (const r of rows) {
    if (r.e) out.add(`e:${r.e}`);
    if (r.p) out.add(`p:${r.p}`);
  }
  return out;
}

export function previewImportLead(l: ImportLeadInput): string {
  return `Row ${l.row}: add the lead ${l.name}${l.email ? ` <${l.email}>` : ""}${l.phone ? ` ${l.phone}` : ""}${l.company ? ` at ${l.company}` : ""}${l.service ? `, wants ${l.service}` : ""}`;
}

export function describeLeadImport(p: LeadImportPlan, by: string): string {
  const parts = [`${by} imported a CSV with ${p.rows} row${p.rows === 1 ? "" : "s"}: ${p.items.length} new lead${p.items.length === 1 ? "" : "s"}.`];
  if (p.duplicatesInFile) parts.push(`${p.duplicatesInFile} repeated an email or phone number already in the file and ${p.duplicatesInFile === 1 ? "was" : "were"} left out.`);
  if (p.alreadyHere) parts.push(`${p.alreadyHere} matched a lead already in Leads (same email or phone) and ${p.alreadyHere === 1 ? "was" : "were"} left out.`);
  if (p.invalid.length) parts.push(`${p.invalid.length} row${p.invalid.length === 1 ? " was" : "s were"} left out (${p.invalid.slice(0, 3).map((i) => `row ${i.row}: ${i.error}`).join("; ")}${p.invalid.length > 3 ? "; …" : ""}).`);
  if (p.unknownColumns.length) parts.push(`Columns not used: ${p.unknownColumns.slice(0, 8).join(", ")}.`);
  parts.push("Imported leads get no new-lead alerts and are left out of the speed-to-lead numbers.");
  return parts.join(" ");
}

/** Writes one approved row; checks again for a lead with the same email or phone added since. */
export async function applyImportLead(ctx: ApplyContext, input: ImportLeadInput): Promise<ApplyResult> {
  const by = ctx.requestedBy ?? ctx.approver;
  const ek = emailKey(input.email);
  const pk = phoneKey(input.phone);
  const clash = await existingKeys(ctx.tx, ek ? [ek] : [], pk ? [pk] : []);
  if (clash.size) throw new UserError(`A lead with the same ${clash.has(`e:${ek}`) ? "email" : "phone number"} was added after the import was proposed, so this row was not added again.`);
  const lead = await createLead(
    ctx.tx,
    { name: input.name, email: input.email, phone: input.phone, company: input.company, message: input.message, service: input.service, contactMethod: "", source: "import", sourceDetail: input.sourceDetail, assigneeId: null },
    by,
    { sourceKey: `${ctx.approvalId}:${ctx.dedupeKey}` },
  );
  return { targetId: lead.id, summary: `Added the lead ${lead.name}` };
}
