#!/usr/bin/env bash
# update-formula-checksums.sh — Replace checksums in Formula/toolnet.rb
# with real SHA256 values downloaded from a GitHub release.
#
# Usage:
#   ./scripts/update-formula-checksums.sh v1.0.5
#   TOOLNET_VERSION=1.0.5 ./scripts/update-formula-checksums.sh
#
# Requires: curl, sed

set -euo pipefail

REPO="LBT-AI/Toolnet-CLI"
VERSION="${1:-${TOOLNET_VERSION:-}}"

if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version>  (e.g. $0 v1.0.5)" >&2
  exit 1
fi

VERSION="${VERSION#v}"  # strip leading 'v' if present
FORMULA="Formula/toolnet.rb"

if [ ! -f "$FORMULA" ]; then
  echo "Formula file not found: $FORMULA" >&2
  exit 1
fi

echo "Downloading checksums from v${VERSION} release..."
CHECKSUMS=$(curl -fsSL "https://github.com/${REPO}/releases/download/v${VERSION}/checksums.txt")

update_sha() {
  local artifact="$1"
  local hash
  hash=$(echo "$CHECKSUMS" | grep "$artifact" | head -1 | awk '{print $1}')
  if [ -z "$hash" ]; then
    echo "  ERROR: No checksum found for $artifact" >&2
    exit 1
  fi
  # The formula lists each artifact URL followed immediately by its sha256 line.
  # Replace the sha256 on the line after the matching URL.
  sed -i "/${artifact}/{n; s|sha256 \".*\"|sha256 \"${hash}\"|;}" "$FORMULA"
  echo "  $artifact → ${hash:0:16}…"
}

update_sha "toolnet-darwin-x64.tar.gz"
update_sha "toolnet-darwin-arm64.tar.gz"
update_sha "toolnet-linux-x64.tar.gz"
update_sha "toolnet-linux-arm64.tar.gz"

# Update version in formula
sed -i "s/version \".*\"/version \"${VERSION}\"/" "$FORMULA"

# Verify every expected hash is present in the formula
MISSING=0
for artifact in toolnet-darwin-x64.tar.gz toolnet-darwin-arm64.tar.gz toolnet-linux-x64.tar.gz toolnet-linux-arm64.tar.gz; do
  expected=$(echo "$CHECKSUMS" | grep "$artifact" | head -1 | awk '{print $1}')
  if ! grep -q "$expected" "$FORMULA"; then
    echo "  ERROR: hash for $artifact was not applied to $FORMULA" >&2
    MISSING=1
  fi
done
if [ "$MISSING" -ne 0 ]; then
  exit 1
fi

echo "Updated $FORMULA for v${VERSION} (verified)"
