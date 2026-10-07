#!/usr/bin/env bash
# The day-to-day command, installed as /usr/local/bin/business-suite.
#
#   business-suite status              containers, health and the last backup
#   business-suite logs [service]      follow the logs (app, db, caddy, backup)
#   business-suite restart             restart everything
#   business-suite backup              take a backup now
#   business-suite backups             list the backups on this server
#   business-suite restore <name>      put a backup back (asks first)
#   business-suite update <release>    move to a new release (file or URL), with automatic rollback
#   business-suite reset-link <email>  a one-time password reset link (when nobody can sign in)
#   business-suite brain on|off|status the optional business brain (GBrain) for the Assistant app
#   business-suite compose <args>      any docker compose command, with the right files

set -Eeuo pipefail
SUITE_HOME="${SUITE_HOME:-/opt/business-suite}"
ENV_FILE="$SUITE_HOME/.env"
[[ -f "$ENV_FILE" ]] || { echo "No $ENV_FILE: the suite is not installed here (run deploy/install.sh)." >&2; exit 1; }
compose() { docker compose --project-name business-suite --env-file "$ENV_FILE" -f "$SUITE_HOME/current/deploy/docker-compose.yml" "$@"; }
get_env() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
set_env() {
  if grep -q "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"; fi
}

# The brain: on adds the "brain" compose profile and BRAIN_URL, starts it and
# restarts the app; off stops it and clears BRAIN_URL (its data volume is kept).
brain() {
  local profiles
  profiles="$(get_env COMPOSE_PROFILES | tr ',' '\n' | grep -v '^brain$' | grep -v '^$' | paste -sd, - || true)"
  case "${1:-status}" in
    on)
      [[ -n "$(get_env BRAIN_ADMIN_TOKEN)" ]] || set_env BRAIN_ADMIN_TOKEN "$(openssl rand -hex 32)"
      set_env COMPOSE_PROFILES "${profiles:+$profiles,}brain"
      set_env BRAIN_URL "http://brain:7410"
      echo "Starting the brain (the first start builds it and creates its storage: a few minutes)..."
      compose up -d --build brain
      for _ in $(seq 1 90); do compose exec -T brain curl -fsS http://127.0.0.1:7410/health >/dev/null 2>&1 && break; sleep 2; done
      compose up -d app
      echo "The brain is on. Open the Assistant app → What it knows."
      ;;
    off)
      set_env COMPOSE_PROFILES "$profiles"
      set_env BRAIN_URL ""
      compose --profile brain stop brain || true
      compose up -d app
      echo "The brain is off. Its data is kept (volume business-suite_brain_data); 'brain on' starts it again."
      ;;
    status)
      if [[ -n "$(get_env BRAIN_URL)" ]]; then
        compose --profile brain exec -T brain curl -fsS http://127.0.0.1:7410/health && echo || echo "The brain is switched on but not answering: business-suite logs brain"
      else
        echo "The brain is off. 'business-suite brain on' switches it on (about 400 MB of memory while running)."
      fi
      ;;
    *) echo "Use: business-suite brain on|off|status" >&2; exit 2 ;;
  esac
}

cmd="${1:-status}"
shift || true
case "$cmd" in
  status)
    compose ps
    echo
    compose exec -T app wget -qO- http://127.0.0.1:3000/health && echo || echo "The app is not answering /health."
    last="$(ls -1 "$SUITE_HOME/backups" 2>/dev/null | tail -1)"
    echo "Last local backup: ${last:-none yet}"
    ;;
  logs) compose logs --tail 200 -f "$@" ;;
  restart) compose restart ;;
  backup) compose exec -T backup node scripts/backup.mjs --once "$@" ;;
  backups) ls -1 "$SUITE_HOME/backups" ;;
  restore) exec bash "$SUITE_HOME/current/deploy/restore.sh" "$@" ;;
  update) exec bash "$SUITE_HOME/current/deploy/update.sh" "$@" ;;
  reset-link) compose exec -T app node scripts/reset-link.mjs "$@" ;;
  brain) brain "$@" ;;
  compose) compose "$@" ;;
  *) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
