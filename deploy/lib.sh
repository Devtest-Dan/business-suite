#!/usr/bin/env bash
# Shared by update.sh and restore.sh. Not run on its own.

SUITE_HOME="${SUITE_HOME:-/opt/business-suite}"
ENV_FILE="$SUITE_HOME/.env"

step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf '\nStopped: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run it as root (sudo)."
[[ -f "$ENV_FILE" ]] || die "no $ENV_FILE: the suite is not installed here (run deploy/install.sh)."

get_env() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
set_env() {
  local key="$1" value="$2"
  if grep -q "^$key=" "$ENV_FILE"; then
    sed -i "s|^$key=.*|$key=${value//|/\\|}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

# compose [-v VERSION] args...: docker compose for the release folder of VERSION (default: the current one).
compose() {
  local version
  version="$(get_env SUITE_VERSION)"
  if [[ "${1:-}" == "-v" ]]; then version="$2"; shift 2; fi
  SUITE_VERSION="$version" docker compose --project-name business-suite --env-file "$ENV_FILE" -f "$SUITE_HOME/releases/$version/deploy/docker-compose.yml" "$@"
}

wait_healthy() {
  local seconds="${1:-180}" i
  for ((i = 0; i < seconds / 2; i++)); do
    if compose exec -T app wget -qO- http://127.0.0.1:3000/health 2>/dev/null | grep -q '"ok":true'; then return 0; fi
    sleep 2
  done
  return 1
}

# restore_database VERSION BACKUP_DIR: replaces the whole database with BACKUP_DIR/db.dump,
# using VERSION's image (its pg_restore). The app and backup containers must be stopped.
restore_database() {
  local version="$1" dir="$2" password
  password="$(get_env POSTGRES_PASSWORD)"
  compose -v "$version" up -d db >/dev/null
  for _ in $(seq 1 30); do compose -v "$version" exec -T db pg_isready -U suite -d suite >/dev/null 2>&1 && break; sleep 1; done
  docker run --rm --network business-suite_default -v "$dir:/restore:ro" -e PGPASSWORD="$password" "business-suite-app:$version" sh -c '
    set -e
    psql -h db -U suite -d postgres -v ON_ERROR_STOP=1 -q -c "drop database if exists suite with (force)" -c "create database suite"
    pg_restore -h db -U suite -d suite --no-owner --no-privileges --exit-on-error /restore/db.dump'
}

# restore_files VERSION BACKUP_DIR: replaces data/files with BACKUP_DIR/files.tar.gz.
restore_files() {
  local version="$1" dir="$2"
  docker run --rm --user 1000:1000 -v "$dir:/restore:ro" -v "$SUITE_HOME/data/files:/data/files" "business-suite-app:$version" sh -c '
    set -e
    find /data/files -mindepth 1 -delete
    tar -xzf /restore/files.tar.gz -C /data/files'
}

verify_backup() {
  local dir="$1"
  [[ -f "$dir/db.dump" && -f "$dir/files.tar.gz" && -f "$dir/manifest.json" ]] || die "$dir is not a complete backup (db.dump, files.tar.gz and manifest.json are needed)."
  local file expected
  for file in db.dump files.tar.gz; do
    expected="$(grep -A2 "\"$file\"" "$dir/manifest.json" | sed -n 's/.*"sha256": "\([0-9a-f]*\)".*/\1/p')"
    [[ -n "$expected" ]] || die "manifest.json in $dir has no checksum for $file."
    echo "$expected  $dir/$file" | sha256sum -c --quiet - || die "$dir/$file is damaged (checksum mismatch)."
  done
}
