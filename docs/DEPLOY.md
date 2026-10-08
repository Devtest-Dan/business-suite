# Deploying the suite

The suite runs on one Linux server that the owner rents and pays for. Four
containers do the work: the app, PostgreSQL 16, Caddy (HTTPS certificates,
renewed by itself) and the nightly backup. Which server to rent:
[HOSTING.md](HOSTING.md).

**Server:** Ubuntu 24.04 or 26.04, 2 vCPU, 4 GB memory, 40 GB disk. 2 GB
works for a handful of people (the installer adds swap to build).
**Network:** ports 80 and 443 open to the internet.
**Address:** your own domain (an `A` record pointing at the server), or none:
the installer falls back to `<server IP with dashes>.sslip.io`, which works at
once and can be swapped for your domain later.

## 1. The release

A release is three files on the suite's GitHub releases page
(https://github.com/Devtest-Dan/business-suite/releases):
`business-suite-<version>.tar.gz` (the suite), its SHA-256
(`business-suite-<version>.tar.gz.sha256`) and `cloud-init.yaml` with that
release's address and SHA-256 already filled in. The checksum is what proves
the server got the file you meant.

A developer who changed the suite for one business makes their own release
the same way. In `suite/`, bump `version` in `package.json`, commit, then:

```bash
SUITE_RELEASE_BASE=https://<where the files will be>/ pnpm release
```

It writes the three files into `dist/` from the last commit (the same commit
always gives the same `.tar.gz`). Without `SUITE_RELEASE_BASE`, the address in
`dist/cloud-init.yaml` is the GitHub release asset
`https://github.com/Devtest-Dan/business-suite/releases/download/v<version>/business-suite-<version>.tar.gz`.
Put the three files somewhere the server can download from over HTTPS.

**Publishing a release of the suite itself on GitHub.** The public repository
holds the suite folder only, with its own history (it was first exported
with fresh history, not the history of the repository the suite is developed
in). For each release, after `pnpm release`:

```bash
git clone https://github.com/Devtest-Dan/business-suite.git ../business-suite-public
git -C ../business-suite-public rm -rq --ignore-unmatch .
tar -xzf dist/business-suite-<version>.tar.gz -C ../business-suite-public --strip-components=1
git -C ../business-suite-public add -A
git -C ../business-suite-public commit -m "Business Suite <version>"
git -C ../business-suite-public tag v<version>
git -C ../business-suite-public push origin main v<version>
gh release create v<version> -R Devtest-Dan/business-suite --title "Business Suite <version>" --notes-file <notes>   dist/business-suite-<version>.tar.gz dist/business-suite-<version>.tar.gz.sha256 dist/cloud-init.yaml
```

Then download `cloud-init.yaml` from the new release and check that its
`SUITE_RELEASE_URL` opens and its SHA-256 matches the `.sha256` file.

## 2a. Install with a few clicks (cloud-init)

1. At the provider, create a server: Ubuntu 24.04, the size above, in the
   region nearest your team.
2. Find the box called **User data** (or "Cloud config", "Initialization
   script"; often under "Advanced").
3. Download `cloud-init.yaml` from the release you are installing (the
   release address and its SHA-256 are already filled in) and change
   `SUITE_SETUP_CODE` to a code only you know, at least 8 characters.
   Optionally fill in your domain, email and timezone. Paste the whole text
   into the box. (Left as the example or too short, the install makes a
   random code instead and prints it at the end of the install log.)
4. Create the server. It sets itself up in the background: about ten minutes
   on a 2 vCPU server, most of it building the app.
5. Open `https://<your domain>` (or `https://<IP-with-dashes>.sslip.io`). The
   first-run page asks for the setup code, then creates your owner account.

If the page does not answer after 15 minutes, read the log: connect with SSH
and run `sudo tail -50 /var/log/business-suite-install.log`.

## 2b. Install by hand (SSH)

```bash
curl -fLO https://github.com/Devtest-Dan/business-suite/releases/download/v0.1.1/business-suite-0.1.1.tar.gz
curl -fLO https://github.com/Devtest-Dan/business-suite/releases/download/v0.1.1/business-suite-0.1.1.tar.gz.sha256
sha256sum -c business-suite-0.1.1.tar.gz.sha256
tar -xzf business-suite-0.1.1.tar.gz
sudo bash business-suite-0.1.1/deploy/install.sh --domain suite.example.com --email you@example.com
```

Without `--domain` it asks, and Enter takes the sslip.io name. It prints the
address and the setup code at the end. Run it again any time (for example
with a new `--domain`): secrets and data are kept.

What `install.sh` does: installs Docker from Docker's own repository (or
Ubuntu's, if Docker has no packages for the release yet), adds 2 GB of swap on
servers under 4 GB, creates `/opt/business-suite`, generates the database
password and the encryption key into `/opt/business-suite/.env` (readable by
root only, never printed), writes the Caddyfile, opens ports 80/443 if `ufw` is
on, builds the app image, starts everything, waits for `/health`, and installs
the `business-suite` command.

## 3. First run

The setup page asks for the setup code, your business name and timezone, your
name, email and password, and (optionally) a DeepSeek API key. Then:

- **Settings → Email**: your SMTP details, so invites and password resets are
  emailed. Until then the suite shows links for you to copy and send.
- **People**: invite your team (admin, member or guest).
- **Settings → AI**: the provider. DeepSeek is the default
  (`https://api.deepseek.com/anthropic`, model `deepseek-flash`); "Send a test
  message" checks the key with one real call.
- **Account → Push notifications** on each phone (on iPhone: Share → Add to
  Home Screen first, then open the suite from the icon).

## Where things are

```
/opt/business-suite/
  .env               secrets and settings (root only)
  Caddyfile          the HTTPS site
  current ->         releases/<version>
  releases/<version> each installed release
  data/files/        uploaded files (unless you use S3 storage)
  backups/           nightly backups, 14 days
```

The database lives in the Docker volume `business-suite_pgdata`.

## Day to day: the `business-suite` command

```
sudo business-suite status            containers, /health, the last backup
sudo business-suite logs app          the app's log (also: db, caddy, backup)
sudo business-suite backup            a backup now
sudo business-suite backups           the list
sudo business-suite restore <name>    put one back (asks first)
sudo business-suite update <release>  move to a new release
sudo business-suite reset-link <email> a one-time password reset link (when nobody can sign in)
sudo business-suite restart
sudo business-suite brain on|off|status the optional business brain for the Assistant app
sudo business-suite compose <args>    any docker compose command, with the suite's files
sudo business-suite secret-key show   the encryption key, to write down off the server
```

### Reading the logs

`sudo business-suite logs app` shows the last 200 lines and follows new ones
(Ctrl+C stops). An error a person saw in the browser ("The server could not
finish this") is in there with its cause. Logs rotate at 10 MB × 3 files per
container.

## Backups

Every night at `BACKUP_HOUR` (03:00 by default, in the server's timezone) the
backup container writes `backups/<date>/` with `db.dump` (the whole database),
`files.tar.gz` (uploaded files) and `manifest.json` (sizes and SHA-256). It
keeps 14 days (`BACKUP_KEEP_DAYS`). Settings → Business shows the last backup
and says plainly when one failed.

**Off-site copy (strongly recommended):** a backup on the same server does not
survive losing the server. Create a bucket at any S3-compatible storage
(Backblaze B2, Cloudflare R2, Wasabi, Hetzner Object Storage, AWS S3, ...)
and a key that can write to it, then set in `/opt/business-suite/.env`:

```
BACKUP_S3_ENDPOINT=https://<the provider's S3 endpoint>
BACKUP_S3_REGION=<region, or auto>
BACKUP_S3_BUCKET=<bucket>
BACKUP_S3_PREFIX=business-suite
BACKUP_S3_ACCESS_KEY_ID=...
BACKUP_S3_SECRET_ACCESS_KEY=...
```

and run `sudo business-suite compose up -d backup`. Each backup is then also
copied to `<bucket>/<prefix>/<date>/`. Old off-site copies are not deleted by
the suite: set a lifecycle rule on the bucket (for example "delete after 30
days").

**Restore:** `sudo business-suite restore <name>` checks the checksums, stops
the app, replaces the whole database and the files, and starts again.
Everything written after that backup is lost. For an off-site copy, download
its folder into `/opt/business-suite/backups/` first. Try a restore once on a
spare server: a backup you have never restored is a hope, not a backup.

**Restoring on a new server needs the old encryption key.** The AI key, the
email (SMTP) password and the key for phone notifications are stored in the
database locked with `SUITE_SECRET_KEY` from `/opt/business-suite/.env`, and
that key is in no backup. Write it down when the suite is installed
(`sudo business-suite secret-key show`) and keep it off the server. On the new
server, after `install.sh` and before `business-suite restore`, put the old
value in `/opt/business-suite/.env` (`SUITE_SECRET_KEY=...`) and run
`sudo business-suite compose up -d app`. Without the old key the restore still
works, but enter the AI key again in Settings → AI and the SMTP password in
Settings → Email, and on each phone switch push notifications off and on again
in Account. The Assistant's link to the business brain is locked with the
same key, so keep the old key if you use the brain.

## Updates

```bash
sudo business-suite update https://<where-your-release-is>/business-suite-0.2.0.tar.gz
```

It checks the SHA-256 (from `--sha256` or the `.sha256` file next to the
release), takes a backup tagged `pre-update-0.2.0`, builds the new version
while the old one keeps running, switches over (the app applies the new
database migrations as it starts) and waits for `/health`. If the new version
does not come up healthy within three minutes, it puts the previous version
and the pre-update database back by itself, keeps the failed run's log in
`/opt/business-suite/update-0.2.0-failed.log`, and says so.

Ubuntu's own security updates: see [SECURITY.md](SECURITY.md).

## Files in S3 instead of on the disk

Set `FILES_S3_ENDPOINT`, `FILES_S3_REGION`, `FILES_S3_BUCKET`,
`FILES_S3_ACCESS_KEY_ID` and `FILES_S3_SECRET_ACCESS_KEY` in `.env` and run
`sudo business-suite compose up -d`. New uploads go to the bucket (under
`files/`); files uploaded before stay on the disk and keep working. The
nightly backup copies only the files on the disk, not the ones in the bucket:
turn on the bucket's versioning (and a lifecycle rule for old versions) so a
deleted or overwritten file can be got back.

## A local model (Ollama)

The suite can use a model running on the same server instead of a provider's
API, so no text leaves the server. A useful model needs much more memory than
the suite: plan on 8 GB or more and expect slower answers than DeepSeek.

```bash
sudo business-suite compose --profile local-ai up -d ollama
sudo business-suite compose exec ollama ollama pull llama3.1
```

Then in Settings → AI: provider "OpenAI-compatible API", address
`http://ollama:11434/v1`, model `llama3.1`, no key.

## Moving to your own domain later

Point the domain's `A` record at the server, wait until it resolves, then:

```bash
sudo bash /opt/business-suite/current/deploy/install.sh --domain suite.example.com --yes
```

Invite and reset links use the new address from then on.

## Health

`GET /health` answers `{"ok":true,"version":"…","database":"ok","migrations":N}`
(503 when the database is unreachable). Point an uptime monitor at
`https://<your domain>/health`.
