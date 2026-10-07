# Evidence: Customers, run for real (2026-10-07)

Everything below ran on the developer's Windows machine: `next dev` on port
3093 against its own database `suite_customers` in the dev Postgres container
`suite-pg-dev` (PostgreSQL 16, port 5481), migrated by the suite's own runner
(`applied core/0000_core … customers/0000_customers, 4 migration(s) applied`).
Chromium was driven by a Playwright script (kept outside the repo, in the
agent's scratch folder) through the real pages; no mocks. No AI key was used:
the assistant's tools are covered by unit tests (`tests/unit/customers.test.ts`,
through the real `propose()`/`approve()` ledger), not by a live model call.

## 1. First-run setup seeds the invented examples

```
17:28:14 first page: http://localhost:3093/setup
17:28:17 setup done; seed ran
contacts: Ana Example | Office manager | Riverside Cafe (example) | ana@example.com | 555 0100 | example …
```

## 2. The main flow in the browser

- New contact Maria Gomez (company "Gomez Dental" created from the name).
- A call on the timeline; then a note holding a card number, refused:
  `Body: This looks like a payment card number. Card numbers must not be stored here: remove it (keep card details with your payment provider) and save again.`
- A follow-up due today; a deal "Surgery tap replacement" (680.00) moved on
  the Deals board from New lead to Quote sent:
  `timeline: Stage … Moved from New lead to Quote sent. | Call … Called: two leaking taps in the surgery, wants a visit next week.`
- Home: `needs me: Today: Book the visit with Maria | Customers · Maria Gomez`;
  one notification row `customers.follow_up_due | Due today: Book the visit with Maria`
  (`notified_at` set, so it is sent once).
- Global search "gomez": `Customers | Maria Gomez | maria@gomez-dental.example · +1 (512) 555-0144 | Gomez Dental | Company`.

## 3. CSV import with duplicates → ONE approval, decided in the inbox

Six rows: Maria again by email (with a new tag and a note), the seeded Ana by
phone with nothing new, Tom Baker twice (same phone), a row with a card
number, and Priya Shah. The approval's summary, as written by the import:

```
Rosa Owner imported a CSV with 6 rows: 2 new contacts, 1 merge into existing contacts (by email 1, phone 0, name 0).
1 row repeated a person already in the file and was combined with the first. 1 matched an existing contact that
already has everything in the row, so it was left out. 1 row was left out (row 6: This looks like a payment card
number. …). Merges only fill empty fields, add tags and add to the notes: nothing already filled in is overwritten.
```

Opened from Approvals (the inbox), "Approve all 3":

```
outcome: 3 records written.
per-row results: Merged into Maria Gomez: adds tag referral; adds to the notes | Added Tom Baker | Added Priya Shah
after reload, written count: 3
```

Database afterwards (`psql … -d suite_customers`):

```
 Maria Gomez  | maria@gomez-dental.example | +1 (512) 555-0144 | {vip,dental,referral} | Prefers mornings
 Tom Baker    | tom@baker-cafe.example     | 512 555 0190      | {}                    | Second line for Tom
 Priya Shah   | priya@shah-law.example     |                   | {vip}                 |
 Import 3 contacts | applied | total 3 | applied_count 3 | source import
```

Audit log: `approvals.proposed … 3 × Import a contact`, `approvals.approved`,
`customers.contact_added "Tom Baker" (imported, approved)`, `… "Priya Shah"`,
`approvals.applied "Import 3 contacts": 3 written.` (The merge's own audit entry,
`customers.contact_merged`, was added after this run; the unit tests cover it.)

Approving twice and two tabs approving: `tests/e2e/suite-customers.spec.ts`
approves the same import in a second tab: `This was already approved earlier. 0 records written.`

## 4. Phone and dark mode

At 390 × 844, dark: horizontal overflow 0 px on the contact page, the
contacts list and the Deals board (the board scrolls inside itself; it first
overflowed by 247 px because of a screen-reader-only label, fixed by making
the board a positioning container).

## 5. Checks

- `pnpm typecheck`, `pnpm lint` (with the dev build folder ignored), `pnpm test`:
  7 files, 294 tests passed (`SUITE_TEST_DATABASE=suite_customers_test`).
- `pnpm exec playwright test tests/e2e/suite-customers.spec.ts` on port 3093
  (database `suite_customers_e2e`): 1 passed. `smoke.spec.ts` (the approval
  page was touched): 2 passed, 1 skipped (the scaffold check, by design); one
  earlier run failed while other agents loaded the shared Postgres, and passed
  on the next run unchanged.
