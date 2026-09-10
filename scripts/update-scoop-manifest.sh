#!/usr/bin/env bash
# update-scoop-manifest.sh — Update bucket/toolnet.json with real checksums.
#
# Usage:
#   ./scripts/update-scoop-manifest.sh v1.0.5

set -euo pipefail

REPO="LBT-AI/Toolnet-CLI"
VERSION="${1:-${TOOLNET_VERSION:-}}"

if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version>  (e.g. $0 v1.0.5)" >&2
  exit 1
fi

VERSION="${VERSION#v}"
MANIFEST="bucket/toolnet.json"

if [ ! -f "$MANIFEST" ]; then
  echo "Manifest not found: $MANIFEST" >&2
  exit 1
fi

echo "Downloading checksums from v${VERSION} release..."
CHECKSUMS=$(curl -fsSL "https://github.com/${REPO}/releases/download/v${VERSION}/checksums.txt")

HASH=$(echo "$CHECKSUMS" | grep "toolnet-windows-x64.zip" | head -1 | awk '{print $1}')
if [ -z "$HASH" ]; then
  echo "ERROR: No checksum for toolnet-windows-x64.zip" >&2
  exit 1
fi

# Update version
sed -i "s/\"version\": \".*\"/\"version\": \"${VERSION}\"/" "$MANIFEST"
# Update URL
sed -i "s|/v[0-9][0-9.]*/toolnet-windows|/v${VERSION}/toolnet-windows|" "$MANIFEST"
# Update hash (replace whatever hash is currently set)
sed -i "s|\"hash\": \"[a-fA-F0-9]*\"|\"hash\": \"${HASH}\"|" "$MANIFEST"

# Verify the manifest now points at this release with the right hash
if ! grep -q "/v${VERSION}/toolnet-windows-x64.zip" "$MANIFEST"; then
  echo "ERROR: URL for v${VERSION} was not applied to $MANIFEST" >&2
  exit 1
fi
if ! grep -q "$HASH" "$MANIFEST"; then
  echo "ERROR: hash was not applied to $MANIFEST" >&2
  exit 1
fi

echo "Updated $MANIFEST for v${VERSION} (hash: ${HASH:0:16}…, verified)"
