# Tasks

Projects and tasks for the whole team: who does what, by when. It replaces a
rented to-do or project tool for a team of up to 50.

## For the owner

**What it does**

- **Projects** with members. A *team* project is seen by everyone except
  guests; a *private* one only by its members (and by whoever manages
  projects: owners and admins by default). Guests see only projects they are
  added to.
- **Tasks** with one or more people assigned, a due date, a priority (low,
  normal, high, urgent), labels, a checklist, a description, comments,
  attached files and watchers. Every change is written to the task's
  **History**.
- **Three views of a project:** a **list** (search and filter by status,
  person, label and priority), a **board** (columns To do, Doing, Waiting,
  Done: drag a card, or use its "Move to" menu on a phone), and a
  **calendar** by due date (a month grid on a computer, a day-by-day list on a
  phone).
- **My tasks**: everything assigned to you across projects, grouped into
  Overdue, Today, Next 7 days, Later and No due date. **Calendar** in the menu
  shows your tasks (or everyone's) for a month.
- **Repeating tasks**: set "Repeats" on a task (every day, weekday, week,
  month or year). When it is done, the next copy is made with the next due
  date, once.
- **Templates**: steps you repeat (a new person starting, a typical job, the
  month-end). Each step has "days after start"; *Start a project* asks for a
  start date and fills in the real due dates. Any project can be saved as a
  template from its settings.
- **Reminders**: a task due today, or overdue, sends its people one
  notification each (in the suite and, if they switched it on, on their
  phone). Comments notify watchers; `@Name` in a comment notifies that person.
- **Home page**: the "Due today and overdue" card, and your late and due
  tasks under "What needs me".
- **Imports, always through Approvals** (one approval per file; approving
  twice never adds a task twice):
  - the **Tasks export** from the training platform's business dashboard
    (version 1 JSON). Each task keeps its id from the platform: importing the
    same file again adds nothing, and a newer export of a changed task
    updates it. Steps meant for "owner" and "intern" go to the people you
    choose;
  - a **CSV** from a spreadsheet (columns: title, description, status,
    priority, due, assignees, labels, checklist, key).
- **The assistant** can list projects and tasks, search them and say what is
  overdue at once. When it adds tasks (one or a whole plan) or changes a
  status, that waits in Approvals until someone approves it.

**Who can do what (change it in Settings → Permissions)**

| Permission | Default roles |
| --- | --- |
| See tasks | owner, admin, member, guest (guests: their projects only) |
| Comment on tasks | owner, admin, member, guest |
| Add and change tasks | owner, admin, member |
| Manage projects (create, members, archive, delete, templates; see every project) | owner, admin |
| Import tasks | owner, admin |

**Good to know**

- A new suite opens with clearly labelled **example data** ("Example: Shop
  window refresh" and "Example template: A new person starts"). Delete them
  in each one's Settings when you are ready.
- Reminders are checked whenever someone opens the home page (at most every
  five minutes), not by a clock on the server. In a team that opens the suite
  every working day this is the same; a suite nobody opens sends none.
- Archiving a project hides it from lists, My tasks and reminders and keeps
  everything. Deleting removes its tasks, comments and files for good.
- Attachments are limited to 10 MB each and are kept with the suite's other
  files (in the nightly backup when they are on the server's disk; in an S3
  bucket, rely on the bucket's versioning instead).

## For an intern extending it (with Claude Code or Codex)

Read `docs/ADD_AN_APP.md` first; this module follows it.

| File | What is in it |
| --- | --- |
| `modules/tasks/constants.ts` | Module id, permission keys, status/priority/repeat lists (the Postgres enums are built from these), notification kinds. Safe to import in the browser. |
| `modules/tasks/schema.ts` | Tables `tasks_projects`, `tasks_project_members`, `tasks_tasks`, `tasks_assignees`, `tasks_watchers`, `tasks_checklist_items`, `tasks_comments`, `tasks_attachments`, `tasks_activity`, `tasks_reminders`. |
| `modules/tasks/logic.ts` | Pure helpers: dates in the business's timezone, the next date of a repeating task, `@mention` matching, labels, board positions, the calendar grid. |
| `modules/tasks/schemas.ts` | Zod schemas for every form, the write actions and the AHL export file. |
| `modules/tasks/imports.ts` | AHL export (v1) and CSV → records for one batch approval. |
| `modules/tasks/data.ts` | Queries and writes (server only). `projectVisibleSql()` is the visibility rule; every viewer-facing query uses it. |
| `modules/tasks/actions.ts` | Server actions. Each starts with `requireModule(MODULE_ID, P.…)` and then checks the viewer can see the task or project. |
| `modules/tasks/manifest.tsx` | Routes, nav, permissions, search, widget, "what needs me", write actions, AI tools, seed. |
| `modules/tasks/pages/` | Pages (server components) and the board's client component. |

**Rules this module keeps**

- Visibility is checked in SQL (`projectVisibleSql`) and again in every
  action (`seeTask` / `seeProject`), never only by hiding buttons.
- The AI, imports and other apps never write directly: they propose a
  `WriteAction` and a person approves.
- A repeating task is copied once: the unique index on
  `tasks_tasks.recurrence_of` makes a second copy impossible.
- A reminder is sent once per task, kind and due date: the `tasks_reminders`
  row is inserted first (`on conflict do nothing`) and only an inserted row
  sends.
- An imported AHL task keeps its `externalId` (unique column); the ledger key
  is `ahl:<externalId>:<updatedAt>`.

**Using Tasks from another app** (for example chat's "Create a task from
this message"). Only when the tasks module is installed and switched on, and
only through its registered write action, never by importing its files:

```ts
import { propose } from "@/lib/approvals/ledger";
import { enabledModules } from "@/lib/modules/registry-access";

if ((await enabledModules()).some((m) => m.id === "tasks")) {
  const { approvalId } = await propose({
    action: "tasks.create_task",
    source: "user",
    requestedBy: ctx.viewer,
    title: "Create a task from a chat message",
    items: [{ project: "Shop", title: "Call Sam back", description: message.body, sourceLabel: "From chat: #general", sourceUrl: `/m/chat/…` }],
    keys: [`chat:${message.id}`],
  });
}
```

`tasks.create_task` takes: `project` (name or id, required), `title`
(required), `description`, `status` (todo, doing, waiting, done), `priority`
(low, normal, high, urgent), `dueOn` (YYYY-MM-DD or null), `assignees`
(emails or full names), `labels`, `checklist` (strings), `recurrence` (none,
daily, weekdays, weekly, monthly, yearly), `sourceLabel` and `sourceUrl` (a
path inside the suite, shown on the task as a link back).
`tasks.set_status` takes `taskId`, `status` and optionally `title` (if given,
it must match the task, or the record fails without changing anything).

**Prompts that work well**

- "Read docs/ADD_AN_APP.md and docs/apps/tasks.md. Add an 'estimate (hours)'
  field to tasks: schema, migration (`pnpm suite:db:generate tasks estimate`),
  the edit form, the list view and the AI's `list_tasks` output. Add a unit
  test."
- "Add a 'Blocked by' link between two tasks in the same project, shown on
  both task pages, with history entries."
- "Add a weekly summary notification on Monday mornings for each person's
  open tasks, sent once per person per week (copy the reminders' ledger
  pattern)."

**Tests**: `tests/unit/tasks-logic.test.ts` (pure helpers, the AHL file,
CSV), `tests/unit/tasks.test.ts` (real Postgres: visibility, repeats, board,
history, mentions, reminders, templates, the three write actions through the
ledger), `tests/unit/tasks-ai.test.ts` (the AI tools in the assistant loop),
`tests/e2e/tasks.spec.ts` (the main flow in a browser).
