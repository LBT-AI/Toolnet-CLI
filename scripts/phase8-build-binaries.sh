#!/usr/bin/env bash
# Phase 8 — standalone binary build + checksums.
#
# Produces the release artifact set for all five targets:
#   linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64
# plus checksums.txt, and verifies every archive against its checksum.
#
# The Windows archive intentionally contains `toolnet.exe` (what install.ps1
# and the Scoop manifest expect).
#
# Run: bash scripts/phase8-build-binaries.sh   (exit 0 = built + verified)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist-bin"

command -v zip >/dev/null 2>&1 || { echo "ERROR: 'zip' is required"; exit 1; }

cd "$ROOT"
rm -rf "$OUT"
mkdir -p "$OUT"

echo "== compiling targets =="
bun run build:bin:linux-x64
bun run build:bin:linux-arm64
bun run build:bin:darwin-x64
bun run build:bin:darwin-arm64
bun run build:bin:win-x64

echo "== archiving =="
cd "$OUT"
tar -czf toolnet-linux-x64.tar.gz toolnet-linux-x64
tar -czf toolnet-linux-arm64.tar.gz toolnet-linux-arm64
tar -czf toolnet-darwin-x64.tar.gz toolnet-darwin-x64
tar -czf toolnet-darwin-arm64.tar.gz toolnet-darwin-arm64
cp toolnet-windows-x64.exe toolnet.exe
zip -q toolnet-windows-x64.zip toolnet.exe
rm -f toolnet.exe

echo "== checksums =="
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum toolnet-*.tar.gz toolnet-windows-x64.zip > checksums.txt
else
  shasum -a 256 toolnet-*.tar.gz toolnet-windows-x64.zip > checksums.txt
fi

echo "== verify =="
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c checksums.txt
else
  shasum -a 256 -c checksums.txt
fi

echo
echo "artifacts:"
ls -la toolnet-* checksums.txt
