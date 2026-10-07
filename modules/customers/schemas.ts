import { z } from "zod";
import { CARD_MESSAGE, looksLikeCardNumber } from "./card-guard";

/**
 * Every form, AI tool and import input of the Customers app. Shared by the
 * browser and the server. Every free-text field refuses card numbers.
 */

/** Free text that must not hold a card number. */
export const safeText = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .max(max, tooLong)
    .refine((v) => !looksLikeCardNumber(v), CARD_MESSAGE);

const optionalText = (max: number, what: string) => safeText(max, `Keep ${what} under ${max.toLocaleString("en")} characters.`).default("");

const emailField = z
  .string()
  .trim()
  .max(254, "Keep the email under 254 characters.")
  .refine((v) => v === "" || z.email().safeParse(v).success, "This email does not look right. Check it, or leave it empty.")
  .default("");

/** Phone numbers: digits, spaces and + ( ) - . only. One that starts with "+" is never mistaken for a card. */
const phoneField = z
  .string()
  .trim()
  .max(40, "Keep the phone number under 40 characters.")
  .refine((v) => v === "" || /^[+\d][\d ()+.\-/x]*$/i.test(v), "Use digits, spaces and + ( ) - only in the phone number.")
  .refine((v) => v.startsWith("+") || !looksLikeCardNumber(v), CARD_MESSAGE)
  .default("");

/** Tags: a list, or a comma/semicolon separated text. Lower-case, trimmed, at most 20. */
export const tagsField = z
  .union([z.array(z.string()), z.string()])
  .default([])
  .transform((v) => normaliseTags(Array.isArray(v) ? v : v.split(/[;,]/)))
  .refine((tags) => tags.length <= 20, "Use at most 20 tags.")
  .refine((tags) => tags.every((t) => t.length <= 40), "Keep each tag under 40 characters.")
  .refine((tags) => !tags.some(looksLikeCardNumber), CARD_MESSAGE);

export function normaliseTags(raw: string[]): string[] {
  return [...new Set(raw.map((t) => t.trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean))];
}

/** Custom field values: key → text, checked against the definitions by `checkCustomValues`. */
export const customValues = z
  .record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.string().trim().max(500, "Keep custom field values under 500 characters."))
  .default({})
  .refine((v) => Object.keys(v).length <= 30, "Too many custom values.")
  .refine((v) => !Object.values(v).some(looksLikeCardNumber), CARD_MESSAGE);

const uuid = z.string().uuid("That record id is not valid.");
const optionalUuid = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .pipe(z.string().uuid().nullable())
  .nullable()
  .optional()
  .transform((v) => v ?? null);

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31.").refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "That date does not exist.");

// ── Contacts and companies ──────────────────────────────────────────────────

export const contactInput = z.object({
  name: safeText(160, "Keep the name under 160 characters.").pipe(z.string().min(1, "Give the contact a name.")),
  email: emailField,
  phone: phoneField,
  jobTitle: optionalText(120, "the job title"),
  companyName: optionalText(160, "the company name"),
  address: optionalText(500, "the address"),
  notes: optionalText(5000, "the notes"),
  tags: tagsField,
  ownerEmail: z.string().trim().toLowerCase().max(254).default(""),
  custom: customValues,
});
export type ContactInput = z.output<typeof contactInput>;

export const companyInput = z.object({
  name: safeText(160, "Keep the name under 160 characters.").pipe(z.string().min(1, "Give the company a name.")),
  website: optionalText(300, "the website"),
  email: emailField,
  phone: phoneField,
  address: optionalText(500, "the address"),
  notes: optionalText(5000, "the notes"),
  tags: tagsField,
  custom: customValues,
});
export type CompanyInput = z.output<typeof companyInput>;

/** Forms send custom fields as "custom.<key>" inputs and the owner as a user id. */
export const contactForm = contactInput.omit({ ownerEmail: true, custom: true }).extend({ ownerId: optionalUuid, id: optionalUuid });
export const companyForm = companyInput.omit({ custom: true }).extend({ ownerId: optionalUuid, id: optionalUuid });

// ── Deals and stages ────────────────────────────────────────────────────────

/** "1,250.50" → 125050 cents; empty → null. */
export const moneyField = z
  .string()
  .trim()
  .default("")
  .transform((v, ctx) => {
    if (v === "") return null;
    const clean = v.replace(/[,\s]/g, "").replace(/^[^\d-]+/, "");
    if (!/^-?\d{1,12}(\.\d{1,2})?$/.test(clean)) {
      ctx.addIssue({ code: "custom", message: "Write the value as a number, like 1250 or 1250.50." });
      return z.NEVER;
    }
    return Math.round(Number(clean) * 100);
  });

export const dealForm = z.object({
  id: optionalUuid,
  title: safeText(200, "Keep the title under 200 characters.").pipe(z.string().min(1, "Give the deal a title.")),
  stageId: uuid,
  contactId: optionalUuid,
  companyId: optionalUuid,
  value: moneyField,
  expectedClose: z.union([z.literal(""), isoDate]).default("").transform((v) => v || null),
  notes: optionalText(5000, "the notes"),
  ownerId: optionalUuid,
});

export const stageForm = z.object({
  id: optionalUuid,
  name: safeText(60, "Keep the stage name under 60 characters.").pipe(z.string().min(1, "Give the stage a name.")),
  kind: z.enum(["open", "won", "lost"]),
});

export const moveStageForm = z.object({ dealId: uuid, stageId: uuid });

// ── Activities and follow-ups ───────────────────────────────────────────────

export const ACTIVITY_KINDS = ["call", "email", "meeting", "note"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

const subject = z.object({ contactId: optionalUuid, companyId: optionalUuid, dealId: optionalUuid });
const needsSubject = (v: { contactId: string | null; companyId: string | null; dealId: string | null }) => Boolean(v.contactId || v.companyId || v.dealId);
const SUBJECT_MESSAGE = "Say which contact, company or deal this is about.";

export const activityForm = subject
  .extend({
    kind: z.enum(ACTIVITY_KINDS),
    body: safeText(5000, "Keep it under 5,000 characters.").pipe(z.string().min(1, "Write what happened.")),
    occurredOn: z.union([z.literal(""), isoDate]).default(""),
  })
  .refine(needsSubject, SUBJECT_MESSAGE);

export const followUpForm = subject
  .extend({
    title: safeText(200, "Keep the title under 200 characters.").pipe(z.string().min(1, "Say what needs doing.")),
    notes: optionalText(2000, "the notes"),
    dueOn: isoDate,
    assigneeId: optionalUuid,
  })
  .refine(needsSubject, SUBJECT_MESSAGE);

export const followUpIdForm = z.object({ id: uuid });

// ── Custom fields and saved filters ─────────────────────────────────────────

export const MAX_FIELDS_PER_ENTITY = 10;

export const fieldForm = z
  .object({
    entity: z.enum(["contact", "company", "deal"]),
    label: safeText(60, "Keep the label under 60 characters.").pipe(z.string().min(1, "Give the field a label.")),
    type: z.enum(["text", "number", "date", "choice"]),
    options: z.string().trim().max(1000).default(""),
  })
  .transform((v) => ({ ...v, options: v.type === "choice" ? normaliseOptions(v.options) : [] }))
  .refine((v) => v.type !== "choice" || v.options.length >= 2, { message: "A choice field needs at least two options, separated by commas.", path: ["options"] });

export function normaliseOptions(text: string): string[] {
  return [...new Set(text.split(",").map((o) => o.trim()).filter(Boolean))].slice(0, 30);
}

export function fieldKey(label: string): string {
  const key = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return /^[a-z]/.test(key) ? key : `f_${key}`.slice(0, 40);
}

export interface FieldDef {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "choice";
  options: string[];
}

/** Checks values against the owner's field definitions. Unknown keys are dropped; empty values removed. */
export function checkCustomValues(defs: FieldDef[], values: Record<string, string>): { values: Record<string, string>; errors: Record<string, string> } {
  const out: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const def of defs) {
    const raw = (values[def.key] ?? "").trim();
    if (!raw) continue;
    if (looksLikeCardNumber(raw)) errors[def.key] = CARD_MESSAGE;
    else if (raw.length > 500) errors[def.key] = `Keep ${def.label} under 500 characters.`;
    else if (def.type === "number" && !/^-?\d+(\.\d+)?$/.test(raw.replace(/,/g, ""))) errors[def.key] = `${def.label} must be a number.`;
    else if (def.type === "date" && !isoDate.safeParse(raw).success) errors[def.key] = `${def.label} must be a date like 2026-10-31.`;
    else if (def.type === "choice" && !def.options.includes(raw)) errors[def.key] = `${def.label} must be one of: ${def.options.join(", ")}.`;
    else out[def.key] = def.type === "number" ? raw.replace(/,/g, "") : raw;
  }
  return { values: out, errors };
}

export const savedFilterForm = z.object({
  entity: z.enum(["contacts", "companies", "deals"]),
  name: safeText(60, "Keep the name under 60 characters.").pipe(z.string().min(1, "Name the filter.")),
  shared: z
    .string()
    .optional()
    .transform((v) => v === "on"),
  query: z.string().max(2000).default(""),
});

/** The filters a list understands (from the URL). */
export const listFilter = z.object({
  q: z.string().trim().max(200).catch("").default(""),
  tag: z.string().trim().toLowerCase().max(40).catch("").default(""),
  owner: z.string().trim().max(40).catch("").default(""),
  stage: z.string().trim().max(40).catch("").default(""),
  status: z.enum(["", "open", "won", "lost"]).catch("").default(""),
});
export type ListFilter = z.output<typeof listFilter>;

// ── Import ──────────────────────────────────────────────────────────────────

export const importForm = z.object({
  csv: z.string().max(2_000_000, "That is too much text for one import. Split it into smaller files.").default(""),
});

/** One row of a contact import, as the approval holds it. */
export const importRowInput = z.object({
  mode: z.enum(["create", "merge"]),
  /** For "merge": the existing contact. */
  targetId: z.string().uuid().nullable().default(null),
  /** For "merge": why it matched, shown to the approver. */
  match: z.enum(["email", "phone", "name"]).nullable().default(null),
  targetName: z.string().max(160).default(""),
  row: z.number().int().min(1),
  contact: contactInput,
});
export type ImportRowInput = z.output<typeof importRowInput>;

// ── AI write tools ──────────────────────────────────────────────────────────

export const noteInput = z
  .object({
    contactId: z.string().uuid().nullable().default(null),
    companyId: z.string().uuid().nullable().default(null),
    dealId: z.string().uuid().nullable().default(null),
    kind: z.enum(ACTIVITY_KINDS).default("note"),
    /** Who it is about, as the assistant understood it (shown to the approver; the write uses the id). */
    about: z.string().trim().max(160).default(""),
    body: safeText(5000, "Keep the note under 5,000 characters.").pipe(z.string().min(1, "The note is empty.")),
  })
  .refine(needsSubject, SUBJECT_MESSAGE);
export type NoteInput = z.output<typeof noteInput>;

export const followUpInput = z
  .object({
    contactId: z.string().uuid().nullable().default(null),
    companyId: z.string().uuid().nullable().default(null),
    dealId: z.string().uuid().nullable().default(null),
    about: z.string().trim().max(160).default(""),
    title: safeText(200, "Keep the title under 200 characters.").pipe(z.string().min(1, "Say what needs doing.")),
    notes: optionalText(2000, "the notes"),
    dueOn: isoDate,
    /** The person to remind (an email of someone in the suite); empty means the person who asked. */
    assigneeEmail: z.string().trim().toLowerCase().max(254).default(""),
  })
  .refine(needsSubject, SUBJECT_MESSAGE);
export type FollowUpInput = z.output<typeof followUpInput>;

export const dealStageInput = z.object({
  dealId: z.string().uuid(),
  /** The deal's title as the assistant understood it (shown to the approver). */
  dealTitle: z.string().trim().max(200).default(""),
  /** The stage's name as the owner wrote it (case does not matter). */
  stage: z.string().trim().min(1).max(60),
});
export type DealStageInput = z.output<typeof dealStageInput>;
