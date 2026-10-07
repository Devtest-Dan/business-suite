# Business suite: rules for coding agents

You are working on a small business's own suite of apps (Next.js 16 App
Router, TypeScript strict, Tailwind v4, PostgreSQL 16, Drizzle, Zod).

- Adding or changing an app: read `docs/ADD_AN_APP.md` first and follow it.
  Apps are modules in `modules/<id>/`; never edit shell code to add one.
- The module contract is `lib/modules/contract.ts`. Check with `pnpm suite:check`.
- Every server action starts with `requireModule(MODULE_ID, permission)` (modules)
  or `requirePermission(...)` (shell). Hiding a button is not a check.
- The AI and bulk imports never write directly: they `propose()` a `WriteAction`
  and a person approves (`lib/approvals/ledger.ts`).
- Module tables start with `<id>_`. Migrations are generated with
  `pnpm suite:db:generate <id>` and never edited after a release.
- Forms: a Zod schema shared by the form and the action; errors say what went
  wrong and what to do.
- Done means: `pnpm typecheck && pnpm lint && pnpm test && pnpm suite:check` pass.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
