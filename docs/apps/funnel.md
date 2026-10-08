# Leads (the front and the measure of the funnel)

## For the owner

Leads catches the people who ask about your work (from your website, the
phone or the front door), makes sure someone gets back to them quickly, sends
them a few follow-up emails if nobody reaches them, turns the real ones into
customers in the **Customers** app, and shows you where your customers come
from. It is sized for a small team (up to about 50 people, a few thousand
leads a year) and lives on your own server like the rest of the suite.

**What is in it**

- **Lead forms for your website.** In *Lead forms*, make a form: its heading,
  which fields it asks (name always; email, phone, company, message, the
  service wanted from your own list, preferred contact method) and a consent
  box in your own words that the visitor must tick. Each form has its own page
  on the suite that works without signing in and shows your business name;
  link to it, or paste one of its two snippets into your website: an
  **iframe** (the form appears inside your page) or a **plain HTML form** you
  can style yourself. After sending, the visitor sees your thank-you message,
  or goes to a page of yours. You choose who new leads from a form go to.
- **Where each lead came from.** The form, the page it was on, the referrer,
  and `utm_source`, `utm_medium` and `utm_campaign` from your ads' links.
- **The lead list.** Status *new → contacted → qualified → converted*, or
  *disqualified* with a reason. Assign a lead to someone. The oldest new leads
  come first: that is the order to call people back in.
- **Speed to lead.** The time from a lead coming in to the first contact
  someone logs ("Called", "Emailed", "Left a voicemail" …). It is on every
  lead and in the list, in red when it is over your target (15 minutes until
  you change it in *Settings*).
- **New-lead alerts.** A new lead tells the person it is assigned to, or,
  when nobody is, everyone holding *Get new-lead alerts* (owners and admins
  at first): in the app and as a phone push, and in *What needs me* on the
  home page until someone contacts them.
- **Add a lead by hand** for a phone call, a walk-in or a referral, with how
  they reached you.
- **Make them a customer.** One click on a lead adds the contact (or merges
  it into an existing one with the same email, phone or name, as Customers
  always does) and a deal in the first open stage of your pipeline, with where
  the lead came from in the deal's notes. This needs the Customers app
  switched on; without it the button says so.
- **Follow-up emails (sequences).** Write a few short emails over a few days
  (up to five), using `{first_name}`, `{business_name}` and `{service}`. Tick
  leads and send them a sequence: that is **one approval** for all of them,
  and nothing is sent until someone approves. Each email goes out on its day,
  through your own email account (*Settings → Email*). Every email ends with
  your business name, your **postal address** and an **unsubscribe link**, as
  US law (CAN-SPAM) requires: until you enter the postal address in *Leads →
  Settings*, no sequence can be switched on. A sequence stops by itself for a
  lead who replies (press *They replied*), is contacted, converted or
  disqualified, or unsubscribes. The same lead never gets the same sequence
  twice. **Leads never sends text messages.**
- **The funnel report.** For the dates you pick, per source (or per
  `utm_source` or `utm_campaign`): how many leads came in, how many were
  contacted, qualified, converted and won (read from Customers' deals), the
  share that made it from each step to the next, the median speed to lead and
  the value of the deals won. A bar chart of the funnel, and *Export CSV*.
- **Import from CSV** (an old spreadsheet, a trade-show list): one approval;
  rows that repeat an email or phone number, in the file or already here, are
  left out and counted. Imported leads get no alerts and are left out of the
  speed-to-lead numbers.
- **The home page** shows new leads today, how many nobody has contacted, and
  the median speed to lead over the last seven days.
- **The assistant** can list the leads nobody has contacted and read the
  funnel report. It can also *propose* a status change or sending a sequence;
  nothing changes until a person approves it in Approvals.

**What it protects.** The public form refuses anything that looks like a
payment card number, takes only a small amount of text, ignores bots that
fill in a hidden field, and turns away a connection that sends more than five
forms in ten minutes (or a form that gets more than sixty in an hour). It
never shows one visitor anything about another lead. Network addresses are
not stored, only a scrambled form of them for the counters.

**Who can do what** (change it in Settings → Permissions): members see and
work leads (add, log contacts, change status, assign, convert, send
sequences for approval); owners and admins also make forms and sequences,
change the settings, delete leads and import. Guests cannot open Leads.

**Good to know**

- Sequence emails go out when the suite is in use (someone opens the home
  page or Leads, a visitor sends a form, or an approval is made), because the
  suite has no clock of its own yet. A quiet weekend can delay an email until
  the next visit.
- The iframe works in current browsers. If a very old browser will not show
  it, use the plain HTML form snippet or a link to the form's page.
- Lead and visitor details stay on your server. Leads is not a place for
  health details, government ids or card numbers.

## For an intern extending it (with Claude Code or Codex)

Read `docs/ADD_AN_APP.md` first; this module follows it. Module id `funnel`,
tables `funnel_*`. Files in `modules/funnel/`:

| File | What it holds |
| --- | --- |
| `manifest.tsx` | Routes, nav, permissions, the public `api` entries, search, widget, needs-me, notification kinds, the three write actions, the AI tools and `knownNames`. |
| `schema.ts` | `funnel_settings` (one row), `funnel_forms`, `funnel_leads`, `funnel_lead_events`, `funnel_sequences`, `funnel_sequence_steps`, `funnel_enrollments`, `funnel_sends`, `funnel_rate_hits`. |
| `schemas.ts` | Every Zod schema: the public submission (`publicSubmission(form)`), the team's forms, the AI and import inputs. `safeText()` is the card guard. |
| `logic.ts` | Pure helpers: labels, templates, footer, durations, median, keys. `card-guard.ts` and `csv-out.ts` are copies of Customers' (apps never import each other). |
| `data.ts` | Settings, forms, leads, the timeline, status changes, speed to lead, alerts, needs-me, widget numbers, search. |
| `public.ts` + `embed.ts` | The `auth: "self"` handlers (form page, submission, thank-you, unsubscribe) and the HTML they serve, plus the two snippets. |
| `sequences.ts` | Sequences, enrolment (`proposeEnrollment`, `applyEnroll`), sending (`sendDueEmails`, `kickDueEmails`), unsubscribe tokens. |
| `convert.ts` | The link to Customers: `customersLink()`, `convertLead`, `settleConversion`, `dealOutcomes`. |
| `report.ts` | The funnel report and its CSV. `import.ts`: CSV → one approval. `actions.ts`: server actions. `pages/`: the pages. |

**The public endpoints** (`/api/m/funnel/...`, `auth: "self"`, so the shell
checks nothing): `f/:slug` (GET the page, POST a submission), `f/:slug/thanks`,
and `unsubscribe/:token` (GET asks, POST does it). A submission must be
`application/x-www-form-urlencoded` and at most 16 KB; it is counted in
`funnel_rate_hits` (keyed by an HMAC of the address and by form) before
anything else; a filled `website` field is the honeypot. The pages carry a
Content-Security-Policy whose `frame-ancestors` lists the form's allowed
websites (any, when empty), which current browsers obey over the shell's
`X-Frame-Options: DENY`. The unsubscribe token is the lead id plus an
HMAC-SHA256 of it under `SUITE_SECRET_KEY`. The shell matches an API path
before its method, so one path with two methods is ONE entry whose handler
branches on `request.method`.

**Write actions:** `funnel.update_lead_status`, `funnel.enroll` (dedupe key
`<lead>:<sequence>`, with a `review` that shows the first email as the lead
would get it) and `funnel.import_lead`. AI tools: read `new_leads` (also lists
the sequences that are on), `funnel_summary`; write `update_lead_status`,
`enroll_in_sequence` (batch). Converting is a person's click, not an AI tool.

**The Customers link** goes only through Customers' registered tools, and
only when Customers is installed and switched on: the write action
`customers.create_deal` (input `dealWithContactInput` in
`modules/customers/schemas.ts`: the contact, a title, a value, notes, the
source line, the owner's email) and the read tool `deal_outcomes` (stage,
open/won/lost and value of given deal ids). From the lead page the deal is
proposed with `source: "user"` and the key `funnel:convert:<lead>:<attempt>`,
and approved at once when the person may decide it (members may: they hold
`customers.edit`); otherwise it waits in Approvals and the lead page settles
it once approved. A unit test parses `dealInputFor()` against Customers'
schema.

**Sending without a scheduler.** Due emails are claimed with one conditional
UPDATE (`for update skip locked`), then sent, then marked; two runs at once
never send the same email twice. A claim left by a crash is marked failed
after ten minutes, never resent by itself (the email may have gone). Runs are
scheduled with Next's `after()` from the home page, the Leads pages, a form
submission and an approval.

**Prompts that work well**

- "Add a 'won/lost' column to the Leads list, read through Customers'
  `deal_outcomes` tool, for converted leads."
- "Add a per-form 'Send me a copy' option that emails the assigned person each
  new lead through lib/mail.ts."
- "Count business hours only in speed to lead, using opening hours set in
  Leads → Settings, with unit tests."

**Tests:** `tests/unit/funnel.test.ts` (the public form: valid, honeypot,
card number, size, rate limit, switched off; speed to lead and statuses;
conversion through Customers with dedupe and with Customers off; sequences
blocked without a postal address, one approval, sent once when approved twice
and run twice at once, over real SMTP to `tests/unit/smtp-catcher.ts`;
unsubscribe and a logged contact stop them; permissions per role; the report
numbers; the AI tools and the import) and `tests/e2e/funnel.spec.ts` (the
whole path in Chromium, the form in an iframe on another origin). Evidence of
a real run: `modules/funnel/EVIDENCE.md`.
