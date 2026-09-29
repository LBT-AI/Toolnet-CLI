# ToolNet CLI v1.4.0 — Release Notes (draft)

> Status: **release candidate — not published**. No git tag and no npm/binary
> publish has been performed.

## Highlights

- **Long tasks finish instead of dying at 10 turns.** The agent loop now extends
  the turn budget in bounded chunks while work is genuinely progressing, and
  stops early on no-progress or equivalent-failure loops.
- **Failures are actionable.** Tool failures carry structured, machine-readable
  errors and a bounded, code-driven recovery policy (alternate tool / changed
  strategy / replan / stop) instead of blind retries.
- **Steering that never loses work.** A follow-up submitted while a task is
  running becomes a session steer, delivered exactly once at the next boundary,
  and it survives a crash.
- **Fewer false security blocks.** Safe `php -r` inspection and `2>/dev/null`
  redirections are allowed; destructive payloads remain denied.

## Fixes

- Tool results are correlated by call id — out-of-order and same-name calls can
  no longer mismatch.
- `browser` is only offered when a real Chromium runtime exists; otherwise the
  task recovers via `web_fetch`.
- Web-fetch timeouts/HTTP errors are classified; 4xx is not blindly retried.
- `read_file` on a directory recovers with `list_dir`.
- Session lifecycle hardening: one foreground request at a time, no empty-prompt
  continuation, failures never settle as done, cancellation is final, and a
  crashed run resumes as `interrupted` with no destructive replay.
- Installer: successful `install.sh` runs exit 0 again, and the Windows archive
  ships `toolnet.exe` as the PowerShell/Scoop installers expect.

## Upgrade notes

- Requires Bun `>= 1.4.0` (CI pinned) and Node `>= 20` (Node 22 primary).
- No configuration migration is required; existing sessions and credentials are
  reused.

## Verification (release candidate)

- Typecheck, full unit + E2E suite, Bun/Node bundles, `npm pack --dry-run`.
- Phase 7 production-regression gate: 25/25 scenarios.
- Standalone binaries built and checksum-verified for linux-x64, linux-arm64,
  darwin-x64, darwin-arm64, windows-x64.
- Installer smoke: OS/arch detection, SHA-256 verification, safe install,
  `~/.local/bin` fallback, existing-install replacement, failure-safe checksum
  handling, unsupported-arch rejection, and no rc-file/PATH mutation.
- Tracked-file secret scan: clean.

## Post-release steps (not done in this phase)

1. `npm publish` the `toolnetcli@1.4.0` package.
2. Create the Git tag `v1.4.0` and let `release.yml` build + attach binaries and
   `checksums.txt`.
3. `scripts/update-formula-checksums.sh v1.4.0` and
   `scripts/update-scoop-manifest.sh v1.4.0` to fill real checksums.
