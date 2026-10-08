# Customers (a light CRM)

## For the owner

Customers keeps the people and businesses you sell to, what you are trying to
sell them, what happened each time you spoke, and what you promised to do next.
It is sized for a small team (up to about 50 people) and lives on your own
server like the rest of the suite.

**What is in it**

- **Contacts and companies.** Name, email, phone, job title, address, notes,
  tags, an owner (the person in your team who looks after them) and a few
  fields of your own. Typing a company name on a contact links it to that
  company, or adds the company.
- **Deals and the pipeline.** A deal is something you hope to sell, with a
  value, an expected close date and a stage. The Deals page shows one column
  per stage; move a deal with the menu on its card. You choose the stages in
  *Pipeline and fields*: rename, add, reorder and remove them, and mark which
  ones mean "won" or "lost" (those close the deal). New installs start with
  New lead, Talking, Quote sent, Won and Lost.
- **The timeline.** Every contact, company and deal has a timeline of calls,
  emails, meetings and notes, plus each stage change. A company's timeline
  also shows everything logged for its people and its deals.
- **Follow-ups.** "Call back on Thursday" about a contact, company or deal,
  for anyone in the team. When the **Tasks** app is installed and switched on,
  a follow-up becomes a task there. Without it, the follow-up is a reminder
  here: it appears in *What needs me* on the home page when it is due, and
  the person gets one notification (and a phone push, if they allowed it).
- **Saved filters.** Filter a list by a word, a tag or an owner, then *Save
  this filter*. Keep it to yourself or share it with the team.
- **Import from CSV**, with duplicate detection (below), and **Export CSV** of
  any list as it is filtered.
- **The home page** shows your follow-ups that are due and how many open
  deals sit in each stage.
- **The assistant** can find a customer, summarise a customer's history, list
  follow-ups that are due and read the pipeline. It can also *propose* a
  note, a follow-up or a deal moving stage; nothing changes until a person
  approves it in Approvals.

**Importing contacts.** Choose a CSV file or paste its text on the Import page.
The first row names the columns (`name` or `first_name` + `last_name`,
`email`, `phone`, `company`, `job_title`, `address`, `tags`, `notes`,
`owner_email`, and your custom fields by their column name). The whole file
becomes **one approval**:

- each row is checked against your contacts: same email, then same phone
  (the last 10 digits, so "+1 (415) 555-0100" and "415 555 0100" match), then
  same name when no email or phone says they are different people;
- a match is proposed as a **merge**: it fills empty fields, adds tags and
  adds to the notes, and never overwrites what is already filled in;
- rows that repeat a person inside the file are combined first; rows that
  would add nothing new are left out; rows with problems (for example a card
  number) are left out and listed with their row number;
- the approval lists every row with what will happen to it, and after you
  approve, each row's result ("Added …", "Merged into …: fills phone; adds tag
  …"). Approving twice, or two people approving at once, never adds a row twice.

**Card numbers are never stored.** Every text field refuses anything that looks
like a payment card number (13 to 19 digits that pass the check card numbers
carry), with a message saying so. Keep card details with your payment
provider. Customers is not a place for health records, government ids or
other regulated records either.

**Who can do what** (change it in Settings → Permissions): members can see and
edit customers and log activity; owners and admins can also delete, change the
pipeline and fields, import and export. Guests cannot open Customers.

## For an intern extending it (with Claude Code or Codex)

Read `docs/ADD_AN_APP.md` first; this module follows it. Files in
`modules/customers/`:

| File | What it holds |
| --- | --- |
| `manifest.tsx` | Routes, nav, permissions, search, widget, needs-me, notification kinds, the four write actions and the AI tools. |
| `schema.ts` | Tables `customers_companies`, `customers_contacts`, `customers_stages`, `customers_deals`, `customers_activities`, `customers_follow_ups`, `customers_fields`, `customers_saved_filters` and their enums. |
| `schemas.ts` | Every Zod schema (forms, AI inputs, import rows). `safeText()` is the card-number guard for free text. |
| `card-guard.ts` | `looksLikeCardNumber()` (pure; Luhn + length + scheme prefix). |
| `dedupe.ts` | Duplicate detection and merging (pure). |
| `import.ts` | CSV → one approval (`planImport`), and the approved write per row (`applyImportRow`). |
| `follow-ups.ts` + `tasks-link.ts` | Follow-ups, and the link to the Tasks app. |
| `data.ts` | Queries and writes. `actions.ts`: server actions (each starts with `requireModule`). `pages/`: the pages. |
| `seed.ts` | The invented demo data (tagged `example`, emails at example.com). |

**Write actions** (what the AI or an import may propose; each is one record of
an approval): `customers.import_contact`, `customers.add_note`,
`customers.create_follow_up`, `customers.update_deal_stage`, and
`customers.create_deal` (a deal with its contact, deduplicated like an import
row; other apps use it, e.g. Leads converting a lead: `deal-with-contact.ts`).
AI tools: read `find_customers`, `customer_history`, `customer_follow_ups_due`,
`deals_by_stage`, `deal_outcomes` (how given deals stand, for other apps); write `add_customer_note` (and the batch
`add_customer_notes`), `create_customer_follow_up`, `update_deal_stage`.

**The Tasks link** is the pattern for any cross-app feature: use the other
app's *registered write action*, never its tables or code, and only when it is
installed and switched on (`tasksLink()`). From a page, the follow-up is
proposed to `tasks.create_task` with `source: "user"` and approved at once when
the person may (`canDecide`); otherwise it waits in Approvals. Inside an
approved write (the assistant's follow-up) the Tasks action's `apply` runs in
the same transaction, in a savepoint, so a refusal there leaves a reminder
here instead. Because the Tasks app is built separately, `taskShapes()` offers
the task as `{ title, description, dueDate, assigneeIds, … }` and a few smaller
shapes, and uses the first that the Tasks action's schema accepts; if none
fits, the follow-up stays a reminder here. If the Tasks app names its action
differently, add the name to `ACTION_NAMES` in `tasks-link.ts`.

**Reminders without a scheduler.** The suite has no job runner, so "due"
notifications are sent when the person's home page or the Follow-ups page
loads (`deliverDueReminders`, one conditional UPDATE per reminder, so each is
sent once).

**Prompts that work well**

- "Add a custom field type 'link' to Customers: schema enum, `checkCustomValues`,
  the form input and the details row. Add a migration with
  `pnpm suite:db:generate customers field-link`."
- "Add 'Merge two contacts' to the contact page for admins, reusing
  `mergeContact` from dedupe.ts, moving the timeline, deals and follow-ups, with
  a unit test."
- "Add an AI read tool `deals_closing_soon` (expected close within N days)."
- "Add a CSV import for companies, as one approval, deduped by name and website."

**Tests:** `tests/unit/customers.test.ts` (card guard, duplicate detection, the
import as one approval written once, the AI writes, reminders, seed, the Tasks
link) and `tests/e2e/suite-customers.spec.ts` (the main flow in a browser).
When several people share one Postgres server, give each run its own database:
`SUITE_TEST_DATABASE=suite_<you>_test pnpm test`.
