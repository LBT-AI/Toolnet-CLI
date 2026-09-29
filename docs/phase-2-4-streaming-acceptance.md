# Phase 2.4 — Streaming + Live Activity Acceptance Gate

HEAD base: `825cee8c617599e31f8db5d8845852e5c615515c` + Phase 2.1/2.2/2.3 fixes
Status: PHASE 2 CLOSED

## Purpose

Close Phase 2 with one deterministic integration matrix covering every
streaming + live-activity scenario from Phases 2.1–2.3, plus a re-run of the
Phase 1 acceptance suites. No production code was changed in this phase.

## Integration matrix (17/17 PASS)

Driver: `buildTuiAgentCallbacks()` — the SAME handler set the TUI uses —
through `tuiState` + `chatRenderer`. No real provider, no timers.
File: `src/tui/__tests__/streamingAcceptanceMatrix.test.ts`

| #  | Scenario                          | Result | Key assertions                                                                 |
|----|-----------------------------------|--------|--------------------------------------------------------------------------------|
| 1  | "T" fragment regression           | PASS   | pre-tool "T" survives; synthesis continues; ONE responseKey; text rendered     |
| 2  | text → tool → text                | PASS   | full text preserved across segments; one responseKey; exactly one tool row     |
| 3  | tool-only                         | PASS   | empty tool segment carries the call; NO orphan empty assistant bubble          |
| 4  | multiple tools                    | PASS   | 2 calls on one segment; out-of-order results; exactly one row per callId       |
| 5  | silent Fetch spinner              | PASS   | animated canonical frame (no static ●); label + target + "8s"                  |
| 6  | silent Run spinner                | PASS   | shell activity animates; "Run bun test src/tui · 16s"                          |
| 7  | tool progress tail                | PASS   | tail bounded to 3 rows (wide cols); newest kept; width-safe; no ms in elapsed  |
| 8  | success cleanup                   | PASS   | tool-result REMOVES the live activity → overlay empty; result row persisted; no spinner state in transcript |
| 9  | error cleanup                     | PASS   | errored/completed/cancelled activities never paint; only running ones do       |
| 10 | cancel cleanup                    | PASS   | cancelled event removes ALL activities; exactly ONE cancelled transcript row per tool; phase `cancelled` |
| 11 | UTF-8 Vietnamese                  | PASS   | exact diacritics through state AND renderer; no `\uFFFD`                       |
| 12 | emoji / multi-byte                | PASS   | 🇻🇳 surrogate pair SPLIT across deltas reassembles exactly; no `\uFFFD`          |
| 13 | provider error mid-stream         | PASS   | received content verbatim; phase `error` (never fake DONE); late delta dropped |
| 14 | cancel mid-stream                 | PASS   | NO late delta appended; phase `cancelled`                                      |
| 15 | frame 52x20                       | PASS   | chat + live activity ≤ 52 cols; emoji intact; animated; elapsed rendered       |
| 16 | frame 80x24                       | PASS   | same contract at 80 cols                                                       |
| 17 | frame 120x30                      | PASS   | same contract at 120 cols                                                      |

Note on 8/10: production cleanup is REMOVAL from the live activity map
(`closeActiveToolActivity` / `cancelAllToolActivities` + `clearToolActivities`),
which is strictly stronger than a status flip — settled activities vanish from
the overlay in the same frame and leave only transcript rows. The matrix
asserts exactly this contract.

## Phase 1 acceptance suites (re-run, all PASS)

| Suite                                              | Result |
|----------------------------------------------------|--------|
| src/core/__tests__/toolExecutionLifecycle.test.ts  | PASS   |
| src/core/__tests__/toolErrorContract.test.ts       | PASS   |
| src/lib/harness (tool execution lifecycle harness) | PASS   |
| src/teamwork/__tests__/browserTool.test.ts         | PASS   |
| src/teamwork/__tests__/abortAndOAuthRegression.test.ts | PASS |
| src/teamwork/__tests__/lspGoldenE2E.test.ts        | PASS   |
| src/teamwork/__tests__/securityIntegration.test.ts | PASS   |
| src/teamwork/__tests__/harnessCoreModules.test.ts  | PASS   |

Explicit re-run total: 101 pass / 0 fail across these 7+ files.

## Full validation

- `bun run typecheck` → PASS (tsc --noEmit, clean)
- `bun test` → **3350 pass / 0 fail / 20 skip** (3370 tests, 289 files)
- `bun run build` → PASS (bun build → dist/node, 665 modules, index.js 2.89 MB)
- `npm pack --dry-run` → PASS (toolnetcli-1.3.0.tgz, 6 files, 1.2 MB)

## Files changed (this phase)

- src/tui/__tests__/streamingAcceptanceMatrix.test.ts (NEW — test only)
- docs/phase-2-4-streaming-acceptance.md (this file)

Production behavior changed: NO.

## Phase 2 summary (what closed)

- 2.1 — responseKey semantic identity: one logical assistant response keeps
  ONE identity across deltas, tool segments and synthesis; pre-tool text no
  longer dropped ("T" fragment fixed).
- 2.2 — live activity: ONE canonical animated spinner + self-cancelling 90 ms
  heartbeat; completed/errored/cancelled activities vanish same-frame.
- 2.3 — streaming hardening: terminal-state guard (settled/terminalPhase) —
  no late delta after cancel/error/complete, idempotent terminal events, no
  fake DONE; role separation and UTF-8 integrity pinned by tests.

## Verdict

Phase 2: CLOSED
Relevant failures: 0
Deferred (unchanged, from Phase 1 list): maxTurns → Phase 3, php -r /
/dev/null policy → Phase 4, recovery intelligence → Phase 5, session/steer
lifecycle → Phase 6.
