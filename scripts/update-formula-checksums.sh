#!/usr/bin/env bash
# update-formula-checksums.sh — Replace placeholder checksums in Formula/toolnet.rb
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
    echo "  WARNING: No checksum found for $artifact — skipping" >&2
    return
  fi
  # Replace the placeholder line for this platform
  local placeholder
  placeholder=$(echo "$artifact" | sed 's/toolnet-//; s/-//; s/\.tar\.gz//' | tr '[:lower:]' '[:upper:]' | sed 's/^/PLACEHOLDER_/' | sed 's/_X64$/_X64/' | sed 's/_ARM64$/_ARM64/')
  # Simpler: map artifact name → placeholder name
  case "$artifact" in
    *darwin-x64*)   placeholder="PLACEHOLDER_DARWIN_X64" ;;
    *darwin-arm64*) placeholder="PLACEHOLDER_DARWIN_ARM64" ;;
    *linux-x64*)    placeholder="PLACEHOLDER_LINUX_X64" ;;
    *linux-arm64*)  placeholder="PLACEHOLDER_LINUX_ARM64" ;;
    *) echo "  Unknown artifact: $artifact" >&2; return ;;
  esac
  sed -i "s|\"${placeholder}\"|\"${hash}\"|" "$FORMULA"
  echo "  $artifact → ${hash:0:16}…"
}

update_sha "toolnet-darwin-x64.tar.gz"
update_sha "toolnet-darwin-arm64.tar.gz"
update_sha "toolnet-linux-x64.tar.gz"
update_sha "toolnet-linux-arm64.tar.gz"

# Update version in formula
sed -i "s/version \".*\"/version \"${VERSION}\"/" "$FORMULA"

echo "Updated $FORMULA for v${VERSION}"
