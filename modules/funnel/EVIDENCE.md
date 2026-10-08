# Evidence: Leads, run for real (2026-10-08)

Everything below ran on the developer's Windows machine: `next dev` on port
3102 against its own database `suite_funnel_e2e_a662` in the dev Postgres
container `suite-pg-dev` (PostgreSQL 16, port 5481), migrated by the suite's
own runner (`core/0000_core … chat/0001_chat_via_app, funnel/0000_funnel`;
`node scripts/migrate.mjs --status` → `database is up to date`). Chromium was
driven by `tests/e2e/funnel.spec.ts`
(`PORT=3102 SUITE_E2E_DATABASE_URL=… SUITE_E2E_EVIDENCE=modules/funnel/evidence pnpm test:e2e tests/e2e/funnel.spec.ts`
→ `1 passed (38.1s)`). Email went over real SMTP (nodemailer, `lib/mail.ts`)
to a local catcher (`tests/unit/smtp-catcher.ts`, a 70-line `net` server),
configured through Settings → Email like an owner would. No mocks. No AI key
was used: the AI tools are covered by unit tests through the real
`propose()`/`approve()` ledger, not by a live model call.

## 1. The form on another website, filled by an anonymous visitor

The owner's "website" was a separate HTTP server on `127.0.0.1:<random port>`
(another origin) holding the iframe snippet copied from the form's page
(`evidence/01-form-embed.png`). The visitor's browser context had no cookies.

- The iframe loaded and its script passed the parent page's address and the
  `utm_` values in (`evidence/02-owner-site-iframe.png`). The hosted page's
  headers (`evidence/hosted-page-headers.txt`):
  `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors *`
  alongside the shell's `x-frame-options: DENY`; Chromium obeyed
  `frame-ancestors` and showed the form.
- A message holding `4111 1111 1111 1111` was refused inside the iframe:
  `This looks like a payment card number. Card numbers must not be sent or stored here: …`
- The corrected form went through to the thank-you page (`evidence/03-thank-you.png`).

The stored lead:

```
name: Ana Reyes muys5hu4 · status: converted (at the end) · source: form "Website contact"
utm_source google · utm_medium cpc · utm_campaign spring
page_url http://127.0.0.1:65246/contact?utm_source=google&utm_medium=cpc&utm_campaign=spring
speed_seconds 13 (first contact logged by the owner)
```

## 2. The owner hears about it

- Home → What needs me: `New lead: Ana Reyes muys5hu4 · Web form · waiting under a minute`
  and the Leads widget (`evidence/04-home-needs-me.png`).
- One notification row: `funnel.new_lead | New lead: Ana Reyes muys5hu4` (`evidence/05-notification.png`).

## 3. A sequence: one approval, the email over SMTP, the unsubscribe link

- Before the postal address was set, Sequences said: "Add your business's
  postal address in Leads → Settings first. US law (CAN-SPAM) requires it …".
- The starter sequence (3 emails, days 0, 3, 7) was switched on and sent to the
  lead from its page: one approval, showing the first email as the lead would
  get it (`evidence/06-approval.png`). Approved → `1 record written.`
- The catcher received exactly one message (`evidence/sequence-email.eml`):

```
From: Greenleaf <hello@greenleaf.example>
To: ana-muys5hu4@example.test
Subject: Thanks for contacting Greenleaf Lawn Care muys5hu4

Hi Ana,
Thank you for asking about Lawn care. When is a good time for a quick call? …
--
Greenleaf Lawn Care muys5hu4
1200 Oak Street
Austin, TX 78701

You are getting this email because you contacted Greenleaf Lawn Care muys5hu4.
To stop these emails, open: http://localhost:3102/api/m/funnel/unsubscribe/9e48829d-….ouwDyd89…
```

- The visitor opened that link: a confirm page, then `You are unsubscribed`
  (`evidence/07-unsubscribed.png`). The sends afterwards:

```
position 1  sent       ana-muys5hu4@example.test  "Thanks for contacting Greenleaf Lawn Care muys5hu4"
position 2  cancelled
position 3  cancelled   (enrolment: stopped, "the lead unsubscribed")
```

## 4. First contact, then the conversion into Customers

- "Log it" (Called) → `Logged. Speed to lead: under a minute.`
- "Convert to customer" → the lead page shows "In Customers: the contact and
  the deal" (`evidence/08-lead-converted.png`), the contact page
  (`evidence/09-customers-contact.png`) and the deal in the first open stage
  with the source in its notes (`evidence/10-customers-deal.png`). In the database:

```
contact Ana Reyes muys5hu4 <ana-muys5hu4@example.test>
deal "Lawn care: Ana Reyes muys5hu4" in New lead
notes: Front and back lawn, every week from May.
       Source: Leads: Web form “Website contact”; utm_source=google, utm_medium=cpc, utm_campaign=spring; page http://127.0.0.1:65246/contact?…
```

## 5. The funnel report and its CSV

`evidence/11-report.png`, and `evidence/funnel-report.csv`:

```
source,leads,contacted,qualified,converted,won,disqualified,contacted_pct,qualified_pct,converted_pct,won_pct,median_speed_to_lead_min,won_value
Web form “Website contact”,1,1,1,1,0,0,100,100,100,0,0,0.00
Total,1,1,1,1,0,0,100,100,100,0,0,0.00
```

The lead page at phone width (390 px) has no horizontal scroll
(`evidence/12-phone-lead.png`).

## 6. Unit tests on a real database

`SUITE_TEST_ADMIN_URL=postgres://suite:suite@127.0.0.1:5481/suite SUITE_TEST_DATABASE=suite_funnel_a662 pnpm test`
→ `Test Files 18 passed (18) · Tests 425 passed (425)`; `tests/unit/funnel.test.ts`
has 15, including: two approvals of the same enrolment at once plus two send
runs at once deliver each email once over SMTP; a logged contact and an
unsubscribe cancel the rest; a forged unsubscribe token is refused; the rate
limit answers 429 and stores no address in clear.

## Not run here (one-time checks on a real server)

- A real SMTP provider (the owner's) and a real inbox: deliverability, the
  From address, spam placement.
- The iframe in Safari and Firefox, and inside a hosted website builder.
- The form behind Caddy on HTTPS (the `X-Forwarded-For` the rate limit reads).
