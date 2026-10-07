#!/usr/bin/env bash
# Builds the release files from the last commit:
#   dist/business-suite-<version>.tar.gz          the suite's source, with deploy/ and docs/
#   dist/business-suite-<version>.tar.gz.sha256   its checksum (cloud-init and update.sh check it)
#
#   pnpm release            (or: bash scripts/release.sh)
#
# Only committed files go in (git archive), so a release is always reproducible
# from its commit. Bump "version" in package.json and commit before releasing.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

VERSION="$(node -p "require('./package.json').version")"
NAME="business-suite-$VERSION"
mkdir -p dist
OUT="dist/$NAME.tar.gz"

if [[ -n "$(git status --porcelain -- .)" ]]; then
  echo "Note: there are uncommitted changes in the suite; they are NOT in the release (it is built from HEAD)." >&2
fi

# The suite folder of HEAD, under a top folder named after the release.
PREFIX="$(git rev-parse --show-prefix)"
git -C "$(git rev-parse --show-toplevel)" archive --format=tar --prefix="$NAME/" "HEAD:${PREFIX%/}" | gzip -n -9 >"$OUT"

if command -v sha256sum >/dev/null 2>&1; then
  (cd dist && sha256sum "$NAME.tar.gz" >"$NAME.tar.gz.sha256")
else
  (cd dist && shasum -a 256 "$NAME.tar.gz" >"$NAME.tar.gz.sha256")
fi

echo "Release $VERSION from commit $(git rev-parse --short HEAD):"
echo "  $(pwd)/$OUT ($(wc -c <"$OUT" | tr -d ' ') bytes)"
echo "  sha256 $(cut -d' ' -f1 "dist/$NAME.tar.gz.sha256")"
