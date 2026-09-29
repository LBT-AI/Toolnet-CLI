# Phase 1.6 — Tool Execution Acceptance

Phase 1 status: PASS

## Core invariants

CallId identity: PASS
Exactly-once settlement: PASS
Browser capability: PASS
Web fetch resilience: PASS
Structured errors: PASS
No fake success: PASS
Active cleanup: PASS

## Integration matrix

A success: PASS
B parallel out-of-order: PASS
C same-tool-name: PASS
D browser unavailable: PASS
E browser available: PASS
F fetch transient recovery: PASS
G fetch exhaustion: PASS
H 404: PASS
I read directory: PASS
J missing file: PASS
K security deny: PASS
L permission deny: PASS
M permission approve: PASS
N cancel + late success: PASS
O internal throw: PASS
P process failure: PASS
Q invalid input: PASS
R unknown tool: PASS
S duplicate callId: PASS
T duplicate settlement: PASS

## Regressions found

NONE

## Known deferred issues

- assistant fragment T → Phase 2
- static tool activity marker → Phase 2
- maxTurns=10 → Phase 3
- php -r / /dev/null policy → Phase 4
- recovery intelligence → Phase 5
- session/steer lifecycle → Phase 6
- ~~lspGoldenE2E test failure (environment-dependent, see CLAUDECODE) → Phase 8~~ RESOLVED in Phase 1.6.1: test-isolation fix only. Root cause: the fixture's spawned `bun test` inherited `CLAUDECODE` from the developer shell, which makes bun print a condensed report without test names; the assertion `report).toContain("findUser returns a tagged id")` then fails. The test now strips `CLAUDECODE`/`CLAUDE_CODE_*` from the child env (hermetic fixture run). Verified: PASS with and without `CLAUDECODE=1` (3 consecutive runs each). Production behavior unchanged.
- ~~PTY paste collapse test failure (environment-specific) → Phase 8~~ RESOLVED in Phase 1.6.1: NOT a failure. Reproduced 4× in the controlled environment (node v22.23.3, bun 1.4.0, node-pty available, dist present): 3/3 tests PASS every run. The earlier "failure" was not reproducible; classification: environment-sensitive reporting in the prior run, no code change made.

## Full validation (Phase 1.6.1 — re-run in controlled environment)

Environment: node v22.23.3, bun 1.4.0, npm 10.9.9; `CLAUDECODE`/`CI` unset; `TERM=xterm-256color`, `SHELL=/bin/bash`.
Repo preserved: HEAD 825cee8c617599e31f8db5d8845852e5c615515c, dirty work kept (no reset/stash/revert).

Typecheck: PASS (tsc --noEmit)
Tests: 3294 passed / 0 failed / 20 skipped (3314 tests, 285 files — measured 2026-09-28, not carried over from any report)
Build: PASS (bun build → dist/node, 665 modules)
npm pack: PASS (toolnetcli-1.3.0.tgz, 6 files, dry-run)
Phase 1 integration matrix: PASS (20/20 unchanged)

Production behavior changed: NO (only `src/teamwork/__tests__/lspGoldenE2E.test.ts` test-isolation env sanitization)

Files changed (Phase 1.6.1):
- src/teamwork/__tests__/lspGoldenE2E.test.ts (test-only: hermetic child env for the spawned fixture test)
- docs/phase-1-6-tool-execution-acceptance.md (this file)

Files changed:
- src/core/contracts.ts
- src/lib/agentTools.ts
- src/lib/browserTool.ts
- src/lib/codingAgent.ts
- src/lib/harness/agentHarness.ts
- src/lib/harness/toolExecutor.ts
- src/lib/security/toolGateway.ts
- src/lib/security/types.ts
- src/teamwork/__tests__/abortAndOAuthRegression.test.ts
- src/teamwork/__tests__/browserTool.test.ts
- src/tui/events/agentWiring.ts
- (plus various test files and patches, but these are test/validation artifacts)

Report: docs/phase-1-6-tool-execution-acceptance.md

Phase 1 Tool Execution Reliability CLOSED (Phase 1.6.1: all gates green in one controlled run).
