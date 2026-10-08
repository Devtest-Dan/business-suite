#!/usr/bin/env bash
# Builds the release files from the last commit:
#   dist/business-suite-<version>.tar.gz          the suite's source, with deploy/ and docs/
#   dist/business-suite-<version>.tar.gz.sha256   its checksum (cloud-init and update.sh check it)
#   dist/cloud-init.yaml                          deploy/cloud-init.yaml with the release
#                                                 address and SHA-256 filled in
#
#   pnpm release            (or: bash scripts/release.sh)
#
# Only committed files go in (git archive), so a release is always reproducible
# from its commit. Bump "version" in package.json and commit before releasing.
# The address in cloud-init.yaml is the GitHub release asset for this version;
# set SUITE_RELEASE_BASE (the folder the three files will be downloaded from)
# to publish them somewhere else.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

VERSION="$(node -p "require('./package.json').version")"
NAME="business-suite-$VERSION"
BASE="${SUITE_RELEASE_BASE:-https://github.com/Devtest-Dan/business-suite/releases/download/v$VERSION}"
mkdir -p dist
OUT="dist/$NAME.tar.gz"

if [[ -n "$(git status --porcelain -- .)" ]]; then
  echo "Note: there are uncommitted changes in the suite; they are NOT in the release (it is built from HEAD)." >&2
fi

# The suite folder of HEAD, under a top folder named after the release.
PREFIX="$(git rev-parse --show-prefix)"
# Archiving a folder (a tree, not a commit) stamps every file with the current
# time, so the same commit would give a different file each run. Stamp them with
# the commit's time instead (git 2.44 or later has --mtime).
MTIME=()
if [[ "$(git archive -h 2>&1 || true)" == *--mtime* ]]; then
  MTIME=(--mtime="$(git log -1 --format=%cI HEAD)")
else
  echo "Note: this git has no 'archive --mtime' (git 2.44+), so this .tar.gz differs from another build of the same commit." >&2
fi
git -C "$(git rev-parse --show-toplevel)" archive --format=tar "${MTIME[@]}" --prefix="$NAME/" "HEAD:${PREFIX%/}" | gzip -n -9 >"$OUT"

if command -v sha256sum >/dev/null 2>&1; then
  (cd dist && sha256sum "$NAME.tar.gz" >"$NAME.tar.gz.sha256")
else
  (cd dist && shasum -a 256 "$NAME.tar.gz" >"$NAME.tar.gz.sha256")
fi
SHA="$(cut -d' ' -f1 "dist/$NAME.tar.gz.sha256")"

# cloud-init.yaml from the same commit, with this release's address and checksum.
URL="${BASE%/}/$NAME.tar.gz"
git -C "$(git rev-parse --show-toplevel)" show "HEAD:${PREFIX}deploy/cloud-init.yaml" |
  sed -e "s|^\(      SUITE_RELEASE_URL=\).*|\1$URL|" -e "s|^\(      SUITE_RELEASE_SHA256=\).*|\1$SHA|" >dist/cloud-init.yaml
grep -q "^      SUITE_RELEASE_URL=$URL\$" dist/cloud-init.yaml && grep -q "^      SUITE_RELEASE_SHA256=$SHA\$" dist/cloud-init.yaml ||
  { echo "Could not fill in the release address and SHA-256 in dist/cloud-init.yaml (deploy/cloud-init.yaml changed shape?)." >&2; exit 1; }

echo "Release $VERSION from commit $(git rev-parse --short HEAD):"
echo "  $(pwd)/$OUT ($(wc -c <"$OUT" | tr -d ' ') bytes)"
echo "  sha256 $SHA"
echo "  $(pwd)/dist/cloud-init.yaml (downloads $URL)"
