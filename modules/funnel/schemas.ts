import { z } from "zod";
import { CARD_MESSAGE, looksLikeCardNumber } from "./card-guard";
import {
  CONTACT_KINDS,
  CONTACT_METHODS,
  DISQUALIFY_REASONS,
  FORM_FIELDS,
  MANUAL_SOURCES,
  originOf,
  PLACEHOLDERS,
  splitList,
  unknownPlaceholders,
  type FormField,
} from "./logic";

/**
 * Every form, public submission, AI tool and import input of Leads. Shared by
 * the browser and the server. Every free-text field refuses card numbers.
 */

export const safeText = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .max(max, tooLong)
    .refine((v) => !looksLikeCardNumber(v), CARD_MESSAGE);

const optionalText = (max: number, what: string) => safeText(max, `Keep ${what} under ${max.toLocaleString("en")} characters.`).default("");

export const nameField = safeText(160, "Keep the name under 160 characters.").pipe(z.string().min(1, "Give a name."));

export const emailField = z
  .string()
  .trim()
  .max(254, "Keep the email under 254 characters.")
  .refine((v) => v === "" || z.email().safeParse(v).success, "This email does not look right. Check it, or leave it empty.")
  .default("");

/** Digits, spaces and + ( ) - . only. One that starts with "+" is never mistaken for a card. */
export const phoneField = z
  .string()
  .trim()
  .max(40, "Keep the phone number under 40 characters.")
  .refine((v) => v === "" || /^[+\d(][\d ()+.\-/x]*$/i.test(v), "Use digits, spaces and + ( ) - only in the phone number.")
  .refine((v) => v.startsWith("+") || !looksLikeCardNumber(v), CARD_MESSAGE)
  .default("");

const uuid = z.string().uuid("That record id is not valid.");
const optionalUuid = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .pipe(z.string().uuid().nullable())
  .nullable()
  .optional()
  .transform((v) => v ?? null);
const checkbox = z
  .string()
  .optional()
  .transform((v) => v === "on" || v === "true");

// ── The public form ─────────────────────────────────────────────────────────

/** What a form shows, as the public page and the submission check need it. */
export interface PublicFormConfig {
  fields: FormField[];
  services: string[];
}

/** Where the visitor came from; the hosted page and the embed snippet fill these. */
const trackingText = z
  .string()
  .trim()
  .max(1000)
  .catch("")
  .default("")
  .transform((v) => (looksLikeCardNumber(v) ? "" : v.slice(0, 500)));

/** A field the form does not show: whatever is sent is dropped. */
const notShown = () => z.unknown().optional().transform(() => "");

/** The check of one public submission, built from what the form shows. */
export function publicSubmission(form: PublicFormConfig) {
  const shows = (f: FormField) => form.fields.includes(f);
  return z
    .object({
      name: nameField,
      email: shows("email") ? emailField : notShown(),
      phone: shows("phone") ? phoneField : notShown(),
      company: shows("company") ? optionalText(160, "the company name") : notShown(),
      message: shows("message") ? optionalText(3000, "the message") : notShown(),
      service:
        shows("service") && form.services.length
          ? z
              .string()
              .trim()
              .default("")
              .refine((v) => v === "" || form.services.includes(v), "Pick one of the services in the list.")
          : notShown(),
      contact_method: shows("contact_method") ? z.enum(["", ...CONTACT_METHODS]).catch("").default("") : notShown(),
      consent: z.literal("on", { error: "Tick the box to say we may contact you." }),
      page_url: trackingText,
      referrer: trackingText,
      utm_source: trackingText,
      utm_medium: trackingText,
      utm_campaign: trackingText,
    })
    .superRefine((v, ctx) => {
      const needs = [shows("email") ? "email" : null, shows("phone") ? "phone" : null].filter(Boolean) as ("email" | "phone")[];
      if (needs.length && !needs.some((k) => v[k])) {
        ctx.addIssue({
          code: "custom",
          path: [needs[0]],
          message: needs.length === 2 ? "Give an email or a phone number, so we can reply." : needs[0] === "email" ? "Give your email, so we can reply." : "Give your phone number, so we can reply.",
        });
      }
    });
}
export type PublicSubmission = z.output<ReturnType<typeof publicSubmission>>;

/** The field the hosted page hides from people; a bot that fills it in is ignored. */
export const HONEYPOT_FIELD = "website";

// ── Forms (owner) ───────────────────────────────────────────────────────────

export const formConfigForm = z
  .object({
    id: optionalUuid,
    name: safeText(120, "Keep the form's name under 120 characters.").pipe(z.string().min(1, "Give the form a name (only your team sees it).")),
    heading: optionalText(160, "the heading"),
    field_email: checkbox,
    field_phone: checkbox,
    field_company: checkbox,
    field_message: checkbox,
    field_service: checkbox,
    field_contact_method: checkbox,
    services: z.string().max(3000).default(""),
    consentText: safeText(1000, "Keep the consent wording under 1,000 characters.").pipe(z.string().min(10, "Write the consent wording the visitor ticks, in your own words.")),
    thankYouMessage: optionalText(1000, "the thank-you message"),
    redirectUrl: z
      .string()
      .trim()
      .max(500)
      .default("")
      .refine((v) => v === "" || /^https?:\/\//.test(v) && originOf(v) !== null, "Give the full address of the page, starting with https://, or leave it empty."),
    embedOrigins: z.string().max(3000).default(""),
    assigneeId: optionalUuid,
    active: checkbox,
  })
  .transform((v) => {
    const raw: Record<string, boolean> = { email: v.field_email, phone: v.field_phone, company: v.field_company, message: v.field_message, service: v.field_service, contact_method: v.field_contact_method };
    return {
      id: v.id,
      name: v.name,
      heading: v.heading,
      fields: FORM_FIELDS.filter((f) => raw[f]),
      services: splitList(v.services).map((s) => s.slice(0, 80)),
      consentText: v.consentText,
      thankYouMessage: v.thankYouMessage,
      redirectUrl: v.redirectUrl,
      embedOrigins: splitList(v.embedOrigins),
      assigneeId: v.assigneeId,
      active: v.active,
    };
  })
  .superRefine((v, ctx) => {
    if (!v.fields.includes("email") && !v.fields.includes("phone")) ctx.addIssue({ code: "custom", path: ["fields"], message: "Show the email field, the phone field or both: otherwise you cannot reply." });
    if (v.fields.includes("service") && v.services.length < 1) ctx.addIssue({ code: "custom", path: ["services"], message: "List the services to choose from (one per line), or untick “Service wanted”." });
    if (v.services.length > 30) ctx.addIssue({ code: "custom", path: ["services"], message: "Keep it to 30 services at most." });
    if (v.services.some(looksLikeCardNumber)) ctx.addIssue({ code: "custom", path: ["services"], message: CARD_MESSAGE });
    const bad = v.embedOrigins.find((o) => originOf(o) === null);
    if (bad) ctx.addIssue({ code: "custom", path: ["embedOrigins"], message: `“${bad.slice(0, 80)}” is not a website address. Write each like https://www.example.com.` });
    if (v.embedOrigins.length > 10) ctx.addIssue({ code: "custom", path: ["embedOrigins"], message: "List at most 10 websites." });
  })
  .transform((v) => ({ ...v, embedOrigins: v.embedOrigins.map((o) => originOf(o)!) }));
export type FormConfigInput = z.output<typeof formConfigForm>;

// ── Leads (team) ────────────────────────────────────────────────────────────

export const manualLeadForm = z
  .object({
    name: nameField,
    email: emailField,
    phone: phoneField,
    company: optionalText(160, "the company name"),
    message: optionalText(3000, "the notes"),
    service: optionalText(120, "the service"),
    contactMethod: z.enum(["", ...CONTACT_METHODS]).default(""),
    source: z.enum(MANUAL_SOURCES, { error: "Say how this lead reached you." }),
    sourceDetail: optionalText(200, "the source detail"),
    assigneeId: optionalUuid,
    alreadyContacted: checkbox,
  })
  .refine((v) => Boolean(v.email || v.phone), { message: "Give an email or a phone number, so someone can get back to them.", path: ["email"] });
export type ManualLeadInput = z.output<typeof manualLeadForm>;

export const logContactForm = z.object({
  leadId: uuid,
  kind: z.enum(CONTACT_KINDS),
  note: optionalText(2000, "the note"),
});

export const SETTABLE_STATUSES = ["new", "contacted", "qualified", "disqualified"] as const;

const reasonField = optionalText(300, "the reason");

export const statusForm = z
  .object({
    leadId: uuid,
    status: z.enum(SETTABLE_STATUSES),
    reason: z.string().trim().max(80).default(""),
    reasonDetail: reasonField,
  })
  .refine((v) => v.status !== "disqualified" || Boolean(v.reason), { message: "Pick why this lead is disqualified.", path: ["reason"] })
  .transform((v) => ({ ...v, reason: v.status === "disqualified" ? [v.reason, v.reasonDetail].filter(Boolean).join(": ") : "" }));

export const assignForm = z.object({ leadId: uuid, assigneeId: optionalUuid });
export const leadIdForm = z.object({ leadId: uuid });

export const enrollRequest = z.object({
  sequenceId: uuid,
  leadIds: z.array(uuid).min(1, "Tick at least one lead.").max(500, "Enrol at most 500 leads at once."),
});

export const leadListFilter = z.object({
  q: z.string().trim().max(200).catch("").default(""),
  status: z.enum(["", "open", "new", "contacted", "qualified", "converted", "disqualified"]).catch("open").default("open"),
  who: z.enum(["", "me", "unassigned"]).catch("").default(""),
  source: z.string().trim().max(40).catch("").default(""),
});
export type LeadListFilter = z.output<typeof leadListFilter>;

// ── Sequences ───────────────────────────────────────────────────────────────

export const MAX_STEPS = 5;

const templateText = (max: number, what: string) =>
  safeText(max, `Keep ${what} under ${max.toLocaleString("en")} characters.`).superRefine((v, ctx) => {
    const unknown = unknownPlaceholders(v);
    if (unknown.length) ctx.addIssue({ code: "custom", message: `Unknown placeholder {${unknown[0]}}. Use ${PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}.` });
  });

export const stepInput = z.object({
  delayDays: z.coerce.number({ error: "Write the day as a number." }).int("Write the day as a whole number.").min(0, "The day cannot be before the start.").max(60, "Keep each email within 60 days of the start."),
  subject: templateText(200, "the subject").pipe(z.string().min(1, "Give the email a subject.")),
  body: templateText(5000, "the email").pipe(z.string().min(1, "Write the email.")),
});

const sequenceShape = z
  .object({
    id: optionalUuid,
    name: safeText(120, "Keep the name under 120 characters.").pipe(z.string().min(1, "Give the sequence a name.")),
    steps: z.array(stepInput).min(1, "Write at least one email.").max(MAX_STEPS, `A sequence has at most ${MAX_STEPS} emails.`),
  })
  .refine((v) => v.steps.every((s, i) => i === 0 || s.delayDays > v.steps[i - 1].delayDays), { message: "Each email must go out on a later day than the one before it.", path: ["steps"] });

/** The sequence form sends step_1_day, step_1_subject, step_1_body, …; empty rows are left out. */
export const sequenceForm = z.record(z.string(), z.string()).transform((raw) => {
  const steps: { delayDays: string; subject: string; body: string }[] = [];
  for (let i = 1; i <= MAX_STEPS; i++) {
    const s = { delayDays: raw[`step_${i}_day`] ?? "", subject: raw[`step_${i}_subject`] ?? "", body: raw[`step_${i}_body`] ?? "" };
    if (s.subject.trim() || s.body.trim()) steps.push(s);
  }
  return { id: raw.id ?? "", name: raw.name ?? "", steps };
}).transform((shape, ctx) => {
  const parsed = sequenceShape.safeParse(shape);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  return z.NEVER;
});
export type SequenceInput = z.output<typeof sequenceShape>;

export const settingsForm = z.object({
  targetMinutes: z.coerce.number({ error: "Write the target as a number of minutes." }).int().min(1, "The target is at least one minute.").max(2880, "Keep the target under two days (2,880 minutes)."),
  postalAddress: optionalText(500, "the postal address"),
});

// ── Writes the AI or an import may propose ──────────────────────────────────

export const statusInput = z
  .object({
    leadId: z.string().uuid(),
    /** The lead's name as the assistant understood it (shown to the approver; the write uses the id). */
    leadName: z.string().trim().max(160).default(""),
    status: z.enum(SETTABLE_STATUSES),
    /** Required for "disqualified": why. */
    reason: reasonField,
  })
  .refine((v) => v.status !== "disqualified" || Boolean(v.reason), { message: "Say why the lead is disqualified.", path: ["reason"] });
export type StatusInput = z.output<typeof statusInput>;

export const enrollInput = z.object({
  leadId: z.string().uuid(),
  sequenceId: z.string().uuid(),
  leadName: z.string().trim().max(160).default(""),
  sequenceName: z.string().trim().max(120).default(""),
});
export type EnrollInput = z.output<typeof enrollInput>;

export const importLeadInput = z.object({
  row: z.number().int().min(1),
  name: nameField,
  email: emailField,
  phone: phoneField,
  company: optionalText(160, "the company name"),
  message: optionalText(3000, "the notes"),
  service: optionalText(120, "the service"),
  sourceDetail: optionalText(200, "the source"),
});
export type ImportLeadInput = z.output<typeof importLeadInput>;

export const importForm = z.object({
  csv: z.string().max(2_000_000, "That is too much text for one import. Split it into smaller files.").default(""),
});

export const reportFilter = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).catch("").default(""),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).catch("").default(""),
  group: z.enum(["source", "utm_source", "utm_campaign"]).catch("source").default("source"),
});
export type ReportFilter = z.output<typeof reportFilter>;

export { DISQUALIFY_REASONS };
