import "server-only";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { env } from "@/lib/env";
import { fieldErrors } from "@/lib/forms";
import { businessProfile } from "@/lib/settings";
import { announceLead, createLead, getFormBySlug, getSettings, type Form } from "./data";
import { formPath, hostedPage, messagePage, TRACKING_FIELDS, type PublicForm, type Tracking } from "./embed";
import { originOf, type FormField } from "./logic";
import { HONEYPOT_FIELD, publicSubmission } from "./schemas";
import { kickDueEmails, unsubscribeLead, verifyUnsubscribeToken } from "./sequences";

/**
 * The public side of Leads, served with `auth: "self"`: nobody is signed in,
 * so every handler decides on its own what a request may do.
 *
 * - The form page and the submission need no secret (they are public by
 *   design) but only work for a form that exists and is switched on, take
 *   only a small url-encoded body, are rate-limited per network address and
 *   per form (in Postgres), ignore a filled-in honeypot, refuse card numbers,
 *   and answer only with the visitor's own form or a thank-you page: no
 *   response ever contains another lead.
 * - Unsubscribe needs a link signed with the server's secret (HMAC).
 */

/** Public submissions allowed per window. */
export const RATE_LIMITS = {
  perAddress: { max: 5, minutes: 10 },
  perForm: { max: 60, minutes: 60 },
};
export const MAX_BODY_BYTES = 16_384;

type Params = { moduleId: string; params: Record<string, string> };

function clientAddress(request: Request): string {
  // Caddy sets X-Forwarded-For (it replaces what the visitor sends); the first address is the visitor's.
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

/** The network address is never stored: only a keyed hash of it, inside the counter's name. */
function addressKey(ip: string): string {
  return createHash("sha256").update(`funnel-rate:${env().secretKey}:${ip}`).digest("hex").slice(0, 32);
}

async function bump(bucket: string, minutes: number): Promise<number> {
  const rows = await db().execute<{ hits: number }>(sql`
    insert into funnel_rate_hits (bucket, window_start, hits)
    values (${bucket}, date_bin(make_interval(mins => ${minutes}), now(), timestamptz '2000-01-01'), 1)
    on conflict (bucket, window_start) do update set hits = funnel_rate_hits.hits + 1
    returning hits`);
  return Number(rows[0]?.hits ?? 0);
}

/** Counts this submission; true when the address or the form has used up its window. */
export async function overRateLimit(ip: string, formId: string): Promise<boolean> {
  const byAddress = await bump(`ip:${addressKey(ip)}:${RATE_LIMITS.perAddress.minutes}`, RATE_LIMITS.perAddress.minutes);
  const byForm = await bump(`form:${formId}:${RATE_LIMITS.perForm.minutes}`, RATE_LIMITS.perForm.minutes);
  // Keep the table small.
  await db().execute(sql`delete from funnel_rate_hits where window_start < now() - interval '1 day'`);
  return byAddress > RATE_LIMITS.perAddress.max || byForm > RATE_LIMITS.perForm.max;
}

function toPublic(form: Form): PublicForm {
  return { slug: form.slug, heading: form.heading, fields: form.fields as FormField[], services: form.services, consentText: form.consentText };
}

/** Headers for every public page: no caching, and a policy that allows framing only by the owner's websites. */
function htmlHeaders(form: Form | null): HeadersInit {
  const frame = form?.embedOrigins.length ? form.embedOrigins.join(" ") : "*";
  const redirect = form?.redirectUrl ? originOf(form.redirectUrl) : null;
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'${redirect ? ` ${redirect}` : ""}; frame-ancestors ${frame}`,
  };
}

function html(body: string, status: number, form: Form | null): Response {
  return new Response(body, { status, headers: htmlHeaders(form) });
}

async function notFoundPage(): Promise<Response> {
  const business = await businessProfile();
  return html(messagePage(business.name, "This form is not available", "The form you opened is switched off or no longer exists. Contact the business another way, or check the address."), 404, null);
}

function trackingFrom(url: URL, request: Request): Tracking {
  const q = url.searchParams;
  return {
    page_url: q.get("page_url") ?? request.headers.get("referer") ?? "",
    referrer: q.get("referrer") ?? "",
    utm_source: q.get("utm_source") ?? "",
    utm_medium: q.get("utm_medium") ?? "",
    utm_campaign: q.get("utm_campaign") ?? "",
  };
}

/** GET /api/m/funnel/f/:slug — the hosted form page (also what the iframe shows). */
export async function formPage(request: Request, { params }: Params): Promise<Response> {
  const form = await getFormBySlug(db(), params.slug ?? "");
  if (!form?.active) return notFoundPage();
  const business = await businessProfile();
  return html(hostedPage(business.name, toPublic(form), { tracking: trackingFrom(new URL(request.url), request) }), 200, form);
}

/** GET /api/m/funnel/f/:slug/thanks */
export async function thanksPage(_request: Request, { params }: Params): Promise<Response> {
  const form = await getFormBySlug(db(), params.slug ?? "");
  if (!form) return notFoundPage();
  const business = await businessProfile();
  return html(messagePage(business.name, "Thank you", form.thankYouMessage || `Thank you. ${business.name} has your message and will get back to you.`), 200, form);
}

async function readSmallBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** POST /api/m/funnel/f/:slug — a visitor sends the form (from the hosted page, the iframe or the owner's own HTML form). */
export async function submitForm(request: Request, { params }: Params): Promise<Response> {
  const form = await getFormBySlug(db(), params.slug ?? "");
  if (!form?.active) return notFoundPage();
  const business = await businessProfile();
  const pub = toPublic(form);
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") {
    return html(hostedPage(business.name, pub, { problem: "The form could not be read. Fill it in on this page and send it again." }), 415, form);
  }
  const body = await readSmallBody(request);
  if (body === null) return html(hostedPage(business.name, pub, { problem: "That is more text than this form takes. Shorten the message and send it again." }), 413, form);

  if (await overRateLimit(clientAddress(request), form.id)) {
    return html(messagePage(business.name, "Too many messages", "This form has had too many messages from your connection in the last few minutes. Wait ten minutes and send it again, or contact the business another way."), 429, form);
  }
  const values = Object.fromEntries(new URLSearchParams(body).entries());
  const thanks = form.redirectUrl || `${formPath(form.slug)}/thanks`;
  // A bot filled in the field people cannot see: thank it and keep nothing.
  if ((values[HONEYPOT_FIELD] ?? "").trim()) return new Response(null, { status: 303, headers: { location: thanks, "cache-control": "no-store" } });

  const parsed = publicSubmission(pub).safeParse(values);
  if (!parsed.success) {
    const keep = Object.fromEntries(Object.entries(values).filter(([k]) => k !== HONEYPOT_FIELD).map(([k, v]) => [k, v.slice(0, 3000)]));
    return html(hostedPage(business.name, pub, { values: keep, errors: fieldErrors(parsed.error), problem: "Some fields need attention. Check the messages below and send it again." }), 400, form);
  }
  const s = parsed.data;
  const lead = await createLead(
    db(),
    {
      name: s.name,
      email: s.email,
      phone: s.phone,
      company: s.company,
      message: s.message,
      service: s.service,
      contactMethod: s.contact_method,
      source: "form",
      sourceDetail: form.name,
      formId: form.id,
      pageUrl: s.page_url,
      referrer: s.referrer,
      utmSource: s.utm_source,
      utmMedium: s.utm_medium,
      utmCampaign: s.utm_campaign,
      consentText: form.consentText,
      assigneeId: form.assigneeId,
    },
    null,
  );
  const settings = await getSettings(db());
  await announceLead(lead, settings.targetMinutes).catch((error) => console.error("Leads: the new-lead notification failed:", error));
  kickDueEmails();
  return new Response(null, { status: 303, headers: { location: thanks, "cache-control": "no-store" } });
}

/** GET /api/m/funnel/unsubscribe/:token — asks to confirm (a link scanner opening the address changes nothing). */
export async function unsubscribePage(_request: Request, { params }: Params): Promise<Response> {
  const business = await businessProfile();
  const leadId = verifyUnsubscribeToken(params.token ?? "");
  if (!leadId) return html(messagePage(business.name, "This link does not work", "The unsubscribe link is incomplete or was changed. Use the link in the email exactly as it is, or reply to the email and ask to be taken off the list."), 404, null);
  const action = `/api/m/funnel/unsubscribe/${encodeURIComponent(params.token)}`;
  return html(
    messagePage(business.name, "Stop these emails?", `You will get no more follow-up emails from ${business.name} about your enquiry.`).replace(
      "</div></main>",
      `<form method="post" action="${action}" style="margin-top:16px"><button type="submit">Unsubscribe</button></form></div></main>`,
    ),
    200,
    null,
  );
}

/** POST /api/m/funnel/unsubscribe/:token — the opt-out itself (also what a mail program's one-click unsubscribe sends). */
export async function unsubscribe(_request: Request, { params }: Params): Promise<Response> {
  const business = await businessProfile();
  const leadId = verifyUnsubscribeToken(params.token ?? "");
  if (!leadId) return html(messagePage(business.name, "This link does not work", "The unsubscribe link is incomplete or was changed. Use the link in the email exactly as it is."), 404, null);
  await unsubscribeLead(leadId);
  return html(messagePage(business.name, "You are unsubscribed", `${business.name} will send you no more follow-up emails about your enquiry.`), 200, null);
}

export { TRACKING_FIELDS };
