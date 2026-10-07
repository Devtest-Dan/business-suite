#!/usr/bin/env bash
# Puts a backup back: the whole database and the uploaded files.
#
#   sudo business-suite restore                    lists the backups
#   sudo business-suite restore <name> [--yes]     restores /opt/business-suite/backups/<name>
#
# To restore an off-site copy, download its folder (db.dump, files.tar.gz,
# manifest.json) into /opt/business-suite/backups/ first.
# Everything written since that backup is lost: the suite is stopped for a
# minute and comes back exactly as it was when the backup was taken.

set -Eeuo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

NAME="${1:-}"
YES="${2:-}"
if [[ -z "$NAME" ]]; then
  echo "Backups on this server (newest last):"
  ls -1 "$SUITE_HOME/backups"
  echo
  echo "Restore one with: sudo business-suite restore <name>"
  exit 0
fi
DIR="$SUITE_HOME/backups/$(basename "$NAME")"
[[ -d "$DIR" ]] || die "there is no backup called $NAME in $SUITE_HOME/backups."

step "Checking $DIR"
verify_backup "$DIR"
note "checksums match"

if [[ "$YES" != "--yes" ]]; then
  read -r -p "    Replace ALL current data with this backup? Anything newer is lost. Type yes: " answer
  [[ "$answer" == "yes" ]] || die "nothing was changed."
fi

VERSION="$(get_env SUITE_VERSION)"
step "Stopping the app"
compose stop app backup

step "Restoring the database"
restore_database "$VERSION" "$DIR"
step "Restoring the files"
restore_files "$VERSION" "$DIR"

step "Starting"
compose up -d
wait_healthy 180 || die "the app did not come back healthy. See: business-suite logs app"
echo
echo "==> Restored $NAME."
