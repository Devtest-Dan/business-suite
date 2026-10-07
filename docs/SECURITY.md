# Security: what the owner must do

The suite is built to be safe by default, but it runs on a server that the
owner controls, so some jobs are the owner's. None takes long. Do them.

## Once, at the start

1. **Use a setup code.** `install.sh` makes one and cloud-init asks you for
   one. Without it, whoever opens the new server's address first could create
   the owner account.
2. **Give the owner account a long password** (a few words in a row is good)
   and never share it. Everyone gets their own account through People →
   Invite; switch people off there when they leave (that signs them out
   everywhere at once).
3. **Turn on the off-site backup copy** ([DEPLOY.md](DEPLOY.md), "Backups").
   Backups on the same server do not survive losing the server.
4. **Turn on your provider's snapshots or backups** if it offers them, as a
   second safety net.
5. **Protect the server login.** Use an SSH key, not a password, for `root`
   (most providers let you add the key when creating the server). Keep the
   key on your own computer only.
6. **Write down where things are**: the provider account, the domain's DNS
   account, the S3 bucket and its key, and the setup code. Keep that note
   somewhere safe that is not the server.

## Every month (about 10 minutes)

1. **Operating system updates.** Connect with SSH and run:
   ```bash
   sudo apt update && sudo apt upgrade -y
   sudo reboot            # when the upgrade says a restart is required
   ```
   The suite starts again by itself after a reboot. Ubuntu also installs
   security fixes automatically every day (unattended-upgrades is on by
   default on Ubuntu servers); check with `systemctl status unattended-upgrades`.
2. **Suite updates.** When your developer publishes a release:
   `sudo business-suite update <release address>`. It backs up first and
   rolls itself back if the new version fails.
3. **Check the backups.** Settings → Business shows the last backup; it must
   be from last night. Once a quarter, restore one on a spare server.
4. **Check who has access.** People: switch off anyone who has left, and
   check who is an admin. Settings → Permissions: check what members and
   guests can do.
5. **Read the activity log** (Activity) for anything you do not recognise.

## How the suite protects you

- **Passwords** are stored as Argon2id hashes, never in readable form.
  Sign-in stops for 15 minutes after five wrong passwords for one email (or
  thirty from one network address).
- **Sessions** live in the database behind an httpOnly cookie; switching a
  person off or resetting their password ends their sessions.
- **Invite and reset links** work once and expire (7 days and 24 hours).
- **Every page and action checks permissions on the server**; hiding a button
  is never the only check.
- **Secrets** (AI API keys, the SMTP password, the push key) are encrypted in
  the database with the server's key in `/opt/business-suite/.env`. Anyone
  with root on the server can read that file: protect the server login.
- **The activity log cannot be changed**: the database refuses any edit or
  deletion of its entries, for everyone.
- **AI never writes on its own.** Every change it proposes waits in
  Approvals, and each record is written at most once. With "Redact personal
  details" on (the default), names, emails, phone numbers, card and id
  numbers, street addresses and key-like strings are replaced with
  placeholders before anything is sent to the AI provider.
- **HTTPS** everywhere through Caddy, with certificates renewed by itself.

## What the suite is not for

Do not keep regulated records in it (patient health records, card numbers,
government ids, payroll). Keep those in the systems built and certified for
them, and connect to them instead.

## If something goes wrong

- **A lost or stolen phone or laptop:** People → switch the person off (ends
  every session), then switch them back on and make a reset link.
- **The owner password is lost:** with SSH access, run
  `sudo business-suite reset-link <owner email>` on the server: it prints a
  one-time reset link. Without SSH access, the provider's rescue
  console is the way in. Keep the setup note from step 6 above.
- **You think the server was broken into:** take it offline at the provider,
  then restore the last good backup onto a new server and change every
  password and key (AI key, SMTP password, S3 keys).
