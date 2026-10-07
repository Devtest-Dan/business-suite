#!/usr/bin/env bash
# Moves the suite to a new release, and rolls back by itself if it fails.
#
#   sudo business-suite update <business-suite-X.Y.Z.tar.gz | https URL> [--sha256 HASH] [--yes]
#
# 1. checks the release (SHA-256, from --sha256 or a .sha256 file next to it)
# 2. takes a backup tagged pre-update-X.Y.Z
# 3. builds the new image while the old version keeps running
# 4. switches over; the app runs the new migrations as it starts
# 5. waits for /health; if it does not come, puts the previous version AND the
#    pre-update database back, and says so. The failed run's log is kept.

set -Eeuo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SOURCE="${1:-}"
shift || true
SHA=""
YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha256) SHA="${2:-}"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    *) die "unknown option $1" ;;
  esac
done
[[ -n "$SOURCE" ]] || die "say which release: business-suite update business-suite-X.Y.Z.tar.gz (or its https address)."

OLD="$(get_env SUITE_VERSION)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

step "Getting the release"
if [[ "$SOURCE" =~ ^https?:// ]]; then
  curl -fsSL "$SOURCE" -o "$WORK/release.tar.gz"
  [[ -n "$SHA" ]] || SHA="$(curl -fsSL "$SOURCE.sha256" 2>/dev/null | awk '{print $1}' || true)"
else
  [[ -f "$SOURCE" ]] || die "no file $SOURCE."
  cp "$SOURCE" "$WORK/release.tar.gz"
  [[ -n "$SHA" || ! -f "$SOURCE.sha256" ]] || SHA="$(awk '{print $1}' "$SOURCE.sha256")"
fi
if [[ -n "$SHA" ]]; then
  echo "$SHA  $WORK/release.tar.gz" | sha256sum -c --quiet - || die "the release does not match its SHA-256. Download it again."
  note "SHA-256 checked"
else
  note "no SHA-256 given: the file was not checked (pass --sha256 to check it)"
fi
mkdir -p "$WORK/src"
tar -xzf "$WORK/release.tar.gz" -C "$WORK/src" --strip-components=1
NEW="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$WORK/src/package.json" | head -1)"
[[ -n "$NEW" ]] || die "the release has no version in package.json."
note "from $OLD to $NEW"
[[ "$NEW" != "$OLD" ]] || die "this server already runs $NEW."
if (( YES == 0 )) && [[ -t 0 ]]; then
  read -r -p "    Update now? The suite is unavailable for about a minute. [y/N] " answer
  [[ "$answer" =~ ^[Yy] ]] || die "nothing was changed."
fi

step "Backup before the update"
BACKUP_LINE="$(compose exec -T backup node scripts/backup.mjs --once --tag "pre-update-$NEW" | tail -1)"
BACKUP_DIR="$SUITE_HOME/backups/$(basename "$BACKUP_LINE")"
[[ -f "$BACKUP_DIR/db.dump" ]] || die "the backup did not finish, so the update did not start. Nothing was changed."
note "$BACKUP_DIR"

step "Building $NEW (the current version keeps running)"
rm -rf "$SUITE_HOME/releases/$NEW"
cp -a "$WORK/src" "$SUITE_HOME/releases/$NEW"
compose -v "$NEW" build --pull app

rollback() {
  step "Rolling back to $OLD"
  compose -v "$NEW" logs --no-color --tail 300 app >"$SUITE_HOME/update-$NEW-failed.log" 2>&1 || true
  note "the failed run's log: $SUITE_HOME/update-$NEW-failed.log"
  set_env SUITE_VERSION "$OLD"
  ln -sfn "$SUITE_HOME/releases/$OLD" "$SUITE_HOME/current"
  compose -v "$NEW" stop app backup || true
  restore_database "$OLD" "$BACKUP_DIR"
  compose -v "$OLD" up -d --remove-orphans
  if wait_healthy 180; then
    die "the update to $NEW failed and was rolled back: $OLD is running again with the data from just before the update."
  fi
  die "the update to $NEW failed AND $OLD did not come back by itself. Restore by hand: business-suite restore $(basename "$BACKUP_DIR")"
}

step "Switching to $NEW"
set_env SUITE_VERSION "$NEW"
ln -sfn "$SUITE_HOME/releases/$NEW" "$SUITE_HOME/current"
install -m 0755 "$SUITE_HOME/releases/$NEW/deploy/suite.sh" /usr/local/bin/business-suite
if ! compose -v "$NEW" up -d --remove-orphans; then rollback; fi

step "Waiting for /health"
if ! wait_healthy 180; then rollback; fi
compose exec -T app wget -qO- http://127.0.0.1:3000/health
echo
echo
echo "==> Updated to $NEW. The previous release stays in $SUITE_HOME/releases/$OLD; the pre-update backup in $BACKUP_DIR."
