# Evidence: Docs on the real suite (2026-10-07)

What ran: the suite's dev server (`next dev -p 3094`) on a fresh PostgreSQL 16
database `suite_docs` in the dev container `suite-pg-dev`, migrated by the
real runner (`pnpm db:migrate`: core, announcements, docs), driven in
Chromium by a Playwright script. Nothing was mocked except one thing, said
plainly: **the AI model**. No AI key is available on this machine, so the
assistant talked to a local stand-in server that speaks the Anthropic Messages
wire format (the suite's real AI client, tool loop, redaction and approvals
ran unchanged). The stand-in only chose which tools to call; the docs tools
and the approval did the rest. A run against DeepSeek remains a one-time check
for the owner (Settings → AI, then ask the assistant to change a page).

## The path, as the script logged it

```
1. opened /, landed on /setup
   owner created; home shows the Docs widget: Procedures today Closing checklist (example) not started
   Opening checklist (example) not started Recently edited Opening checklist (example) Olive Owner, Oct 7, …
2. Handbook space tree: Start here (example) | Closing checklist (example) | New starter onboarding (example) | Opening checklist (example)
3. run 3ef5ede2-… status: Done | Float counted (amount): 150.00. Done by Olive Owner, Oct 7, 2026, 11:00 PM
4. preview link found: Opening checklist (example)
5. history: Version 2 | Current | Olive Owner, … | Loaves too | Version 1 | Olive Owner, … | First version
   after restore: Version 3 · Olive Owner, Oct 7, 2026, 11:00 PM
6. checklist is linked from: Allergen labels Handbook / Start here (example) Handbook
6b. attached and downloaded: /api/files/e3d380f1-… 200 "Contains: wheat, egg, milk."
7. import approval: 3654cadf-… reviews shown: 2
   outcome: 2 records written.
8. the assistant used: 4 model calls; tools offered include search_docs, read_doc_page, list_doc_spaces,
   draft_doc_page, draft_doc_pages, propose_doc_change
   the approval shows: Change to Opening checklist (example) in Handbook, drafted from version 1:
   Coffee machine warm-up | Text: +2 −0 lines | … | + Switch the coffee machine on first: it needs 20 minutes to warm up.
   outcome: 1 record written.
```

The assistant's turn: `search_docs("opening checklist")` → `read_doc_page(id)`
(returned version 1) → `propose_doc_change({ pageId, baseRevision: 1, body, note })`
→ "waiting in Approvals". The approval page showed the diff; the owner approved
it in the inbox.

## Rows afterwards

```
$ select title, kind, revision, jsonb_array_length(steps) steps, schedule from docs_pages order by created_at
 Opening checklist (example)      | procedure | 2 | 4 | daily      ← changed by the approved AI draft, steps kept
 Closing checklist (example)      | procedure | 1 | 4 | weekdays
 New starter onboarding (example) | procedure | 1 | 4 | none
 Meeting notes (template)         | page      | 1 | 0 | none
 Procedure (template)             | procedure | 1 | 2 | none
 Start here (example)             | page      | 1 | 0 | none
 Allergen labels                  | page      | 3 | 0 | none       ← written, edited, version 1 brought back
 Deliveries                       | page      | 1 | 0 | none       ← imported (approval)
 Weekly deep clean                | procedure | 1 | 3 | weekly     ← imported (approval), steps from the numbered list

$ revisions of the opening checklist
 1 | user | Olive Owner | Example content
 2 | ai   | Olive Owner | Coffee machine warm-up

$ revisions of Allergen labels
 1 | user | First version / 2 | user | Loaves too / 3 | restore | Brought back version 1

$ docs_runs / docs_run_steps
 Opening checklist (example) | completed | 2026-10-07 | Olive Owner | flagged false | 4 steps
 0 Olive Owner "" / 1 Olive Owner "yes" / 2 Olive Owner "150.00" / 3 Olive Owner ""

$ docs_links
 Allergen labels → Opening checklist (example)
 New starter onboarding (example) → Start here (example)
 Start here (example) → Opening checklist (example)      ← written before its target existed; found when the target was saved

$ approvals
 docs.import_page | import | applied | 2 | 2
 docs.edit_page   | ai     | applied | 1 | 1

$ docs_attachments
 label-sample.txt | text/plain | 27
```

The activity log has one entry per change, e.g. `Olive Owner edited "Opening
checklist (example)" (drafted by the assistant, approved).` and `"Import 2
Markdown files into Handbook": 2 written.`

## A bug the real path found

The first run showed, in the approval's diff, that the assistant's change would
**delete all four steps** of the checklist: the change only sent new text, and
the schema's `.default([])` turned "steps left out" into "no steps". The diff
made it visible before approving; the fix (`editPageInput` uses schemas
without defaults, so a field left out stays as it is) has a unit test ("a
proposed change that leaves out the steps (or the text) keeps them as they
are"), and the second run above kept the steps.

## Screenshots (kept in the session's scratch folder, `suite-docs/real/`)

`01-home-with-docs-widget`, `02-docs-home`, `03-space`, `04-run-finished`,
`05-editor-preview`, `06-version-diff`, `07-import-approval` (two diffs),
`08-assistant`, `09-ai-change-diff`, `10-ai-change-diff-phone` (390 px),
`11-run-phone-dark`, `12-page-phone-dark`. Checked by eye: phone width has no
sideways scrolling, the diff wraps, dark mode keeps the green/red contrast.

## Checks

- `pnpm typecheck`, `pnpm lint`: clean.
- `pnpm test` (with `SUITE_TEST_DATABASE=suite_docs_test`): 8 files, all passing
  (29 Docs tests in `docs-text.test.ts` and `docs.test.ts`).
- `pnpm suite:check`: the contract test passes with Docs installed.
- Playwright on port 3094, database `suite_docs_e2e`: `docs.spec.ts` passed
  (1.2 min); `smoke.spec.ts` (the approval page was touched) passed, 2 of 2.
