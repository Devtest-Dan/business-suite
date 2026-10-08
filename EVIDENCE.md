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

## 7. Deploy kit fixes (2026-10-08, on the developer machine)

- **The setup code from cloud-init.yaml's example is never used.**
  `install.sh`'s `setup_code_ok` and `pick_setup_code` were cut out of the
  script by line pattern and run in a bash harness (Git Bash), one case each:

  ```
  the published example is refused           => random code, replaced=1, the three-line notice printed
  the example in capitals is refused         => random code, replaced=1
  too short (7 characters) is refused        => random code, replaced=1
  empty makes a random code quietly          => random code, replaced=0
  a real code ("blue-heron-42") is used      => blue-heron-42
  re-run keeps the stored code               => the stored code
  the example on a re-run keeps the stored   => the stored code, one notice line
  the example stored by an older install     => random code, replaced=1
  ```

  All eight passed. The notice: "setup code: the one given cannot be used: it
  is the example from cloud-init.yaml or shorter than 8 characters. A new
  random code was made instead. It is printed at the end of this install and
  kept in /opt/business-suite/.env (see it again with: sudo grep
  SUITE_SETUP_CODE /opt/business-suite/.env)." The whole install was not run
  again for this change.
- **`pnpm release` writes three files.** Run twice from the same commit:
  `business-suite-0.1.0.tar.gz` (828,845 bytes, the same SHA-256 both times:
  files are now stamped with the commit's time, where before every run gave a
  different file), its `.sha256` (`sha256sum -c` OK), and `cloud-init.yaml`,
  which differs from `deploy/cloud-init.yaml` only in `SUITE_RELEASE_URL`
  (`https://github.com/Devtest-Dan/business-suite/releases/download/v0.1.0/business-suite-0.1.0.tar.gz`)
  and `SUITE_RELEASE_SHA256` (the archive's). With
  `SUITE_RELEASE_BASE=https://files.example.test/suite/` the address became
  `https://files.example.test/suite/business-suite-0.1.0.tar.gz`. The `dist/`
  output was deleted afterwards; nothing was published.
- **Push keys after a restore with another `SUITE_SECRET_KEY`:** a unit test on
  the real database (`tests/unit/auth.test.ts`) stores a push key this server's
  key cannot open; the suite makes a new pair and forgets the old phone
  subscriptions instead of failing every push.

## 8. v0.1.1 with all seven apps (2026-10-09)

The runs below were on 2026-10-08 between 00:27 and 00:53 UTC. The same test
server as in Setup (Ubuntu 24.04.5 container, systemd + cloud-init
26.1, no Docker, privileged, `--memory 2g --memory-swap 2g --cpus 2`, Docker
and containerd storage on volumes, 8443 → 443 and 8080 → 80), booted fresh for
each run from the release's own `dist/cloud-init.yaml` as NoCloud user data.
Apps: Announcements, Tasks, Docs, Customers, Assistant, Chat, Leads (funnel).

- **Release:** `business-suite-0.1.1.tar.gz` (1,791,007 bytes) made by
  `pnpm release` from commit `b265d25`, SHA-256 `60c9b3bb…ba94`, served over
  HTTP from the developer machine (`python -m http.server 8099`).
- **The user data:** `dist/cloud-init.yaml` with only `SUITE_RELEASE_URL`
  changed (to `http://host.docker.internal:8099/business-suite-0.1.1.tar.gz`),
  the setup code, domain `suite.127-0-0-1.sslip.io` and timezone
  `America/New_York`, plus the two test-only lines (`SUITE_PUBLIC_URL` with
  `:8443`, `SUITE_LOCAL_CERTS=1`). The SHA-256 line came filled in by
  `pnpm release`.

### 8a. The published example setup code is refused (found a hole, fixed)

A first boot with `SUITE_SETUP_CODE=choose-a-code-only-you-know` left as
published. The install log said:

```
==> Secrets and settings (/opt/business-suite/.env)
    setup code: the one given cannot be used: it is the example from cloud-init.yaml or shorter than 8 characters.
    A new random code was made instead. It is printed at the end of this install and kept in /opt/business-suite/.env
    (see it again with: sudo grep SUITE_SETUP_CODE /opt/business-suite/.env). Next time, change SUITE_SETUP_CODE before pasting cloud-init.yaml.
...
==> Done. The business suite 0.1.1 is running.
    Open:        https://suite.127-0-0-1.sslip.io:8443
    Setup code:  a6bb51-7d9e75   (the first-run page asks for it)
                 made here, because the code given was the example from
                 cloud-init.yaml or shorter than 8 characters
```

But the setup page then **accepted the example code** and made a stranger the
owner: inside the app container `SUITE_SETUP_CODE` was 27 characters long (the
example), not the random code in `.env`. Cause: cloud-init's runcmd runs
`set -a; . /root/business-suite-install.env` before `install.sh`, and
`docker compose` lets the caller's environment override `--env-file`. Fix
(commit `b265d25`): `compose()` in `deploy/install.sh`, `deploy/lib.sh` and
`deploy/suite.sh` runs `env -u <every name in .env> docker compose ...`, so
`.env` is what the containers get. `tests/unit/deploy-env.test.ts` cuts each
script's `compose()` out and runs it in bash with the cloud-init variables set
and a stand-in `docker`: all three pass.

Re-run on a fresh box with the fixed release (cloud-init 00:38:22 → 00:42:56,
4 min 34 s): the same three notice lines and a new random code `91ca25-410c90`;
the app container's `SUITE_SETUP_CODE` is 13 characters. In Chromium:

```
example code -> error: That setup code is wrong. It is in the server's install output (/var/log/business-suite-install.log
                after a cloud-init install), or the SETUP_CODE line you put in the cloud-init text. If that line was the
                example or shorter than 8 characters, the install made a random code instead.
still on /setup
printed code -> signed in at / heading: Hello, Pat
```

### 8b. cloud-init → install.sh: 3 min 58 s from first boot to healthy

With the setup code `evidence-0111-harbor`:

```
booted 2026-10-08T00:43:42Z
Cloud-init v. 26.1-0ubuntu1~24.04.1 running 'init-local' at Thu, 08 Oct 2026 00:43:47 +0000.
Cloud-init v. 26.1-0ubuntu1~24.04.1 finished at Thu, 08 Oct 2026 00:47:45 +0000. Datasource DataSourceNoCloud
$ cloud-init status --long   → status: done (recoverable warnings: SSH host keys only; the test image has no OpenSSH)

/var/log/business-suite-install.log (build output trimmed):
==> Checking the server
    Ubuntu 24.04.5 LTS
    2 CPU, 3917 MB memory            (the VM's; the container is capped at 2 GB)
==> Docker
    Docker version 29.8.2, build 7fc2dff, 5.6.0
==> The release
    downloading http://host.docker.internal:8099/business-suite-0.1.1.tar.gz
    SHA-256 checked
    version 0.1.1
==> Building the app image (a few minutes the first time)
    #12 [deps 5/5] RUN pnpm install --frozen-lockfile   DONE 26.4s
    #14 29.61 ✓ Compiled successfully in 28.0s
    #14 73.85 ✓ Generating static pages using 1 worker (21/21) in 455ms
==> Waiting for the app to answer /health
{"ok":true,"version":"0.1.1","database":"ok","migrations":11,"ms":1}
==> Done. The business suite 0.1.1 is running.
    Open:        https://suite.127-0-0-1.sslip.io:8443
    Setup code:  evidence-0111-harbor   (the first-run page asks for it)

$ docker buildx history ls     → 0.1.1   Completed   2m 18s      (the image build)
images: business-suite-app:0.1.1 327MB, caddy:2-alpine 93.1MB, postgres:16-alpine 420MB
suite_migrations: core 0000_core, 0001_audit_log_append_only, 0002_approvals_called_by; announcements 0000;
                  tasks 0000; docs 0000; customers 0000; assistant 0000; chat 0000, 0001_chat_via_app; funnel 0000
$ curl https://suite.127-0-0-1.sslip.io:8443/health   → {"ok":true,"version":"0.1.1","database":"ok","migrations":11,"ms":2}
$ curl http://suite.127-0-0-1.sslip.io:8080/          → 308 https://suite.127-0-0-1.sslip.io/
```

The three boots of this release took 5 min 43 s (the first, before the fix:
cold package downloads, `next build` 114.7 s), 4 min 34 s and 3 min 58 s
(`next build` 76.2 s and 74.9 s). The 0.1.0 build with one app took 3 min 19 s.

### 8c. Through Caddy in Chromium: every app, one write each, Leads, bulk approval twice

A Playwright script against `https://suite.127-0-0-1.sslip.io:8443`
(output as printed, times UTC):

```
00:48:23 setup: owner created, home shows 'Hello, Olive'
00:48:23 app announcements: HTTP 200, /m/announcements, h1 "Announcements"
00:48:24 app tasks: HTTP 200, /m/tasks, h1 "My tasks"
00:48:24 app docs: HTTP 200, /m/docs, h1 "Docs"
00:48:24 app customers: HTTP 200, /m/customers, h1 "Contacts"
00:48:25 app assistant: HTTP 200, /m/assistant, h1 "Assistant"      (shows "No AI provider is set up yet")
00:48:25 app chat: HTTP 200, /m/chat, h1 "Chat"
00:48:25 app funnel: HTTP 200, /m/funnel, h1 "Leads"
00:48:28 announcement posted: /m/announcements/40616244-…
00:48:29 task created in project Launch v011
00:48:30 doc page saved: /m/docs/p/466723c4-…
00:48:33 customer added: /m/customers/contacts/d8086a45-…
00:48:34 chat message sent in #general
00:48:34 form created; public page https://suite.127-0-0-1.sslip.io:8443/api/m/funnel/f/zfvxjrgm2qbb
00:48:35 public page signed out: HTTP 200 csp: default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:;
         base-uri 'none'; form-action 'self'; frame-ancestors *
00:48:35 submitted signed out: /api/m/funnel/f/zfvxjrgm2qbb/thanks
00:48:36 lead in What needs me, in Notifications and in the Leads list
00:48:39 first approve: 3 records written.
00:48:40 second approve: This was already approved earlier. 0 records written.
00:48:40 each imported post listed once
00:48:40 WALK PASSED
```

The bulk approval is a 3-row announcements CSV import, opened in two tabs and
approved in each. The database afterwards:

```
 owner | Olive Owner | owner-v011@example.test | $argon2id$v=19$m=19456,t=2,p=1
 Import 3 announcements | import | applied | total 3 | applied_count 3
 approval_items: positions 0, 1, 2 all applied, attempts = 1
 posts: Holiday hours v011 1, Parking v011 1, Stock count v011 1, Team lunch v011 1
 tasks 1 | doc_pages 1 | contacts 1 | chat_messages 1 | lead_forms 1 | leads 1
 notification: "New lead: Ana Reyes v011" — Web form “Website contact”. Your target is to contact them within 15 min.
 audit_log: approvals.proposed (3 × Post an announcement), approvals.approved, approvals.applied "3 written." (once)
```

### 8d. The day-to-day commands

```
$ business-suite status
business-suite-app-1      business-suite-app:0.1.1   Up About a minute (healthy)
business-suite-backup-1   business-suite-app:0.1.1   Up About a minute
business-suite-caddy-1    caddy:2-alpine             Up About a minute   0.0.0.0:80->80, 0.0.0.0:443->443 (tcp+udp)
business-suite-db-1       postgres:16-alpine         Up About a minute (healthy)
{"ok":true,"version":"0.1.1","database":"ok","migrations":11,"ms":10}
Last local backup: none yet

$ business-suite secret-key show
SUITE_SECRET_KEY (it locks the AI key, the email password and the push key stored in the database).
Write it down somewhere safe that is not this server. Restoring a backup on a new server needs it.
<a 44-character value, not copied here; its hash on the server matches SUITE_SECRET_KEY in .env>

$ business-suite backup
2026-10-08T00:49:21.817Z backup: 2026-10-08T00-49-21Z done in 0.3s: db 192797 bytes, files 109 bytes
backups/2026-10-08T00-49-21Z: db.dump 192797, files.tar.gz 109, manifest.json (version 0.1.1, both parts with sizes and SHA-256)
pg_restore --list db.dump: 66 TABLE DATA entries, among them users, approvals, announcements_posts,
  tasks_tasks, docs_pages, customers_contacts, chat_messages, funnel_forms, funnel_leads
rows of this walk inside db.dump (pg_restore -a -t <table>): funnel_leads 1, chat_messages 1, customers_contacts 1,
  docs_pages 1, tasks_tasks 1, announcements_posts 4
settings row 'backup': {"ok": true, "name": "2026-10-08T00-49-21Z", "bytes": 192906, "offsite": null}
```

### 8e. RAM (2 GB box, all seven apps)

`docker stats` inside the server:

| | app | PostgreSQL | Caddy | backup | total |
| --- | --- | --- | --- | --- | --- |
| Idle, just installed (00:48) | 59.9 MiB | 35.7 MiB | 13.1 MiB | 11.1 MiB | 120 MiB |
| During the browser walk (highest sample, 00:48:36) | 144.0 MiB | 71.4 MiB | 17.0 MiB | 11.1 MiB | 244 MiB |
| Idle after the walk (00:49) | 94.0 MiB | 52.2 MiB | 17.1 MiB | 11.7 MiB | 175 MiB |
| Highest sample during load (below) | 185.8 MiB | 79.0 MiB | 26.1 MiB | 11.7 MiB | 303 MiB |
| One minute after the load (00:52) | 99.7 MiB | 46.2 MiB | 18.1 MiB | 11.8 MiB | 176 MiB |

The load: 1,400 signed-in page loads over 14 pages of all seven apps (home,
Announcements, My tasks, Projects, Docs, Contacts, Deals, Assistant, Chat,
Leads, the funnel report, search, Approvals, Notifications), 20 at a time,
through Caddy: 87.9 s (15.9 pages/s), every one 200, p50 660 ms, p95 3,170 ms
(nested containers on a laptop's Docker VM). The app's highest sample was
188.6 MiB.

The build and swap: the box's cgroup (`memory.max` 2048 MiB, `memory.swap.max`
0, so no swap at all) reached `memory.peak` 2048 MiB during the image build,
with 1,078 `max` events (the kernel reclaiming page cache) and **0 OOM kills**;
after the install the box held 254 MiB of process memory and 1,581 MiB of page
cache. So the 2 GB build finished without swap here. `install.sh` did not add
its swap file because the container sees the VM's 3,917 MB (`free`), above its
3,800 MB threshold; on a real 2 GB server it adds 2 GB of swap before building,
which was not exercised.

### 8f. On the developer machine

`pnpm typecheck && pnpm lint` clean; `pnpm suite:check` 10 passed; `pnpm test`
19 files, 431 tests passed (against PostgreSQL 16, with the new
`tests/unit/deploy-env.test.ts`).

### Not run in this section

`business-suite update`, restore and reset-link on 0.1.1 (section 4 ran them on
0.1.0); invites and a second person; email over SMTP; the Leads email
sequence and unsubscribe (in `modules/funnel/EVIDENCE.md`, on the developer
machine); the brain; the swap file on a real 2 GB server. The `dist/` output
was deleted afterwards; nothing was published.

## Not run here (one-time checks on a real server)

- A real VPS with a public IP: Let's Encrypt via Caddy (here: Caddy's local CA).
- A real AI call (no DeepSeek key on this machine): Settings → AI → "Send a test message".
- Web Push to a real phone.
- A real SMTP provider and a real S3-compatible bucket for off-site backups.
- Ubuntu 26.04 and ARM servers.
- A real server with 2 GB of memory, where `install.sh` adds its swap file
  before the build (the test box shows the VM's memory, so it skipped it).
