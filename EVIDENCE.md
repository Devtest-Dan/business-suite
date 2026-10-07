# Evidence: the suite on a fresh Ubuntu server (2026-10-07)

No secrets below: generated passwords and keys were never printed, and the
`.env` listing shows names only. Times are UTC. Everything ran on the
developer's Windows machine; no real server, domain, AI key, SMTP provider or
bucket was used (those one-time checks are listed at the end).

## Setup

- **The "server":** one Ubuntu 24.04.5 container with systemd as PID 1 and
  cloud-init 26.1 installed, as on provider images, and **no Docker**. Capped
  at `--memory 2g --memory-swap 2g --cpus 2` (the smallest size the suite
  supports). Privileged, so systemd and the Docker that `install.sh` installs
  can run inside it; Docker's and containerd's storage on volumes (overlayfs
  cannot nest on overlayfs). Ports: 8443 → 443, 8080 → 80.
- **The few-clicks path, for real:** the release's own `deploy/cloud-init.yaml`
  was given to cloud-init as NoCloud "user data" before first boot, exactly as
  a provider's user-data box does. Only the `CHANGE` lines were filled in
  (release URL served from the developer machine over HTTP, its SHA-256, setup
  code `evidence-7319`, domain `suite.127-0-0-1.sslip.io`, timezone), plus two
  test-only lines: `SUITE_LOCAL_CERTS=1` (Caddy's own CA, since there is no
  public IP for Let's Encrypt) and `SUITE_PUBLIC_URL` with `:8443` (the port map).
- **Release:** `business-suite-0.1.0.tar.gz` made by `scripts/release.sh` from
  commit `5169650`, SHA-256 `bcce1795…669d`.
- Two harness fixes on the way, both about the test box, not the kit: the first
  boot had no `lsb-release` (cloud-init wrote `UNAVAILABLE` into apt sources;
  provider images have it), and the second put containerd's storage on
  overlayfs. `install.sh` stopped with its own message each time ("Install
  stopped: a command failed on line …").

## 1. cloud-init → install.sh: 3 min 19 s from first boot to healthy

```
Cloud-init v. 26.1-0ubuntu1~24.04.1 running 'init-local' at Wed, 07 Oct 2026 16:18:22 +0000.
Cloud-init v. 26.1-0ubuntu1~24.04.1 finished at Wed, 07 Oct 2026 16:21:41 +0000. Datasource DataSourceNoCloud
$ cloud-init status --long
status: done            (recoverable warnings: SSH host keys only; the test image has no OpenSSH)

/var/log/business-suite-install.log (build output trimmed):
/root/business-suite.tar.gz: OK
==> Checking the server
    Ubuntu 24.04.5 LTS
    2 CPU, 3917 MB memory            (the VM's; the container is capped at 2 GB)
==> Base packages
==> Docker
    Docker version 29.8.2, build 7fc2dff, 5.6.0
==> The release
    downloading http://host.docker.internal:8099/business-suite-0.1.0.tar.gz
    SHA-256 checked
    version 0.1.0
==> Address
    https://suite.127-0-0-1.sslip.io
==> Secrets and settings (/opt/business-suite/.env)
    kept: database password and encryption key (made once, never printed)
==> HTTPS (Caddyfile)
    local certificates (browsers will warn): for testing only
==> Building the app image (a few minutes the first time)
    #14 24.27 ✓ Compiled successfully in 22.2s
    #14 51.50 ✓ Generating static pages using 1 worker (21/21) in 409ms
==> Starting
==> Waiting for the app to answer /health
{"ok":true,"version":"0.1.0","database":"ok","migrations":3,"ms":1}
==> Done. The business suite 0.1.0 is running.
    Open:        https://suite.127-0-0-1.sslip.io:8443
    Setup code:  evidence-7319   (the first-run page asks for it)
```

What it left on the server:

```
-rw------- root   /opt/business-suite/.env     POSTGRES_PASSWORD SUITE_SECRET_KEY SUITE_HOME SUITE_VERSION SUITE_DOMAIN
                                               SUITE_URL SUITE_SETUP_CODE SUITE_TZ BACKUP_HOUR BACKUP_KEEP_DAYS BACKUP_S3_* FILES_S3_*
-rw-r--r-- root   /opt/business-suite/Caddyfile  (local_certs; suite.127-0-0-1.sslip.io → reverse_proxy app:3000, HSTS)
current -> /opt/business-suite/releases/0.1.0
images: business-suite-app:0.1.0 312MB, caddy:2-alpine 93.1MB, postgres:16-alpine 420MB

$ business-suite status
business-suite-app-1      business-suite-app:0.1.0   Up 32 seconds (healthy)
business-suite-backup-1   business-suite-app:0.1.0   Up 33 seconds
business-suite-caddy-1    caddy:2-alpine             Up 32 seconds   0.0.0.0:80->80, 0.0.0.0:443->443 (tcp+udp)
business-suite-db-1       postgres:16-alpine         Up 43 seconds (healthy)

$ curl https://suite.127-0-0-1.sslip.io:8443/health   → 200 {"ok":true,"version":"0.1.0","database":"ok","migrations":3}
$ curl http://suite.127-0-0-1.sslip.io:8080/          → 308 https://suite.127-0-0-1.sslip.io/
```

## 2. Through Caddy: setup → invite → sign in → announcement → bulk approval twice

The Playwright smoke test (`tests/e2e/smoke.spec.ts`) against the HTTPS
address, with the setup code:

```
$ SUITE_E2E_RUN=evidence SUITE_E2E_SETUP_CODE=evidence-7319 SUITE_E2E_BASE_URL=https://suite.127-0-0-1.sslip.io:8443 npx playwright test
  ✓ setup → invite → sign in → announcement → bulk approval (twice, written once) (13.1s)
$ ... npx playwright test -g "same moment"
  ✓ two people pressing Approve at the same moment still write each record once (4.9s)
```

The first test: setup page with the code creates the owner; People → invite a
member (no SMTP yet, so the link is shown to copy); a 3-row CSV import becomes
one approval and posts nothing; the approval is opened in two tabs and
approved in each, one after the other (the second says "This was already
approved earlier. 0 records written."); the owner posts an announcement; the
member opens the invite link in another browser, creates the account, sees
"Read: Team lunch …" under What needs me, opens it, cannot open Import,
signs out and back in; the owner sees the read receipt and the audit trail;
global search finds an imported post. The second test: a 5-row import approved
from two separate browser sessions at the same moment.

The database on the server afterwards:

```
 role   | name        | hash_prefix
 owner  | Olive Owner | $argon2id$v=19$m=19456,t=2,p=1
 member | Max Member  | $argon2id$v=19$m=19456,t=2,p=1

 title                  | source | status  | total | applied_count
 Import 3 announcements | import | applied |     3 |             3     ← approved twice (two tabs)
 Import 5 announcements | import | applied |     5 |             5     ← approved twice at the same moment

 ledger rows of the 3-row batch: every one applied, attempts = 1
 ledger rows of the 5-row batch: every one applied, attempts = 1
 posts per imported title: 1 each (3 + 5 posts, 5 distinct "Shift note" titles)

 audit_log for the 5-row batch:
 approvals.proposed | Olive Owner proposed 5 × Post an announcement.
 approvals.approved | Olive Owner approved "Import 5 announcements".
 approvals.applied  | "Import 5 announcements": 2 written.      ← one approver's share
 approvals.applied  | "Import 5 announcements": 3 written.      ← the other's; nothing written twice

 read receipts on "Team lunch evidence": Olive Owner, Max Member

$ psql -c "update audit_log set summary = 'tampered' where id = 1"
ERROR:  audit_log is append-only: UPDATE is not allowed
$ psql -c "delete from audit_log where id = 1"
ERROR:  audit_log is append-only: DELETE is not allowed
```

## 3. RAM (2 GB box, example module installed)

`docker stats` inside the server:

| | app | PostgreSQL | Caddy | backup | total |
| --- | --- | --- | --- | --- | --- |
| Idle, just installed (16:22) | 60.6 MiB | 40.5 MiB | 12.0 MiB | 44.2 MiB | 157 MiB |
| Idle after the smoke tests (16:38) | 55.0 MiB | 56.8 MiB | 21.0 MiB | 12.3 MiB | 145 MiB |
| Highest sample during load (below) | 165.9 MiB | 74.7 MiB | 23.6 MiB | 12.3 MiB | 277 MiB |
| One minute after the load | 81.8 MiB | 56.0 MiB | 22.5 MiB | 11.0 MiB | 171 MiB |

The load: 800 signed-in page loads of the dashboard, Announcements, a post,
search, Approvals, Activity, Notifications and Apps, 20 at a time, through
Caddy: 31.2 s (25.7 pages/s), every one 200, p50 403 ms, p95 2,553 ms (on a
laptop's Docker VM with nested containers; a real server is faster).
Building the image is the heaviest moment: Next.js compiled in 22 s inside the
2 GB cap (the build is limited to 1.5 GB of heap).

## 4. Backups, updates with rollback, restore, reset link

```
$ business-suite backup
backup: 2026-10-07T16-25-40Z done in 0.2s: db 45693 bytes, files 108 bytes
manifest.json: version 0.1.0, db.dump and files.tar.gz with sizes and SHA-256
settings row 'backup': {"ok": true, "at": "2026-10-07T16:25:41.047Z", ...}   (shown in Settings → Business)

$ business-suite update http://host.docker.internal:8099/business-suite-0.1.1.tar.gz --yes   (16:25:41 → 16:27:17)
==> Getting the release
    SHA-256 checked                      (from the .sha256 next to the release)
    from 0.1.0 to 0.1.1
==> Backup before the update
    /opt/business-suite/backups/2026-10-07T16-25-42Z-pre-update-0.1.1
==> Building 0.1.1 (the current version keeps running)
==> Switching to 0.1.1
==> Waiting for /health
{"ok":true,"version":"0.1.1","database":"ok","migrations":3,"ms":1}
==> Updated to 0.1.1.

$ business-suite update http://host.docker.internal:8099/business-suite-0.1.2.tar.gz --yes   (a release whose new migration fails)
    from 0.1.1 to 0.1.2
==> Backup before the update
    /opt/business-suite/backups/2026-10-07T16-27-19Z-pre-update-0.1.2
==> Building 0.1.2 (the current version keeps running)
==> Switching to 0.1.2
==> Waiting for /health
==> Rolling back to 0.1.1
    the failed run's log: /opt/business-suite/update-0.1.2-failed.log   (app-1 | Migration failed: division by zero)
Stopped: the update to 0.1.2 failed and was rolled back: 0.1.1 is running again with the data from just before the update.
exit=1
afterwards: SUITE_VERSION=0.1.1, current -> releases/0.1.1, /health ok version 0.1.1,
            suite_migrations unchanged (3 rows), posts 10 before and 10 after

$ (insert a post "Written after the backup"; posts: 11)
$ business-suite restore 2026-10-07T16-27-19Z-pre-update-0.1.2 --yes
==> Checking …   checksums match
==> Stopping the app / Restoring the database / Restoring the files / Starting
==> Restored 2026-10-07T16-27-19Z-pre-update-0.1.2.
posts after restore: 10; "Written after the backup": 0

$ business-suite reset-link owner-evidence@example.test
Reset link for Olive Owner (works once, for 24 hours):
https://suite.127-0-0-1.sslip.io:8443/reset/<token>
→ the page answers "Choose a new password"; audit: "A reset link for Olive Owner was made on the server."
```

The two update releases were test fixtures made from the current commit:
0.1.1 with only the version changed, 0.1.2 with one more core migration
(`SELECT 1/0`).

## 5. Email over SMTP (an SMTP sink on the developer machine)

Settings → Email (host = the Docker host's address, port 2525), then "Send test
email" and People → invite. The page said "Sent to owner-evidence@example.test"
and "Invite emailed to new.hire@example.test"; the sink received:

```
From: Acme Bakery <team@example.test>
To: new.hire@example.test
Subject: Olive Owner invited you to Acme Bakery evidence
Olive Owner invited you to Acme Bakery evidence's suite as member. Open this link to choose your name and password. It works once, for 7 days:
https://suite.127-0-0-1.sslip.io:8443/invite/<token>
```

## 6. On the developer machine

- `pnpm typecheck && pnpm lint && pnpm test` in `suite/`: 6 files, 279 tests,
  against a real PostgreSQL 16 (the approvals ledger: one approval per batch,
  approving twice, two concurrent approvers on 30 records, cross-batch
  duplicates, partial failure per record and retry, stale and fresh claims,
  approve-selected, decline; accounts: first-run race, sign-in limits, invites
  used once under a race, reset links; the AI tool loop against a local
  stand-in of the Anthropic and OpenAI APIs: thinking disabled, redaction of
  emails and phone numbers before sending, write tools becoming approvals,
  members not offered writes they cannot do; the module contract; S3 SigV4
  against AWS's published example signature; the ported redaction cases).
- `pnpm test:e2e` (Playwright, `next dev` on 3081, fresh database): the smoke
  test and the concurrent-approval test pass.
- `pnpm suite:new-module stock-list "Stock list"` → typecheck, lint and the
  contract check passed, its migration applied, and in the browser the new app
  opened from the launcher, saved an item and global search found it
  (`SUITE_E2E_SCAFFOLD=stock-list`, 2 passed); then removed again.
- The production image (`docker build`, 312 MB) ran against a fresh database:
  migrations applied by `scripts/migrate.mjs`, then the smoke test passed
  against it.

## Not run here (one-time checks for the founder, docs/LAUNCH.md 5z)

- A real VPS with a public IP: Let's Encrypt via Caddy (here: Caddy's local CA).
- A real AI call (no DeepSeek key on this machine): Settings → AI → "Send a test message".
- Web Push to a real phone.
- A real SMTP provider and a real S3-compatible bucket for off-site backups.
- Ubuntu 26.04 and ARM servers.
