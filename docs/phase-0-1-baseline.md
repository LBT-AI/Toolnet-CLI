# Phase 0.1 Baseline

HEAD: 825cee8
Branch: main
Origin: https://github.com/LBT-AI/Toolnet-CLI.git
Working tree: clean

Environment:
- OS: Debian GNU/Linux 13 (trixie)
- Arch: x86_64
- Node: v22.23.3
- Bun: 1.4.0
- npm: 10.9.9

Validation:
- Typecheck: PASS
- Tests: 3198 passed / 0 failed / 20 skipped
- Build: PASS
- npm pack: PASS

Package:
- Name: toolnetcli
- Version: 1.3.0
- Bin: {"toolnet":"bin/toolnet.js"}

CI:
- Summary: `ci.yml` runs typecheck, test, and build on Ubuntu for main branch and PRs. `release.yml` triggers on `v*` tags, building standalone binaries (linux/darwin/win x64/arm64) using Bun latest.

Tracked generated/suspicious files:
- .wrangler/state/v3/cache/miniflare-CacheObject/metadata.sqlite-shm
- .wrangler/state/v3/cache/miniflare-CacheObject/metadata.sqlite-wal
- .wrangler/state/v3/r2/miniflare-R2BucketObject/b76362ef556bf5e57f0b475c1a3e8d8f58ea0949f5ce0541efd676559c092002.sqlite-shm
- .wrangler/state/v3/r2/miniflare-R2BucketObject/b76362ef556bf5e57f0b475c1a3e8d8f58ea0949f5ce0541efd676559c092002.sqlite-wal
- .wrangler/state/v3/r2/miniflare-R2BucketObject/metadata.sqlite-shm
- .wrangler/state/v3/r2/miniflare-R2BucketObject/metadata.sqlite-wal
- .wrangler/state/v3/r2/toolnet-cli-releases/blobs/1269a1fcbe3d28ab556f13fb0c9c0fd6a246e9f3eb46f32ce226cb9363656ff1000001a0e0ba937e

Baseline blockers:
- Tracked .wrangler state files in git
