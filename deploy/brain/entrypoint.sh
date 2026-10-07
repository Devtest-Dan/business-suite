#!/bin/sh
# Creates the brain on first start (PGLite, keyword-only), then serves it over
# HTTP: MCP at /mcp and the owner API at /admin. The suite reaches it on the
# compose network only; coding agents reach it through the suite's checked
# proxy (/api/m/assistant/mcp), never directly.
set -eu
: "${GBRAIN_ADMIN_BOOTSTRAP_TOKEN:?set BRAIN_ADMIN_TOKEN in the suite .env (docs/apps/assistant.md)}"
# GBrain refuses a public URL that is neither HTTPS nor loopback. Agents never use it:
# they reach the brain through the suite with a plain bearer token.
PUBLIC_URL="${BRAIN_PUBLIC_URL:-http://127.0.0.1:${BRAIN_PORT}}"
if [ ! -f "$GBRAIN_HOME/.gbrain/config.json" ]; then
  echo "brain: creating the brain in $GBRAIN_HOME (first start only; takes about a minute)"
  gbrain init --pglite --no-embedding --non-interactive --db-only --json
fi
exec gbrain serve --http --port "$BRAIN_PORT" --bind 0.0.0.0 --public-url "$PUBLIC_URL" --surface starter --suppress-bootstrap-token
