import { CONTACT_METHOD_LABELS, CONTACT_METHODS, escapeHtml, FORM_FIELD_LABELS, type FormField } from "./logic";

/**
 * The public form, as HTML: the hosted page the suite serves, and the two
 * snippets the owner pastes into their website (an iframe of the hosted
 * page, or a plain HTML form that posts to the suite). Pure, so the pages and
 * the tests share it. Everything put into the HTML is escaped.
 */

export interface PublicForm {
  slug: string;
  heading: string;
  fields: FormField[];
  services: string[];
  consentText: string;
}

export const formPath = (slug: string) => `/api/m/funnel/f/${slug}`;

/** Where the visitor came from, carried in hidden fields. */
export const TRACKING_FIELDS = ["page_url", "referrer", "utm_source", "utm_medium", "utm_campaign"] as const;
export type Tracking = Partial<Record<(typeof TRACKING_FIELDS)[number], string>>;

const css = `
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1c2024;background:#f6f7f9}
main{max-width:560px;margin:0 auto;padding:24px 16px}
.card{background:#fff;border:1px solid #dfe3e8;border-radius:12px;padding:20px}
.biz{font-size:14px;font-weight:600;color:#4b5563;margin:0 0 4px}
h1{font-size:22px;line-height:1.3;margin:0 0 16px}
label{display:block;margin:0 0 14px}
.l{display:block;font-weight:600;font-size:14px;margin-bottom:4px}
input[type=text],input[type=email],input[type=tel],select,textarea{width:100%;font:inherit;padding:10px 12px;border:1px solid #c5ccd5;border-radius:8px;background:#fff;color:inherit}
textarea{min-height:110px;resize:vertical}
.consent{display:flex;gap:10px;align-items:flex-start;font-size:14px}
.consent input{margin-top:4px;width:18px;height:18px;flex:none}
.err{color:#b42318;font-size:14px;margin-top:4px}
.alert{background:#fef3f2;border:1px solid #fecdca;color:#912018;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:14px}
button{font:inherit;font-weight:600;background:#1f5eff;color:#fff;border:0;border-radius:8px;padding:11px 18px;cursor:pointer;width:100%}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #9db7ff;outline-offset:1px}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
.small{font-size:13px;color:#4b5563;margin:14px 0 0}
@media (prefers-color-scheme:dark){body{background:#0f1215;color:#e6e8eb}.card{background:#171b1f;border-color:#2b3137}.biz,.small{color:#a3abb5}input[type=text],input[type=email],input[type=tel],select,textarea{background:#0f1215;border-color:#3a424b}.alert{background:#2a1513;border-color:#5c2620;color:#fda29b}.err{color:#fda29b}}
`;

/** A whole HTML page with the module's styles. */
export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${css}</style></head><body><main>${body}</main></body></html>`;
}

function field(name: string, label: string, input: string, errors: Record<string, string>): string {
  const err = errors[name] ? `<span class="err" id="${name}-err">${escapeHtml(errors[name])}</span>` : "";
  return `<label><span class="l">${escapeHtml(label)}</span>${input}${err}</label>`;
}

function attrs(name: string, errors: Record<string, string>): string {
  return `name="${name}" id="${name}"${errors[name] ? ` aria-invalid="true" aria-describedby="${name}-err"` : ""}`;
}

/** The form's inner HTML (fields, consent, honeypot, hidden tracking fields and the button), posting to `action`. */
export function formHtml(f: PublicForm, action: string, options: { values?: Record<string, string>; errors?: Record<string, string>; tracking?: Tracking } = {}): string {
  const v = options.values ?? {};
  const e = options.errors ?? {};
  const val = (k: string) => escapeHtml(v[k] ?? "");
  const shows = (k: FormField) => f.fields.includes(k);
  const both = shows("email") && shows("phone");
  const parts: string[] = [];
  parts.push(field("name", "Your name", `<input type="text" ${attrs("name", e)} required maxlength="160" autocomplete="name" value="${val("name")}">`, e));
  if (shows("email")) parts.push(field("email", "Email", `<input type="email" ${attrs("email", e)} maxlength="254" autocomplete="email"${both ? "" : " required"} value="${val("email")}">`, e));
  if (shows("phone")) parts.push(field("phone", "Phone", `<input type="tel" ${attrs("phone", e)} maxlength="40" autocomplete="tel"${both ? "" : " required"} value="${val("phone")}">`, e));
  if (both) parts.push(`<p class="small" style="margin:-6px 0 14px">An email or a phone number is enough.</p>`);
  if (shows("company")) parts.push(field("company", FORM_FIELD_LABELS.company, `<input type="text" ${attrs("company", e)} maxlength="160" autocomplete="organization" value="${val("company")}">`, e));
  if (shows("service") && f.services.length) {
    const opts = [`<option value="">Choose…</option>`, ...f.services.map((s) => `<option${v.service === s ? " selected" : ""}>${escapeHtml(s)}</option>`)].join("");
    parts.push(field("service", FORM_FIELD_LABELS.service, `<select ${attrs("service", e)}>${opts}</select>`, e));
  }
  if (shows("contact_method")) {
    const opts = [`<option value="">No preference</option>`, ...CONTACT_METHODS.map((m) => `<option value="${m}"${v.contact_method === m ? " selected" : ""}>${CONTACT_METHOD_LABELS[m]}</option>`)].join("");
    parts.push(field("contact_method", "How should we contact you?", `<select ${attrs("contact_method", e)}>${opts}</select>`, e));
  }
  if (shows("message")) parts.push(field("message", "How can we help?", `<textarea ${attrs("message", e)} maxlength="3000">${val("message")}</textarea>`, e));
  parts.push(
    `<label class="consent"><input type="checkbox" name="consent" value="on" required${v.consent === "on" ? " checked" : ""}${e.consent ? ' aria-invalid="true"' : ""}><span>${escapeHtml(f.consentText)}</span></label>${e.consent ? `<p class="err" style="margin-top:-8px">${escapeHtml(e.consent)}</p>` : ""}`,
  );
  // People never see this field; bots that fill every field in do.
  parts.push(`<div class="hp" aria-hidden="true"><label>Leave this empty <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>`);
  for (const k of TRACKING_FIELDS) parts.push(`<input type="hidden" name="${k}" value="${escapeHtml((options.tracking?.[k] ?? v[k] ?? "").slice(0, 500))}">`);
  parts.push(`<button type="submit">Send</button>`);
  return `<form method="post" action="${escapeHtml(action)}" novalidate>${parts.join("")}</form>`;
}

/** The hosted page: the business's name, the heading and the form. */
export function hostedPage(businessName: string, f: PublicForm, options: { values?: Record<string, string>; errors?: Record<string, string>; tracking?: Tracking; problem?: string } = {}): string {
  const alert = options.problem ? `<div class="alert" role="alert">${escapeHtml(options.problem)}</div>` : "";
  return page(
    `${f.heading || "Contact us"} · ${businessName}`,
    `<div class="card"><p class="biz">${escapeHtml(businessName)}</p><h1>${escapeHtml(f.heading || "Get in touch")}</h1>${alert}${formHtml(f, formPath(f.slug), options)}</div>`,
  );
}

export function messagePage(businessName: string, heading: string, text: string): string {
  return page(`${heading} · ${businessName}`, `<div class="card"><p class="biz">${escapeHtml(businessName)}</p><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(text)}</p></div>`);
}

/** The iframe snippet. A few lines of script pass the page's address and utm_ values to the form. */
export function iframeSnippet(publicUrl: string, slug: string): string {
  const src = `${publicUrl}${formPath(slug)}`;
  const id = `lead-form-${slug}`;
  return [
    `<iframe id="${id}" src="${src}" title="Contact form" style="width:100%;max-width:600px;height:760px;border:0" loading="lazy"></iframe>`,
    `<script>(function(){var f=document.getElementById(${JSON.stringify(id)});if(!f)return;var u=new URL(f.src),q=new URLSearchParams(location.search);["utm_source","utm_medium","utm_campaign"].forEach(function(k){if(q.get(k))u.searchParams.set(k,q.get(k))});u.searchParams.set("page_url",location.href.split("#")[0]);if(document.referrer)u.searchParams.set("referrer",document.referrer);f.src=u.toString();})();</script>`,
  ].join("\n");
}

/** The plain HTML form snippet: the same fields, posting straight to the suite (the thank-you page or your own page follows). */
export function htmlSnippet(publicUrl: string, f: PublicForm): string {
  const id = `lead-form-${f.slug}`;
  const form = formHtml(f, `${publicUrl}${formPath(f.slug)}`).replace("<form ", `<form id="${id}" `).replace(/<div class="hp"[^>]*>/, '<div aria-hidden="true" style="position:absolute;left:-10000px">');
  return [
    form.replace(/></g, ">\n<"),
    `<script>(function(){var f=document.getElementById(${JSON.stringify(id)});if(!f)return;var q=new URLSearchParams(location.search);function s(n,v){var i=f.querySelector('input[name="'+n+'"]');if(i&&v)i.value=v}s("page_url",location.href.split("#")[0]);s("referrer",document.referrer);["utm_source","utm_medium","utm_campaign"].forEach(function(k){s(k,q.get(k))});})();</script>`,
  ].join("\n");
}
