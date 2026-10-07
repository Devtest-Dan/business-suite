# Evidence: the Tasks app, run for real (2026-10-07)

The real dev server (`next dev -p 3092`) on a fresh PostgreSQL 16 database
`suite_tasks` (the dev container `suite-pg-dev`), migrated by the real runner
(`pnpm db:migrate`: core 0000–0001, announcements 0000, tasks 0000), driven
in a real Chromium by a script (Playwright, headless). No mocks. The business
and people are invented ("Corner Bakery (test)", "Dana Owner"). Times UTC.

## What ran, in order (script output, trimmed)

```
17:20:06 first-run setup page
17:20:18 home: 1 due today Choose the new display theme Due today               ← the widget, from the seed
17:20:18 needs me: Due today: Choose the new display theme · Example: Shop window refresh
17:20:19 projects: Example: Shop window refresh  Example data, made up to show how Tasks works. … 4 open · 1 done
17:20:23 project list: Put the order form on the counter Due Nov 2 Dana Owner  Order extra flour and dried fruit Due Nov 10 …  Bake the first batch Due Dec 1 …
17:20:24 drag saved: HTTP 200                                                     ← a real mouse drag, To do → Doing
17:20:24 after drag + reload, Doing column: Doing 1 Put the order form on the counter …
17:20:25 approval: http://localhost:3092/approvals/0646b2bf-…                    ← the AHL Tasks export (v1 JSON, 3 tasks), pasted
17:20:26 inbox: Approvals … Waiting for you  Import 3 tasks from a Tasks export into “Steps for Corner Bakery (test)”  Import for Dana Owner · 3 records … Waiting
17:20:26 items: 1 Add or update “Share a safe sample of the order book” (To do) · from Proposal: Order reminders  Waiting
                2 Add or update “List the three questions customers ask most”, due 2026-10-14 (To do) · from Operations advisor note  Waiting
                3 Add or update “Agree the first week's check-in time”, due 2026-10-09 (Doing) · from Proposal: Order reminders  Waiting
17:20:27 outcome: 3 records written.                                              ← "Approve all 3" in the inbox
17:20:28 same file again: Every task in this file was already imported (and has not changed since), so there is nothing new to approve.
17:20:29 my tasks: … Today (1) Choose the new display theme … Next 7 days (2) … List the three questions customers ask most · Steps for Corner Bakery (test) · Due Oct 14 …
17:20:30 search: Tasks  Share a safe sample of the order book  Steps for Corner Bakery (test) · To do · Twenty past orders as a spreadsheet …
17:20:32 phone light board: horizontal overflow 0px      (390 × 844)
17:20:33 phone light my-tasks: horizontal overflow 0px
17:20:34 phone light calendar: horizontal overflow 0px
17:20:35 phone dark board: horizontal overflow 0px
17:20:35 phone dark my-tasks: horizontal overflow 0px
17:20:36 phone dark calendar: horizontal overflow 0px
```

## The database afterwards

```
approvals:  Import 3 tasks from a Tasks export into “Steps for Corner Bakery (test)” | applied | total 3 | applied 3 | duplicates 0   (one approval)
approval_items (dedupe keys):
  0 applied ahl:6f1c0e8a-0d5b-4c2e-9a41-2f7d3b1e9c10:2026-10-07T10:00:00.000Z
  1 applied ahl:6f1c0e8a-0d5b-4c2e-9a41-2f7d3b1e9c11:2026-10-07T10:00:00.000Z
  2 applied ahl:6f1c0e8a-0d5b-4c2e-9a41-2f7d3b1e9c12:2026-10-07T10:00:00.000Z
tasks_tasks (not templates), 11 rows:
  Christmas orders               | Put the order form on the counter           | doing   (moved on the board)
  Christmas orders               | Order extra flour and dried fruit / Bake the first batch | todo
  Example: Shop window refresh   | 5 example tasks (seed)
  Steps for Corner Bakery (test) | 3 imported tasks, external_id set, source_label "Imported: Proposal: Order reminders" / "Imported: Operations advisor note"
tasks_reminders: 1 row  →  notifications: tasks.due "Due today: Choose the new display theme" (sent once)
notifications: approvals.requested "Waiting for approval: 3 × Import a task from a Tasks export"
```

The second import of the same file made no approval and left no project
behind (an earlier run had shown an empty "new project" left over in that
case; fixed in `importAhlAction`, which now removes it).

Screenshots (desktop home, My tasks, board, approval before/after, calendar,
task page; phone light and dark: board, My tasks, calendar) were checked by
eye and kept outside the repository (scratchpad `suite-tasks/shots/`).

## Bugs the real run found (both fixed, both now covered by tests)

1. Project cards said "0 open · 0 done" for a project with five tasks.
   Drizzle leaves the table name off a column when a query has one table, so
   `t.project_id = "id"` inside the count subquery bound to the subquery's own
   table. Raw subqueries now use fully qualified names (`PROJECT_ID`,
   `TASK_ID` in `data.ts`); `tests/unit/tasks.test.ts` checks the counts.
2. The leftover empty project above.

## Automated checks (same day)

- `pnpm typecheck`, `pnpm lint`: clean.
- `pnpm test`: 9 files, 310 tests passed (tasks: 31 of them, against a real
  PostgreSQL database `suite_tasks_test`).
- `pnpm suite:check`: 8 passed (the tasks manifest follows the contract).
- `pnpm test:e2e` on port 3092 with database `suite_tasks_e2e`: smoke (2) and
  tasks (1) passed, scaffold test skipped as designed.

## Not run here

- **The assistant with a real model.** No AI key on this machine. The tasks
  tools ran inside the real assistant loop against a local stand-in of the
  provider's API (`tests/unit/tasks-ai.test.ts`: `overdue_tasks` read at
  once, `create_tasks` became ONE approval, approving twice wrote each task
  once). One-time check with a real DeepSeek key: `docs/LAUNCH.md` 5ab.2.
- **Web Push on a phone** for task reminders (in-app notifications ran).
