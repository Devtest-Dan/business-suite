# Add an app (a module)

For an intern adding an app to a business's suite with Claude Code or Codex.
Read it once yourself; then point your agent at it ("Read docs/ADD_AN_APP.md
and follow it").

An app is a **module**: one folder, `modules/<id>/`, that gives the shell a
**manifest**. The shell does the rest: it puts the app in the launcher and the
menu, serves its pages at `/m/<id>/...` after checking permissions, merges its
search results into global search, shows its widget and "what needs me" items
on the home page, delivers its notifications, offers its AI tools to the
assistant, and runs its writes through the approvals inbox. You never edit
shell code to add an app.

## 0. Before you start

- Know the business process you are building for, in the owner's words: who
  does what, how often, what goes wrong today. One app per process.
- Check the three-way rule: **replace** internal team tools (chat, tasks,
  procedures, forms, simple CRM, bookings, stock lists, dashboards);
  **connect, never replace** accounting, payments, payroll, banking and email
  delivery; **never** hold regulated records (health records, card numbers,
  government ids, payroll).
- Run the suite locally (README, "Run it locally") and look at the example
  module, `modules/announcements/`: it uses every part of the contract.

## 1. Scaffold it

```bash
pnpm suite:new-module stock-list "Stock list"
pnpm db:migrate
pnpm dev            # open http://localhost:3081/m/stock-list
```

You get a working module that keeps a list of "items": a page with a form, a
table with full-text search, a dashboard widget, two permissions, one read
and one write AI tool, and its first migration. It is already listed in
`modules/installed.json` (migration order) and `modules/registry.ts` (what the
build includes). Now rename "items" to what the app is really about.

## 2. The files

| File | What goes in it |
| --- | --- |
| `manifest.tsx` | The manifest (below). The only thing the shell reads. |
| `schema.ts` | The module's tables (Drizzle). Every table name starts with `<id>_` (dashes become underscores). |
| `migrations/` | Generated SQL. Never edit one that has been released; add a new one. |
| `drizzle.config.ts` | Points drizzle-kit at this module's schema and migrations folder. |
| `schemas.ts` | Zod schemas for every form and every AI/import input, shared by browser and server. |
| `data.ts` | Queries and writes (server only). |
| `actions.ts` | Server actions for forms. Each starts with `requireModule(MODULE_ID, permission)`. |
| `pages/*.tsx` | The pages, as React Server Components receiving `ModulePageProps`. |

## 3. The manifest

The full type is in `lib/modules/contract.ts`. In short:

```ts
interface ModuleManifest {
  id: string;                 // kebab-case: folder, URL segment, table prefix
  name: string;
  description: string;        // one line, shown in the launcher
  version: string;            // 1.0.0
  icon: IconName;             // from lib/icons.tsx
  nav: NavEntry[];            // menu entries: { label, path, icon?, permission? }
  permissions: PermissionDef[];   // { key: "<id>.<verb>", label, description, defaultRoles }
  routes: ModuleRoute[];      // { path: "" | "new" | ":itemId" | ":itemId/edit", title, permission?, page }
  migrations: { folder: "modules/<id>/migrations" };
  search?: SearchProvider;    // { label, permission?, search(ctx, query, limit) => SearchHit[] }
  notifications?: NotificationKind[]; // { kind: "<id>.<event>", label, pushByDefault }
  widget?: DashboardWidget;   // { title, permission?, render(ctx) => ReactNode }
  needsMe?: (ctx) => Promise<NeedsMeItem[]>;   // "what needs me" on the home page
  actions?: WriteAction[];    // the writes the AI or an import may PROPOSE (see 6)
  aiTools?: AiTool[];         // read tools run at once; write tools only propose
  api?: ModuleApiRoute[];     // { path, methods, auth: "session" | "self", permission?, handler } at /api/m/<id>/<path> (see 7a)
  seed?: (ctx) => Promise<void>;  // runs once, when the owner finishes setup or switches the app on
}
```

`pnpm suite:check` checks your manifest against the contract's rules and says
plainly what is wrong (ids, permission prefixes, routes the menu points at,
tool names, actions the tools refer to, ...).

## 4. Permissions

- Define one permission per thing a person may or may not do:
  `<id>.access` (open the app) and then verbs: `<id>.edit`, `<id>.approve`,
  `<id>.export` ... Give each sensible `defaultRoles`. The owner can change
  them all in Settings → Permissions; owners always hold everything.
- Put `permission` on every route and nav entry that needs one. The shell
  checks it before your page runs.
- **Check again in every server action** with `requireModule(MODULE_ID, P.edit)`.
  Hiding a button is never the check. Inside pages, use `ctx.can(P.edit)` to
  decide what to show.

## 5. Data

- Use `ctx.db` (Drizzle on PostgreSQL). Tables start with `<id>_`; reference
  core tables (e.g. `users`) with relative imports in `schema.ts`.
- After changing `schema.ts`: `pnpm suite:db:generate <id> <short-name>`,
  read the generated SQL, then `pnpm db:migrate`.
- For search, add a generated `tsvector` column with a GIN index (the scaffold
  shows how) and query it with `websearch_to_tsquery('simple', query)`.
- Record important changes in the activity log with `audit()` from
  `lib/audit.ts` (`visibility: "everyone"` if the whole team should see it in
  Recent activity). The log cannot be edited later, so write a clear summary.
- Tell people with `notify(userIds, { kind, title, body, url })` from
  `lib/notifications.ts`, using a kind you listed in `notifications`.

## 6. Writes the AI or an import can propose

A person filling in your form writes directly (through your server action).
The AI and bulk imports never do: they **propose**, and a person approves in
the shared Approvals inbox.

1. Define the write once as a `WriteAction` in `actions` (see the `post`
   action in `modules/announcements/manifest.tsx`):
   - `input`: the Zod schema for ONE record;
   - `preview(input)`: one line telling the approver exactly what will happen;
   - `dedupeKey(input)` (optional): a stable key for the record, e.g. a SKU or
     an external id. Without it the key is a hash of the record;
   - `sideEffects`: `"database"` when it only writes this suite's tables
     (inside `ctx.tx`), `"external"` when it calls another system;
   - `apply(ctx, input)`: do the write with `ctx.tx`, return `{ targetId, summary, after? }`.
     Put notifications in `after` (it runs after the commit).
   - `review(ctx, input)` (optional): more than the one-line preview, shown
     under the record on the approval page, e.g. a diff of a change against
     the current text (see `modules/docs/pages/reviews.tsx`). It may read
     with `ctx.db` but never writes; it runs for the first ten records of a
     batch, and must not show anything the viewing person (`ctx.viewer`) may
     not read.

     Put notifications in `after` (it runs after the commit). The approval page
     shows `summary` beside each written record, so make it say what really
     happened (e.g. "Merged into Ana Lima: fills phone").
2. Offer it to the AI with a write tool: `{ kind: "write", name: "create_order", description, action: "create_order" }`,
   or `batch: true` to take many records in one call.
3. For a bulk import, parse the file in a server action and call
   `propose({ action: "<id>.<action>", items, source: "import", requestedBy: ctx.viewer, keys })`
   (see `importAnnouncements` in `modules/announcements/actions.ts`).

What the ledger guarantees (`lib/approvals/ledger.ts`): a batch of N records
is ONE approval; each record has a ledger row keyed by `(action, dedupe key)`,
unique across all batches, so the same record is never proposed twice; before
a record is written its row is claimed with one conditional UPDATE, and the
write and the "applied" mark commit in one transaction, so approving twice,
retrying, or two people approving at once never writes a record twice.
Failures are kept per record, with the reason, and "Retry failed" writes only
those.

### Using another app (cross-app links)

Go only through the other app's registered write actions, and only when that
app is installed and switched on: `findModule("<id>")` (in this build) plus
`enabledModules()` (switched on). Never import its tables or code. From a
page, `propose({ action: "<other id>.<action>", source: "user", calledBy: MODULE_ID, ... })`, then
`approve()` at once if `canDecide()` says the person may; otherwise it waits in
Approvals. Inside your own approved `apply`, you may call the other action's
`apply` with the same `ctx` (in a savepoint: `ctx.tx.transaction(...)`), since
the approval already covered it; set `calledBy: MODULE_ID` on that context.
Either way the other app's `apply` sees `ctx.calledBy`, so it can say where the
record came from (Chat then labels a post "from Tasks"; without `calledBy` a
person's post has no label, and only the assistant's say "drafted by the assistant"). `modules/customers/follow-ups.ts`
(a follow-up becomes a task in the Tasks app) shows both.

## 7. AI read tools

```ts
defineReadTool<{ query: string }>({
  name: "search_orders",                 // lower_snake_case, unique across the suite
  description: "Full-text search of orders by customer or product.",   // the model reads this
  permission: P.access,                  // the asking person must hold it
  input: z.object({ query: z.string().min(1).max(200) }),
  run: async (ctx, { query }) => searchOrders(ctx, query, 10),
})
```

Return small, plain JSON (ids, names, dates as ISO strings); the result is
cut at 8,000 characters. The text is redacted before it is sent when the
owner has redaction on. Names the suite knows (team members, plus every
app's `knownNames`) leave as references such as `[name:kqxzbtpa]`, and the
suite puts the real name back into a tool's input before `run` sees it, so a
lookup by name works. Other names, emails and addresses become placeholders
such as [person], so return ids too.

If your app keeps records of people or organisations (customers, suppliers,
patients' guardians), add `knownNames: (ctx) => ...` to the manifest: the
names the viewer may see, newest first, a few thousand at most
(`knownCustomerNames` in `modules/customers/data.ts`).

## 7a. HTTP endpoints (`api`), when a page or action cannot do it

Most apps never need this. Pages are for people and forms post to server
actions. Use `api` for what those cannot do: a live stream (Server-Sent
Events), a download, a webhook from a supplier, an MCP address for a coding
agent, a feed another program reads. Each entry is served at
`/api/m/<id>/<path>` (one catch-all route, `app/api/m/[module]/[...path]`).
A switched-off app answers 404. Every entry says who authenticates the
request with `auth`:

```ts
// For the suite's signed-in people: the shell checks sign-in (401), the
// permission (403) and, for anything but GET, that the request comes from the
// suite's own pages; then it hands your handler the same `ctx` pages get.
api: [{ path: "events", methods: ["GET"], auth: "session", permission: P.access, handler: eventStream }],
// handler(request, { ctx, params })

// For machines: the shell checks nothing.
api: [{ path: "hooks/:hookId", methods: ["POST"], auth: "self", handler: async (request, { moduleId, params }) => { ... } }],
```

**With `auth: "self"` the shell signs no one in and checks no permission.
Your handler MUST authenticate every request itself** (e.g. a random token
you issued, stored only as a SHA-256 hash, checked before anything else) and
answer 401 otherwise. An endpoint that skips this is open to the internet.
`permission` is required with `"session"` and not allowed with `"self"`;
`pnpm suite:check` checks that, the paths and the methods.

Worked examples: `modules/chat/stream.ts` (`"session"`) is a Server-Sent
Events stream fed by Postgres `LISTEN/NOTIFY` (`modules/chat/realtime.ts`),
with a heartbeat and catch-up from the browser's `Last-Event-ID` after a
reconnect; no websocket server is needed. The Assistant app's coding-agent
address (`modules/assistant/agents.ts`, `handleMcp`, `"self"`) checks a
bearer token on every request.

An app that runs the assistant's tool loop itself can pass hooks to
`converse()` (`lib/ai/assistant.ts`): `beforeModelCall` (throw a `UserError` to
stop, e.g. a monthly limit) and `afterModelCall` (receives the provider's token
counts). The Assistant app uses them for the owner's monthly limit.

## 7b. Cross-app writes ("Create a task from this message")

An app never imports another app's code. To act in another app, find it
among the switched-on modules (`enabledModules()`), take one of its
registered `actions`, and `propose()` it with `source: "user"`, `calledBy: MODULE_ID`
(your app's id, so the record can say which app sent it) and a dedupe
key (so a double click does nothing twice). If the person may decide it
(`canDecide`), `approve()` it straight away; otherwise it waits in Approvals.
Hide the menu item when the app is not installed. See
`modules/chat/cross-app.ts` and `crossAppAction` in `modules/chat/actions.ts`,
and `modules/customers/tasks-link.ts`.

The common writes, and what to send them (their schemas are the source of
truth; add a unit test that your payload parses against them, as
`tests/unit/chat-cross-app.test.ts` does):

| App | Action | Input |
| --- | --- | --- |
| tasks | `create_task` (`modules/tasks/schemas.ts`, `taskInput`) | `project` (name or id, required), `createProjectIfMissing: true` to file into your own team project (Customers uses "Customer follow-ups", chat "From chat"), `title`, `description`, optional `dueOn`, `assignees`, and `sourceLabel` / `sourceUrl` (a path inside the suite) linking back |
| docs | `create_page` (`modules/docs/schemas.ts`, `createPageInput`) | `title`, `body` (Markdown), optional `spaceId` (default: the oldest team space), `note` |
| customers | `create_deal` (`modules/customers/schemas.ts`, `dealWithContactInput`) | `title`, `contact` (as Customers takes a contact: `name`, `email`, `phone`, `companyName`, …; merged into an existing contact with the same email, phone or name), optional `valueCents`, `notes`, `source` (one line, written into the deal's notes), `ownerEmail`. The deal goes into the first open stage. Read back how it went with the read tool `deal_outcomes` (`dealIds`); `modules/funnel/convert.ts` uses both |

## 8. Pages and design

- Pages are server components: `export async function ListPage({ ctx, params, searchParams, basePath }: ModulePageProps)`.
- Forms: `<ActionForm action={yourAction} submit="Save">` from
  `components/action-form.tsx` shows errors and success for you.
- Use the shell's classes (`h1`, `h2`, `card`, `btn`, `btn-primary`, `input`,
  `label`, `muted`, `badge`, `notice`, `table`) and colour utilities
  (`text-accent`, `bg-surface`, `border-line`, `text-subtle`). They work in
  light and dark and on phones. Check every page at phone width.
- Copy: plain and direct. Errors say what went wrong and what to do. No
  invented numbers.

## 9. Tests

- Unit tests in `tests/unit/` run against a real PostgreSQL (`pnpm test`):
  test your `data.ts` functions and every `WriteAction` through `propose()` and
  `approve()` (copy the pattern in `tests/unit/approvals-ledger.test.ts`).
- Extend the browser smoke test (`tests/e2e/smoke.spec.ts`) with the app's
  main path, or add a spec of its own (`tests/e2e/docs.spec.ts` is one).
- The unit tests recreate the database `suite_test` on every run. Set
  `SUITE_TEST_DATABASE=suite_<your app>_test` to use your own (when several
  people or agents share one PostgreSQL), and `SUITE_E2E_DATABASE_URL` for the
  browser tests. On Windows, write `127.0.0.1` rather than `localhost` in the
  database addresses: `localhost` can resolve to IPv6 first and time out.
- Each app has an owner's guide and an intern's guide in `docs/apps/<id>.md`.

  main path, or add `tests/e2e/<id>.spec.ts` (see `suite-customers.spec.ts`).
- Sharing one Postgres server with others? Give your run its own database:
  `SUITE_TEST_DATABASE=suite_<you>_test pnpm test`.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm suite:check` must pass.
- Two checkouts testing at once (two people, or two agents)? Give each its own
  test database: `SUITE_TEST_DATABASE=suite_test_<you> pnpm test`, and for the
  browser test `PORT=<free port> SUITE_E2E_DATABASE_URL=postgres://…/suite_e2e_<you> pnpm test:e2e`.

## 10. Ship it

1. Bump `version` in the module's manifest and in `package.json`.
2. Commit, then `SUITE_RELEASE_BASE=https://<where the files will be>/ pnpm release`
   makes three files in `dist/`: `business-suite-<version>.tar.gz`, its
   `.sha256`, and `cloud-init.yaml` with that address and the SHA-256 filled in
   (for a new server). Without `SUITE_RELEASE_BASE` the address is the suite's
   own GitHub release for that version.
3. Put the three files where the server can download them over HTTPS (a
   GitHub release of your own repository works:
   `gh release create v<version> dist/business-suite-<version>.tar.gz dist/business-suite-<version>.tar.gz.sha256 dist/cloud-init.yaml`;
   how the suite's own public releases are published is in
   [DEPLOY.md](DEPLOY.md), "1. The release"). Then on the server:
   `sudo business-suite update <address of the .tar.gz>`. It backs up first,
   runs your migrations, and rolls back by itself if the new version fails.

## Prompts that work well with an agent

- "Read docs/ADD_AN_APP.md and modules/announcements/. Then scaffold a module
  `stock-list` and change it to track products with SKU, name, quantity on
  hand and reorder level. Members can adjust quantities; admins can add
  products. Low stock shows in 'what needs me'."
- "Add a bulk import for products from CSV, keyed by SKU, that goes through
  propose() and the approvals inbox. Add unit tests that approving the batch
  twice writes each product once."
- "Add an AI read tool `low_stock` and a write tool `adjust_quantity` with a
  clear preview line."
- "Run pnpm typecheck, lint, test and suite:check and fix what fails."

## Checklist

- [ ] Tables start with `<id>_`; migration generated and read; nothing released was edited.
- [ ] Every route, nav entry, action and tool names a permission; every server action calls `requireModule`.
- [ ] Every form has a Zod schema in `schemas.ts`, used by the form's action.
- [ ] AI and imports only propose (`actions` + `propose()`); previews say exactly what will happen.
- [ ] Search, widget, "what needs me" and notifications added where they help.
- [ ] Activity log entries for important changes.
- [ ] Works on a phone, in light and dark.
- [ ] `docs/apps/<id>.md`: what it does (for the owner) and how to extend it (for the next intern). `docs/apps/tasks.md` is an example.
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm suite:check` pass.
