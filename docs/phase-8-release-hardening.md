# Phase 8 — Release Hardening

HEAD base: Phase 7 closed (production regression gate added)
Status: release candidate prepared — **not published**, no tag created.

## 1. Git hygiene

Generated runtime / emulator state was tracked. It is now removed from the index
(working files kept) and covered by `.gitignore`:

| Path | Kind | Action |
|---|---|---|
| `.wrangler/state/v3/cache/miniflare-CacheObject/metadata.sqlite-{shm,wal}` | SQLite sidecars | untracked |
| `.wrangler/state/v3/r2/miniflare-R2BucketObject/*.sqlite-{shm,wal}` | R2 emulator SQLite | untracked |
| `.wrangler/state/v3/r2/toolnet-cli-releases/blobs/<sha>` | temporary R2 blob | untracked |
| `.bravecode/snapshots/snapshots.json` | editor state | untracked |
| `ToolNet-CLI-Phase-73-Plan.zip` | dev archive | untracked |

New `.gitignore` rules: `.wrangler/`, `.wrangler/state/**`, `*.sqlite-shm`,
`*.sqlite-wal`, `*.zip`, and root dev-scratch scripts (`/debug_state*.py`,
`/fix_harness_test*.py`, `/patch*.py`, …).

**Kept (reviewed, legitimate):** `bucket/toolnet.json` (Scoop manifest),
`Formula/toolnet.rb`, `sqliteMock.ts` / `cache.ts` (source), and the LSP/MCP
test fixtures under `src/**/__tests__/`.

## 2. Secret scan

`scripts/phase8-secret-scan.ts` scans **tracked** files and reports only
`path:line:category` — matched values are never printed. Run in CI.

Result over **763 tracked files**:

| Class | Count | Actionable in non-test source |
|---|---|---|
| High-confidence credential shapes | 48 | **0** (45 in tests/fixtures, 1 redaction-pattern definition) |
| Low-confidence `assigned secret` shapes | 46 | **0** |

**RESULT: CLEAN.** Every hit is either a fake key in a `__tests__`/fixture file
used to prove redaction, or the redaction regex literal in
`src/lib/security/outputRedactor.ts`. No real credential is present, so no
rotation is required.

## 3. CI reproducibility

| Concern | Fix |
|---|---|
| Pinned toolchain | Bun `1.4.0` and Node `22` pinned in `ci.yml`; `release.yml` no longer uses `bun-version: latest`. Added `.nvmrc` (`22`), `packageManager: bun@1.4.0`, `engines.bun >= 1.4.0`. |
| CLAUDECODE isolation | CI test step `unset`s `CLAUDECODE`/`CLAUDE_CODE_*`; `lspGoldenE2E` already strips them from its fixture env; PTY child env is sanitised in both the Bun and Python harnesses. |
| PTY test isolation | PTY suites resolve `ROOT` from `import.meta.dir` (not `process.cwd()`), are **opt-in** (`TOOLNET_PTY_ACCEPTANCE=1`), and skip **explicitly** (never silently pass) when the flag, node-pty, the built entry or a POSIX host is missing; the child env is isolated. PTY acceptance is deliberately NOT part of the default CI matrix (it needs a fragile native PTY module and a real TTY), keeping CI reproducible; CI still builds **before** testing. |

## 4. Cross-platform CI

`ci.yml` now runs a fail-fast-disabled matrix on **ubuntu-latest**,
**macos-latest** and **windows-latest**, each executing real smoke — not just
cross-compilation:

- `bun dist/index.js --help`
- `node dist/node/index.js --help`
- `node bin/toolnet.js --version`
- typecheck, full test suite, secret scan, installer smoke (POSIX), `npm pack --dry-run`.

A separate `compat (node 20)` job preserves the Node 20 persistence + CLI smoke.

> Runner execution note: the matrix is authored and validated locally on Linux;
> macOS/Windows runners execute on push. Cross-compiled binaries for all five
> targets were produced and checksum-verified locally.

### Follow-up from the first real CI run (run `36526332918`, commit `57e6f67`)

Every job failed on the first push. Audited root causes and fixes:

| Symptom | Root cause | Fix |
|---|---|---|
| `compat (node 20)` → *Install dependencies* | Declaring `node-pty@1.1.0` dragged a native `node-gyp` build into every job, which fails on the pinned Node 20 / headless image. | `node-pty` **un-declared**; PTY acceptance is opt-in and no longer installs anything in CI. |
| `test (ubuntu/macos/windows)` → *PTY acceptance* | GitHub-hosted headless runners do not provide a real interactive TTY; the PTY suites fail (and burn 20–50 s each) regardless of OS. | PTY acceptance gated behind `TOOLNET_PTY_ACCEPTANCE=1` and skipped **explicitly** — CI no longer depends on a native PTY module or a real TTY. |
| `test (all)` → `renderChatMessages renders empty conversation gracefully` | Process-global TUI leak: `stableViewport.test.ts` left `tuiState` tool activities set, so a sibling suite's “empty transcript” assertion saw 2 live rows. | `afterEach` cleanup in the leaking suite + **defensive precondition** (`clearToolActivities()`) in the renderer suite, so the assertion no longer depends on sibling order. |

Post-fix local gate: typecheck PASS; full suite **3442 pass / 31 skip / 0 fail**
(the 11 new skips are the explicitly opt-in PTY cases).

## 5. Package

`npm pack --dry-run` → **`toolnetcli@1.4.0`**, 6 files (1.3 MB packed / 5.8 MB
unpacked):

```
CHANGELOG.md, README.md, bin/toolnet.js, dist/index.js, dist/node/index.js, package.json
```

Package name `toolnetcli` ✓, bin `toolnet` → `bin/toolnet.js` ✓, no tests,
private docs, cache or generated state included.

## 6. Binary build

`scripts/phase8-build-binaries.sh` builds all five targets, archives them and
generates + verifies `checksums.txt`:

| Target | Result |
|---|---|
| linux-x64 | built + checksum OK |
| linux-arm64 | built + checksum OK |
| darwin-x64 | built + checksum OK |
| darwin-arm64 | built + checksum OK |
| windows-x64 | built + checksum OK (archive member `toolnet.exe`) |

Binary smoke: `./dist-bin/toolnet-linux-x64 --version` → `ToolNet CLI v1.4.0
(linux-x64)`; `--help` exits 0.

**Fix:** the Windows archive member was `toolnet-windows-x64.exe`, but both
`install.ps1` and the Scoop manifest expect `toolnet.exe`. `release.yml` now
stages `toolnet.exe`; `install.sh`'s Windows branch accepts it as well.

## 7. Installer

`scripts/phase8-installer-smoke.sh` (network-free, shimmed `curl`/`uname`) →
**9/9 PASS**:

1. linux-x64 detect + SHA-256 verify + install to the requested dir
2. unusable install dir → safe `~/.local/bin` fallback
3. existing install replaced atomically (no `.tmp` residue)
4. checksum mismatch rejected **before** install, old binary untouched
5. missing `checksums.txt` → warn + safe proceed
6. unsupported arch (`armv7l`) rejected
7. darwin-arm64 detection selects the correct artifact
8. no shell rc files created
9. no persisted PATH modification

**Two real bugs found and fixed:**

- `install.sh` aborted a **successful** run with
  `tmpdir: unbound variable` — the `EXIT` trap referenced a `local` that is
  unset by trap time under `set -u`. The temp dir is now a global with a
  `${tmpdir:-}` guard.
- `install.ps1` persisted a user PATH change; it is now **session-only** and
  prints the manual command (matching `install.sh`'s non-destructive stance).

## 8. Version

Change set since the released `1.3.0` = backward-compatible capability additions
(adaptive turn budget, structured recovery, durable steer) plus bug fixes →
**next semver: `1.4.0` (minor)**.

Updated: `package.json` `1.4.0`; `src/lib/version.ts` `EMBEDDED_VERSION`
`1.4.0`; `bucket/toolnet.json` version + URL `1.4.0`; `Formula/toolnet.rb`
version `1.4.0`; `CHANGELOG.md` `[1.4.0]` section; draft
`docs/release-notes-1.4.0.md`; version-agnostic `non-tui-isolation` test.

> Not done (by design, requires a publish): real Formula/Scoop checksums and the
> `v1.4.0` tag. `scripts/update-formula-checksums.sh v1.4.0` and
> `scripts/update-scoop-manifest.sh v1.4.0` fill them after publishing.

## 9. Public distribution

`docs/public-distribution.md` defines the split: canonical dev remains
`LBT-AI/Toolnet-CLI`; the public repo `ToolNetWorks/ToolNet-CLI` receives only
the release/docs surface (README, CHANGELOG, release notes, installers,
`Formula/`, `bucket/`, LICENSE, release artifacts) — never `src/`, `tests/`,
`scripts/`, `.github/`, internal `docs/phase-*`, or generated state. An
allow/deny checklist and the existing package/`.gitignore` guardrails are
documented.

## 10. Release candidate validation

| Gate | Result |
|---|---|
| `bun run typecheck` | PASS |
| `bun test` (full) | **3453 pass / 20 skip / 0 fail** (3473 tests, 294 files) |
| `bun run build` | PASS — bun 2.82 MB (647 modules), node 2.94 MB (667 modules) |
| `npm pack --dry-run` | PASS — `toolnetcli@1.4.0`, 6 files |
| Binary build + checksums | PASS — 5/5 targets verified |
| Binary smoke (linux-x64) | PASS — `v1.4.0` + `--help` |
| Installer smoke | PASS — 9/9 |
| Secret scan | PASS — CLEAN |
| Terminal matrix (52x20/80x24/120x30) | PASS |
| Visual acceptance | PASS |

The 20 skips are the pre-existing live/external suites (real
`typescript-language-server`, REAL MODEL E2E, live OpenRouter, clean-HOME smoke).

Open issues: **0 P0, 0 reproducible core-flow P1.**

## Files changed in Phase 8

- `.gitignore` — generated-state + scratch rules.
- `.nvmrc`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`.
- `install.sh`, `install.ps1` — installer correctness + non-destructive PATH.
- `package.json`, `src/lib/version.ts`, `Formula/toolnet.rb`, `bucket/toolnet.json`,
  `CHANGELOG.md` — version `1.4.0`.
- `scripts/phase8-secret-scan.ts`, `scripts/phase8-installer-smoke.sh`,
  `scripts/phase8-build-binaries.sh` (new).
- `scripts/pty-acceptance.py`, `tests/e2e/pty-acceptance.test.ts`,
  `tests/e2e/pty/*.test.ts` — PTY isolation.
- `tests/e2e/tier1-features/non-tui-isolation.test.ts` — version-agnostic.
- `docs/phase-8-release-hardening.md`, `docs/release-notes-1.4.0.md`,
  `docs/public-distribution.md` (new).

## FINAL

Phase 8 complete.
Release candidate: READY
P0: 0
P1 core: 0
Tests: 3453 pass / 20 skip / 0 fail (3473 tests, 294 files)
Platforms: linux executed; ubuntu + macOS + Windows CI matrix configured (smoke CLI); 5/5 binaries built + checksum-verified
Package: toolnetcli@1.4.0 — npm pack --dry-run PASS (6 files)
Installer: 9/9 smoke checks PASS (2 real bugs fixed)
Version candidate: 1.4.0
Do not begin Phase 9.
