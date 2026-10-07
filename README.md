# Business suite

A base for a small business's own software: the team's apps, on the owner's
own server, with an AI assistant that can look things up and propose changes
that a person approves. It replaces rented internal tools (team chat, tasks,
procedures, forms, a simple CRM, bookings, stock lists, dashboards) one app at
a time. It connects to, and never replaces, accounting, payments, payroll,
banking and email delivery, and it never holds regulated records.

- **Yours.** MIT licence. It runs on a server the owner rents and pays for
  (it is sized for 2 vCPU / 4 GB and up to 50 people). No service of ours in the middle.
- **One base, many apps.** Every app is a *module* in `modules/<id>/` that
  plugs into the shell: launcher and menu, home dashboard, global search,
  notifications (in-app and phone push), the activity log, permissions, AI
  tools and the shared approvals inbox. `pnpm suite:new-module <id>` starts one.
- **AI that asks first.** The assistant uses each app's tools. Reading happens
  at once; any write waits in Approvals. A batch of N records is one approval,
  and each record is written once, even if it is approved twice.
- **Cheap AI by default.** DeepSeek through its Anthropic-compatible API
  (thinking off), or a model on the server itself through Ollama. Personal
  details are redacted before anything leaves the server.

## What is in the box

| Part | Where |
| --- | --- |
| Accounts: email + password (Argon2id), invites, password resets, database sessions, roles owner/admin/member/guest, per-module permissions, sign-in limits | `lib/auth/`, `app/(auth)/`, `app/(shell)/people/` |
| Shell: launcher, menu, home ("what needs me", recent activity, app widgets), search, notifications, Web Push (PWA), audit log, file storage, settings, light/dark, phone layout | `app/(shell)/`, `components/`, `lib/` |
| The module contract and registry | `lib/modules/contract.ts`, `modules/registry.ts`, `modules/installed.json` |
| Approvals ledger (bulk approval, dedupe keys, atomic claims) | `lib/approvals/ledger.ts` |
| AI client and assistant | `lib/ai/client.ts`, `lib/ai/assistant.ts`, `lib/redact.ts` |
| Example module: Announcements (post, pin, read receipts, import, AI tools) | `modules/announcements/` |
| Deploy kit: Docker Compose (app, PostgreSQL 16, Caddy, backups), `install.sh`, `cloud-init.yaml`, `update.sh`, `restore.sh` | `deploy/` |

## Run it locally

```bash
docker run -d --name suite-pg-dev -e POSTGRES_USER=suite -e POSTGRES_PASSWORD=suite -p 5481:5432 postgres:16-alpine
cp .env.example .env.local        # then set SUITE_SECRET_KEY (the file says how)
pnpm install
pnpm db:migrate
pnpm dev                          # http://localhost:3081 opens the first-run setup
```

Checks: `pnpm typecheck && pnpm lint && pnpm test` (unit tests use a real
PostgreSQL; see `.env.example`) and `pnpm test:e2e` (browser smoke test).

## Put it on a server

The short version: open the latest release at
https://github.com/Devtest-Dan/business-suite/releases, download its
`cloud-init.yaml` (the release address and its SHA-256 are already filled in),
change the setup code, create an Ubuntu 24.04 server and paste the file into the
provider's "user data" box, wait ten minutes, open the address. The long
version, updates, backups and restore: [docs/DEPLOY.md](docs/DEPLOY.md).
Which provider: [docs/HOSTING.md](docs/HOSTING.md). What the owner must keep
doing: [docs/SECURITY.md](docs/SECURITY.md).

## Add an app

[docs/ADD_AN_APP.md](docs/ADD_AN_APP.md), written for an intern working with
Claude Code or Codex.

## Licence

MIT, see [LICENSE](LICENSE). Dependencies and why: [DEPENDENCIES.md](DEPENDENCIES.md).
