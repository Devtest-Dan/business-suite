# Dependencies

Few and mainstream, on purpose: every one is something an intern meets again
elsewhere, and each was chosen over writing it ourselves only where getting it
wrong would be dangerous or slow. Versions are pinned in `pnpm-lock.yaml`.

## At run time (in the server image)

| Package | Why |
| --- | --- |
| `next`, `react`, `react-dom` | The app framework (App Router, Server Components, Server Actions). The AHL course teaches it. Built as a standalone server for the Docker image. |
| `drizzle-orm` | Typed SQL for PostgreSQL. Thin: the queries read like the SQL they run. |
| `postgres` | The PostgreSQL driver (postgres.js): pure JavaScript, no native build, also used by the migration and backup scripts. |
| `zod` | One schema per form, shared by the browser and the server; also the AI tools' input schemas (turned into JSON Schema for the model). |
| `@node-rs/argon2` | Argon2id password hashing with prebuilt binaries for Linux (glibc and musl, x64 and arm64): no compiler needed on the server. Hashing passwords by hand is not an option. |
| `web-push` | Web Push with VAPID keys (the payload encryption the browsers require). The approach Next.js's own PWA guide uses. |
| `nodemailer` | Sends invites and reset links through the owner's own SMTP account. No email service is required. |
| `server-only` | A marker that makes the build fail if server code is imported into the browser. |

Not dependencies, written here instead because they are small: the S3 client
(`lib/s3-sigv4.mjs`, AWS Signature V4, checked against AWS's own example), the
CSV reader (`lib/csv.ts`), the migration runner (`scripts/migrate.mjs`), the
icons (`lib/icons.tsx`) and the redaction (`lib/redact.ts`, copied from our own
AHL code). Chat adds none either: its live updates use Server-Sent Events and
PostgreSQL `LISTEN/NOTIFY` (no websocket server), and its Slack importer reads
ZIP files with a small reader on Node's own `zlib` (`modules/chat/zip.ts`).

## Only for development, tests and the build

| Package | Why |
| --- | --- |
| `typescript`, `@types/*` | Strict TypeScript. |
| `tailwindcss`, `@tailwindcss/postcss` | Styling (Tailwind v4), with the suite's design tokens in `app/globals.css`. |
| `drizzle-kit` | Generates SQL migrations from the Drizzle schemas (`pnpm suite:db:generate`). |
| `vitest` | Unit tests, run against a real PostgreSQL. |
| `@playwright/test` | The browser smoke test (setup → invite → sign in → announcement → approval). |
| `eslint`, `eslint-config-next` | Lint rules Next.js recommends. |
| `tsx` | Runs TypeScript scripts during development. |

## Services, not packages

- PostgreSQL 16 (`postgres:16-alpine` image), Caddy 2 (`caddy:2-alpine`, automatic HTTPS), Node 22 (`node:22-alpine`).
- Optional: Ollama (`ollama/ollama`) for a model on the same server.
- Optional: the business brain for the Assistant app, [GBrain](https://github.com/garrytan/gbrain)
  (MIT), built by `deploy/brain/Dockerfile` on `oven/bun:1.4.2-slim` from GitHub at
  v0.60.96.0 (commit `9dbc00c`, the version the AHL brain host runs), with GBrain's own
  lockfile. Why: one memory for the business that the assistant and interns' coding agents
  (over MCP) share, keyword-only, on the owner's server; writing our own would mean
  re-building GBrain's fact history, supersession and MCP surface. Off unless the owner
  runs `business-suite brain on`. No npm package was added for it: the suite talks to it
  over HTTP with `fetch`.
- No third-party auth, analytics, error tracking or CDN.
