# Phase 7 — Production Regression + E2E Gate

HEAD base: Phase 6 closed (`825cee8`, Phase 0–6 docs present)
Status: PASS — no feature added; the Phase 1–6 fix set is re-proven together.

## Scope

Phase 7 introduces **no production behavior change**. It adds two deterministic
artifacts and one report:

- `src/teamwork/__tests__/productionRegressionE2E.test.ts` — the 25 mandatory
  scenarios (E2E matrix), driving the REAL `AgentHarness` / `AgentEngine` /
  `SessionRunDriver` / `SessionStore` / `ToolGateway` / `SecurityEngine` /
  transcript reconciler.
- `scripts/phase7-terminal-matrix.ts` — the terminal + text matrix at the three
  canonical sizes.
- this document.

Rules honoured throughout:

- **No real external dependency.** Providers are scripted fetch stubs
  (turn-counting `Response`-like objects); `web_fetch` hosts are fixtures;
  browser is a module-mocked Playwright with a fake/missing Chromium path.
- **Deterministic.** No sleeps — races use deferred promises/barriers; workspace
  is a `mkdtempSync` temp dir; sessions a temp `TOOLNETCLI_SESSIONS_DIR`.
- **No redesign.** Reuses the established Phase 3–6 test techniques verbatim.

## E2E matrix — 25 scenarios

`bun test src/teamwork/__tests__/productionRegressionE2E.test.ts` → **25 pass /
0 fail** (140 expect calls). Each scenario runs production code paths only.

| # | Scenario | Proof (production path) | Result |
|---|---|---|---|
| 01 | Long realistic task (>10 turns) with progress | 12 distinct reads + 1 verified mutation + synthesis; adaptive budget extends the soft budget | PASS |
| 02 | Browser unavailable | `getBrowserCapability()` → `available:false`; `executeBrowserTool` → `TOOL_UNAVAILABLE`; harness omits the `browser` schema | PASS |
| 03 | Browser available fixture | capability green; harness offers the `browser` schema | PASS |
| 04 | `web_fetch` timeout→retry→success | AbortError on the timeout fixture → changed-strategy recovery → 200 fixture; `turnsUsed === 3` | PASS |
| 05 | `web_fetch` permanent error | 404 → replan instruction; identical retry stops (`Recovery exhausted`) at 2 turns | PASS |
| 06 | Read-directory recovery | `read_file(dir)` → `NOT_A_FILE` → one `list_dir` recovery → task continues | PASS |
| 07 | Permission approve | scope `shell:"ask"` + approval hook `true` → command executes; `approvals === 1` | PASS |
| 08 | Permission deny | hook `false` → `approvalRequired`, run stops, command never ran | PASS |
| 09 | Security deny | out-of-workspace write → `OUTSIDE_WORKSPACE` structured denial; re-issue stops (`Policy bypass attempt blocked`); nothing written | PASS |
| 10 | `php -r` safe inspection | policy `ALLOW` for read-only payload; destructive payload stays `DENY` | PASS |
| 11 | `2>/dev/null` | `READ_ONLY` / `SAFE_READ`, `ALLOW`; smuggled protected write stays `DENY` | PASS |
| 12 | Out-of-order tools | reconciler correlates by call id (partial results out of order); parallel batch correlates 2 results by id | PASS |
| 13 | Same-name tools | two `read_file` results out of order → corrected by id; one turn with two same-name calls maps correctly | PASS |
| 14 | Cancellation race | `SessionRunDriver` cancel; late provider success cannot resurrect; steer preserved | PASS |
| 15 | Assistant text→tool→text | transcript order assistant(text+call) → tool → assistant(text); final answer intact | PASS |
| 16 | Silent long-running activity | empty-tail activity renders elapsed `15s` + action within width at 52/80/120 | PASS |
| 17 | Queued steer at completion | steer admitted inside `onSettle` becomes the next run atomically; no IDLE in between | PASS |
| 18 | Provider error | generic HTTP 400 → fails loudly once, no tool executed | PASS |
| 19 | Crash/restart/resume | `SessionStore.resume` → `interrupted`, call surfaced `started_without_completion`, no fabricated result, idempotent | PASS |
| 20 | No-progress loop | 40 identical calls → `Infinite loop detected`, stops early | PASS |
| 21 | Repeated equivalent failures | equivalent variants → `equivalent argument variants`, bounded | PASS |
| 22 | Structured errors model-facing | 2nd provider request carries the machine-readable `structuredError.code === "NOT_A_FILE"` | PASS |
| 23 | Plan-mode write denial | plan scope denies `write_file`/`shell`; mutation refused (`PERMISSION_DENIED`); no file | PASS |
| 24 | Foreground/subagent separation | derived child scope cannot widen the parent; subagent write denied; child sessions isolated | PASS |
| 25 | Compaction/context continuation | context-overflow → one bounded compaction (`provider_overflow`) → retry continues to success | PASS |

**E2E matrix: 25/25.**

## Terminal + text matrix

`bun scripts/phase7-terminal-matrix.ts` → **ALL SIZES PASS** at 52x20, 80x24 and
120x30. Real `buildFrame()` + real renderers + real key decoder.

| Check | 52x20 | 80x24 | 120x30 |
|---|---|---|---|
| Vietnamese heading painted without `#` | ✓ | ✓ | ✓ |
| Vietnamese tokens intact in painted frame | ✓ | ✓ | ✓ |
| Full Vietnamese sentence reconstructs after wrap | ✓ | ✓ | ✓ |
| No `??` / `U+FFFD` garbage | ✓ | ✓ | ✓ |
| No lone surrogate | ✓ | ✓ | ✓ |
| No literal markdown markers (`**`, backtick) | ✓ | ✓ | ✓ |
| Composer prompt painted | ✓ | ✓ | ✓ |
| Emoji/CJK within chat width (0 overflow) | ✓ | ✓ | ✓ |
| Emoji preserved (✅ 🚀 😀 中文测试) | ✓ | ✓ | ✓ |
| No replacement char in emoji text | ✓ | ✓ | ✓ |
| Long paste collapses to atomic token | ✓ (`[40 lines pasted #1]`) | ✓ | ✓ |
| Collapsed paste within terminal width | ✓ | ✓ | ✓ |
| IME fragmented (1-byte) Vietnamese round-trip | ✓ | ✓ | ✓ |
| IME burst Vietnamese round-trip | ✓ | ✓ | ✓ |
| Long-line caret stays inside viewport | ✓ | ✓ | ✓ |

Text coverage: **Vietnamese UTF-8**, **emoji + wide CJK glyphs**, **long pasted
prompts** (40-line paste → one atomic composer token, full content preserved),
and **IME/paste behaviour** driven through the real `TerminalKeyDecoder` →
`handleKey` pipeline at fragmented and burst frame boundaries.

Existing visual gate re-run for regression: `bun scripts/visual-acceptance.ts`
→ `ALL SIZES PASS`.

## Regression integrity

- Phase 7 modified **zero production source files**; it added a test file, a
  script and this doc. Therefore the pack artifact is byte-identical to the
  Phase 6 pack (`shasum 37452c78…`, 6 files) — evidence that nothing shipped
  changed.
- The full suite gained exactly the new file: 293 → 294 test files,
  3448 → 3473 tests, 3428 → 3453 passes, skips unchanged at 20, failures 0.

## Validation

| Gate | Result |
|---|---|
| `bun run typecheck` | PASS |
| `bun test` (full) | **3453 pass / 20 skip / 0 fail** (3473 tests, 294 files) |
| `bun run build` | PASS — bun `index.js` 2.82 MB (647 modules), node `index.js` 2.94 MB (667 modules) |
| `npm pack --dry-run` | PASS — `toolnetcli-1.3.0.tgz`, 5.8 MB unpacked / 1.3 MB packed, 6 files, shasum `37452c78…` |

Phase 6 baseline was 3428 pass / 20 skip (3448 tests, 293 files):
+25 tests, +1 file, zero failures, zero regressions.

## Known-open issues

| Severity | Count | Notes |
|---|---|---|
| P0 | 0 | — |
| Core-flow P1 | 0 | — |

The 20 skips are the pre-existing **live/external** suites (real
`typescript-language-server` acceptance, `REAL MODEL E2E`, live OpenRouter
acceptance, clean-HOME smoke) — deliberately excluded from the deterministic
gate; no reproducible P0/P1 failure was observed.

## Files added

- `src/teamwork/__tests__/productionRegressionE2E.test.ts` — 25-scenario gate.
- `scripts/phase7-terminal-matrix.ts` — terminal/text matrix.
- `docs/phase-7-production-regression.md` — this report.

## FINAL

Phase 7: PASS
E2E matrix: 25/25
P0 open: 0
P1 core open: 0
Typecheck: PASS
Tests: 3453 pass / 20 skip / 0 fail (3473 tests, 294 files)
Build: PASS
Pack: PASS
