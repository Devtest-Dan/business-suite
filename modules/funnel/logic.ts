/**
 * Small pure helpers for Leads (no database), shared by the server, the pages
 * and the tests.
 */

export const STATUSES = ["new", "contacted", "qualified", "converted", "disqualified"] as const;
export type LeadStatus = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  converted: "Converted",
  disqualified: "Disqualified",
};

export const SOURCES = ["form", "phone", "walk_in", "email", "referral", "import", "other"] as const;
export type LeadSource = (typeof SOURCES)[number];
/** What a person can pick when adding a lead by hand. */
export const MANUAL_SOURCES = ["phone", "walk_in", "email", "referral", "other"] as const;

export const SOURCE_LABELS: Record<LeadSource, string> = {
  form: "Web form",
  phone: "Phone call",
  walk_in: "Walk-in",
  email: "Email",
  referral: "Referral",
  import: "Import",
  other: "Other",
};

/** The optional fields a form can show (name and the consent box are always there). */
export const FORM_FIELDS = ["email", "phone", "company", "message", "service", "contact_method"] as const;
export type FormField = (typeof FORM_FIELDS)[number];

export const FORM_FIELD_LABELS: Record<FormField, string> = {
  email: "Email",
  phone: "Phone",
  company: "Company",
  message: "Message",
  service: "Service wanted",
  contact_method: "Preferred contact method",
};

export const CONTACT_METHODS = ["email", "phone", "text"] as const;
export const CONTACT_METHOD_LABELS: Record<(typeof CONTACT_METHODS)[number], string> = { email: "Email", phone: "Phone call", text: "Text message" };

/** Ways a first contact can be logged. */
export const CONTACT_KINDS = ["call", "email", "text", "meeting", "voicemail"] as const;
export const CONTACT_KIND_LABELS: Record<(typeof CONTACT_KINDS)[number], string> = {
  call: "Called",
  email: "Emailed",
  text: "Texted",
  meeting: "Met",
  voicemail: "Left a voicemail",
};

export const DISQUALIFY_REASONS = ["Not a fit for what we do", "Outside our area", "No budget", "Could not reach them", "Went with someone else", "Duplicate", "Spam", "Other"] as const;

/** The placeholders a sequence email may use. */
export const PLACEHOLDERS = ["first_name", "business_name", "service"] as const;

export const DEFAULT_TARGET_MINUTES = 15;

/** "Ana Reyes" → "Ana"; nothing usable → "there" (so "Hi there"). */
export function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return /\p{L}/u.test(first) ? first : "there";
}

/** Fills {first_name}, {business_name} and {service}; anything else in braces is left as it is. */
export function renderTemplate(text: string, vars: { first_name: string; business_name: string; service: string }): string {
  return text.replace(/\{(first_name|business_name|service)\}/g, (_, key: keyof typeof vars) => vars[key] || (key === "service" ? "what you asked about" : ""));
}

/** Placeholders in a template that are not one of the three known ones. */
export function unknownPlaceholders(text: string): string[] {
  const found = [...text.matchAll(/\{([^{}\s]{1,40})\}/g)].map((m) => m[1]);
  return [...new Set(found.filter((p) => !(PLACEHOLDERS as readonly string[]).includes(p)))];
}

/** The foot of every sequence email: who sent it, the postal address and how to stop the emails (CAN-SPAM). */
export function emailFooter(businessName: string, postalAddress: string, unsubscribeUrl: string): string {
  return ["", "--", businessName, postalAddress.trim(), "", `You are getting this email because you contacted ${businessName}.`, `To stop these emails, open: ${unsubscribeUrl}`].join("\n");
}

/** A duration in minutes as people say it: "under a minute", "12 min", "3 h 5 min", "2 d 4 h". */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "";
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }
  const d = Math.floor(m / (24 * 60));
  const h = Math.floor((m % (24 * 60)) / 60);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** Minutes between two moments (null when either is missing). */
export function minutesBetween(from: Date | null | undefined, to: Date | null | undefined): number | null {
  if (!from || !to) return null;
  return (to.getTime() - from.getTime()) / 60_000;
}

export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** "12 of 40" → 30 (whole per cent); null when there is nothing to divide by. */
export function percent(part: number, whole: number): number | null {
  if (!whole) return null;
  return Math.round((part / whole) * 100);
}

export function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

/** The last 10 digits, so "+1 (415) 555-0100" and "415 555 0100" match. Short numbers are ignored. */
export function phoneKey(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length < 7 ? "" : digits.slice(-10);
}

/** "https://www.example.com/contact" → "https://www.example.com"; anything that is not http(s) → null. */
export function originOf(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Splits a list typed one per line or comma-separated. */
export function splitList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
