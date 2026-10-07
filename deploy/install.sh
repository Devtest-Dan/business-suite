#!/usr/bin/env bash
# Installs the business suite on a fresh Ubuntu 24.04 or 26.04 server.
#
#   sudo bash deploy/install.sh                       # asks for a domain (Enter = an sslip.io name)
#   sudo bash deploy/install.sh --domain suite.example.com --email you@example.com --yes
#
# Run it from an unpacked release (business-suite-<version>/), or pass
# --release <tarball path or https URL> [--sha256 <hash>]. cloud-init.yaml
# runs it for you when a server is created. Safe to run again: secrets and
# data are kept; the release and settings are refreshed.
#
# What it does: installs Docker, makes /opt/business-suite (secrets in .env,
# files, backups), writes the Caddyfile (automatic HTTPS), builds the app
# image, starts app + PostgreSQL 16 + Caddy + nightly backup, waits for
# /health, and prints the address and the setup code.

set -Eeuo pipefail

SUITE_HOME="${SUITE_HOME:-/opt/business-suite}"
DOMAIN="${SUITE_DOMAIN:-}"
ACME_EMAIL="${SUITE_ACME_EMAIL:-}"
SETUP_CODE="${SUITE_SETUP_CODE:-}"
PUBLIC_URL="${SUITE_PUBLIC_URL:-}"
RELEASE="${SUITE_RELEASE_URL:-}"
RELEASE_SHA256="${SUITE_RELEASE_SHA256:-}"
TIMEZONE="${SUITE_TZ:-}"
LOCAL_CERTS="${SUITE_LOCAL_CERTS:-0}"
ASSUME_YES=0
[[ -t 0 ]] || ASSUME_YES=1

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'
Options:
  --domain NAME        the address people will use (a DNS A record must point at this server)
  --email ADDRESS      for the HTTPS certificate (Let's Encrypt); optional
  --setup-code CODE    the code the first-run page asks for (default: a random one, printed at the end)
  --release FILE|URL   a business-suite-<version>.tar.gz to install instead of this folder
  --sha256 HASH        checks the release file before unpacking it
  --timezone ZONE      the server's timezone for the nightly backup (default: the server's own)
  --public-url URL     the full public address when it is not https://<domain> (tests behind a port map)
  --local-certs        Caddy's own certificate authority instead of Let's Encrypt (testing without a public IP)
  --yes                never ask; use defaults
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) ACME_EMAIL="${2:-}"; shift 2 ;;
    --setup-code) SETUP_CODE="${2:-}"; shift 2 ;;
    --release) RELEASE="${2:-}"; shift 2 ;;
    --sha256) RELEASE_SHA256="${2:-}"; shift 2 ;;
    --timezone) TIMEZONE="${2:-}"; shift 2 ;;
    --public-url) PUBLIC_URL="${2:-}"; shift 2 ;;
    --local-certs) LOCAL_CERTS=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf '\nInstall stopped: %s\n' "$*" >&2; exit 1; }
trap 'die "a command failed on line $LINENO. Fix the cause shown above and run the same command again (it is safe to repeat)."' ERR

[[ $EUID -eq 0 ]] || die "run it as root: sudo bash $0 $*"

step "Checking the server"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  note "${PRETTY_NAME:-unknown system}"
  if [[ "${ID:-}" != "ubuntu" ]]; then
    note "This script is made for Ubuntu 24.04 or 26.04. It may still work; continuing."
  fi
fi
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
CPUS=$(nproc)
note "${CPUS} CPU, ${MEM_MB} MB memory"
(( MEM_MB >= 1800 )) || die "the suite needs at least 2 GB of memory (4 GB recommended); this server has ${MEM_MB} MB."

# ── Packages and Docker ──────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
step "Base packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl openssl tar gzip >/dev/null

install_docker() {
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  local codename
  codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codename} stable" >/etc/apt/sources.list.d/docker.list
  if apt-get update -qq && apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null; then
    return 0
  fi
  note "Docker's own repository has no packages for this release yet; using Ubuntu's."
  rm -f /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker.io docker-compose-v2 docker-buildx >/dev/null
}

step "Docker"
if ! command -v docker >/dev/null 2>&1; then
  install_docker
fi
if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  systemctl enable --now docker >/dev/null 2>&1 || true
fi
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start it (systemctl start docker) and run this again."
docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is missing. Install docker-compose-plugin and run this again."
note "$(docker --version), $(docker compose version --short 2>/dev/null || echo compose)"

# Small servers need swap to build the app image.
if (( MEM_MB < 3800 )) && ! swapon --show | grep -q . ; then
  step "Swap (2 GB) for building on a small server"
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  if swapon /swapfile 2>/dev/null; then
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
    note "swap on"
  else
    note "swap could not be switched on here (containers cannot); continuing without it."
  fi
fi

# ── The release ──────────────────────────────────────────────────────────────
step "The release"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -n "$RELEASE" ]]; then
  WORK="$(mktemp -d)"
  if [[ "$RELEASE" =~ ^https?:// ]]; then
    note "downloading $RELEASE"
    curl -fsSL "$RELEASE" -o "$WORK/release.tar.gz"
  else
    cp "$RELEASE" "$WORK/release.tar.gz"
  fi
  if [[ -n "$RELEASE_SHA256" ]]; then
    echo "$RELEASE_SHA256  $WORK/release.tar.gz" | sha256sum -c --quiet - || die "the release file does not match its SHA-256. Download it again."
    note "SHA-256 checked"
  fi
  mkdir -p "$WORK/src"
  tar -xzf "$WORK/release.tar.gz" -C "$WORK/src" --strip-components=1
  SOURCE_DIR="$WORK/src"
fi
[[ -f "$SOURCE_DIR/package.json" && -f "$SOURCE_DIR/deploy/docker-compose.yml" ]] || die "no release found in $SOURCE_DIR. Run this from an unpacked business-suite-<version> folder or pass --release."
VERSION="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$SOURCE_DIR/package.json" | head -1)"
[[ -n "$VERSION" ]] || die "could not read the version from package.json."
note "version $VERSION"

mkdir -p "$SUITE_HOME/releases" "$SUITE_HOME/data/files" "$SUITE_HOME/backups"
RELEASE_DIR="$SUITE_HOME/releases/$VERSION"
if [[ "$(cd "$SOURCE_DIR" && pwd)" != "$RELEASE_DIR" ]]; then
  rm -rf "$RELEASE_DIR.new"
  cp -a "$SOURCE_DIR" "$RELEASE_DIR.new"
  rm -rf "$RELEASE_DIR"
  mv "$RELEASE_DIR.new" "$RELEASE_DIR"
fi
ln -sfn "$RELEASE_DIR" "$SUITE_HOME/current"
# The app and backup containers run as uid 1000 ("node").
chown -R 1000:1000 "$SUITE_HOME/data" "$SUITE_HOME/backups"

# ── Address ──────────────────────────────────────────────────────────────────
public_ip() {
  curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null ||
    curl -4 -fsS --max-time 5 https://ifconfig.me 2>/dev/null ||
    ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}'
}

ENV_FILE="$SUITE_HOME/.env"
get_env() { [[ -f "$ENV_FILE" ]] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 || true; }
set_env() {
  local key="$1" value="$2"
  touch "$ENV_FILE"
  if grep -q "^$key=" "$ENV_FILE"; then
    sed -i "s|^$key=.*|$key=${value//|/\\|}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

step "Address"
[[ -n "$DOMAIN" ]] || DOMAIN="$(get_env SUITE_DOMAIN)"
if [[ -z "$DOMAIN" ]]; then
  IP="$(public_ip || true)"
  FALLBACK=""
  [[ -n "$IP" ]] && FALLBACK="${IP//./-}.sslip.io"
  if (( ASSUME_YES == 0 )); then
    read -r -p "    Domain for the suite (its DNS must point at ${IP:-this server}); Enter for ${FALLBACK:-none}: " DOMAIN
  fi
  DOMAIN="${DOMAIN:-$FALLBACK}"
fi
[[ -n "$DOMAIN" ]] || die "no domain, and this server's public IP address could not be found. Pass --domain."
DOMAIN="${DOMAIN,,}"
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || die "\"$DOMAIN\" is not a valid domain name."
note "https://$DOMAIN"
[[ "$DOMAIN" == *.sslip.io ]] && note "(an sslip.io name works at once; use your own domain later by running this again with --domain)"
[[ -n "$PUBLIC_URL" ]] || PUBLIC_URL="$(get_env SUITE_URL)"
if [[ -z "$PUBLIC_URL" || "$PUBLIC_URL" != *"$DOMAIN"* ]]; then PUBLIC_URL="https://$DOMAIN"; fi

# ── Secrets and settings (.env, kept on re-runs) ─────────────────────────────
step "Secrets and settings ($ENV_FILE)"
umask 077
[[ -n "$(get_env POSTGRES_PASSWORD)" ]] || set_env POSTGRES_PASSWORD "$(openssl rand -hex 24)"
[[ -n "$(get_env SUITE_SECRET_KEY)" ]] || set_env SUITE_SECRET_KEY "$(openssl rand -base64 32)"
# The optional business brain's owner token (used only if the owner runs `business-suite brain on`).
[[ -n "$(get_env BRAIN_ADMIN_TOKEN)" ]] || set_env BRAIN_ADMIN_TOKEN "$(openssl rand -hex 32)"
if [[ -z "$SETUP_CODE" ]]; then SETUP_CODE="$(get_env SUITE_SETUP_CODE)"; fi
if [[ -z "$SETUP_CODE" ]]; then SETUP_CODE="$(openssl rand -hex 3)-$(openssl rand -hex 3)"; fi
if [[ -z "$TIMEZONE" ]]; then TIMEZONE="$(get_env SUITE_TZ)"; fi
if [[ -z "$TIMEZONE" ]]; then TIMEZONE="$(cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || echo UTC)"; fi
set_env SUITE_HOME "$SUITE_HOME"
set_env SUITE_VERSION "$VERSION"
set_env SUITE_DOMAIN "$DOMAIN"
set_env SUITE_URL "$PUBLIC_URL"
set_env SUITE_SETUP_CODE "$SETUP_CODE"
set_env SUITE_TZ "${TIMEZONE:-UTC}"
[[ -n "$(get_env BACKUP_HOUR)" ]] || set_env BACKUP_HOUR 3
[[ -n "$(get_env BACKUP_KEEP_DAYS)" ]] || set_env BACKUP_KEEP_DAYS 14
for key in BACKUP_S3_ENDPOINT BACKUP_S3_REGION BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY FILES_S3_ENDPOINT FILES_S3_REGION FILES_S3_BUCKET FILES_S3_ACCESS_KEY_ID FILES_S3_SECRET_ACCESS_KEY; do
  grep -q "^$key=" "$ENV_FILE" || set_env "$key" ""
done
[[ -n "$ACME_EMAIL" ]] && set_env ACME_EMAIL "$ACME_EMAIL"
ACME_EMAIL="$(get_env ACME_EMAIL)"
chmod 600 "$ENV_FILE"
umask 022
note "kept: database password and encryption key (made once, never printed)"

step "HTTPS (Caddyfile)"
{
  echo "# Written by deploy/install.sh. Run install.sh again to change the domain."
  echo "{"
  [[ -n "$ACME_EMAIL" ]] && echo "	email $ACME_EMAIL"
  (( LOCAL_CERTS == 1 )) && echo "	local_certs"
  echo "}"
  echo
  echo "$DOMAIN {"
  echo "	encode zstd gzip"
  echo "	header {"
  echo "		Strict-Transport-Security \"max-age=31536000\""
  echo "		-Server"
  echo "	}"
  echo "	reverse_proxy app:3000"
  echo "}"
} >"$SUITE_HOME/Caddyfile"
(( LOCAL_CERTS == 1 )) && note "local certificates (browsers will warn): for testing only"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw allow 443/udp >/dev/null
  note "firewall: opened 80 and 443"
fi

# ── The helper command ───────────────────────────────────────────────────────
install -m 0755 "$RELEASE_DIR/deploy/suite.sh" /usr/local/bin/business-suite

# ── Build and start ──────────────────────────────────────────────────────────
compose() { docker compose --project-name business-suite --env-file "$ENV_FILE" -f "$SUITE_HOME/current/deploy/docker-compose.yml" "$@"; }

step "Building the app image (a few minutes the first time)"
compose build --pull app

step "Starting"
compose up -d --remove-orphans

step "Waiting for the app to answer /health"
healthy=0
for _ in $(seq 1 90); do
  if compose exec -T app wget -qO- http://127.0.0.1:3000/health 2>/dev/null | grep -q '"ok":true'; then healthy=1; break; fi
  sleep 2
done
(( healthy == 1 )) || { compose logs --tail 60 app >&2 || true; die "the app did not become healthy. The log is above; 'business-suite logs app' shows more."; }
compose exec -T app wget -qO- http://127.0.0.1:3000/health
echo

trap - ERR
cat <<EOF

==> Done. The business suite $VERSION is running.

    Open:        $PUBLIC_URL
    Setup code:  $SETUP_CODE   (the first-run page asks for it)

    The HTTPS certificate is requested on the first visit; if the page does not
    load yet, check that $DOMAIN points at this server and ports 80 and 443 are open.

    Everything lives in $SUITE_HOME (secrets: .env, files: data/files,
    backups: backups/, every night at $(get_env BACKUP_HOUR):00).
    Day to day:  business-suite status | logs app | backup | update <release>
EOF
