# Phase 5 — Structured Error-Driven Recovery

HEAD base: Phase 4 closed (`825cee8`, Phase 4 doc added)
Status: FIXED

## Problem (from docs/phase-0-6-read-file-directory.md — TN-R0-006)

Phase 1.4 made `StructuredToolError` canonical (`code`, `message`, `retryable`,
`suggestedAction`, `suggestedTool`), and `read_file(directory)` already returns
`NOT_A_FILE` with `suggestedTool: "list_dir"`. Nothing *consumed* it: the loop
handed the raw envelope to the model, burned a turn on the failure, and left the
agent to guess the recovery path from prose. There was no machine-readable
recovery policy, no bound on recovery attempts, and no rule that separated
"recover" from "this failure must stop the run" (policy denials, cancellation,
internal errors).

Phase 5 adds that policy — **code-driven, bounded, and independent of the turn
budget** — without changing Phase 3's budget logic.

## Design

### 1. One decision point: `src/core/harness/recovery.ts`

`RecoveryGovernor.assess(failure)` is the only place a structured failure is
turned into a recovery decision. A failure is
`{ toolName, args, error: StructuredToolError, target?, availableTools? }` and
the verdict is:

```ts
{ action, code, signature, stop, reason, alternateTool?, instruction?, error?, attemptsUsed }
```

`action` is one of `alternate | retry-with-changes | replan | await-approval |
stop | none`. `stop: true` means the harness must end the run with `error`;
`stop: false` + `instruction` means the model gets exactly one bounded,
recovery-shaped next step. Recovery is driven **only** by
`structuredError.code` — `extractStructuredError()` JSON-parses the tool
envelope and never parses prose.

| `code` | Decision |
|---|---|
| `NOT_A_FILE` | `alternate` → `list_dir` (the error's `suggestedTool` when available, else `RECOVERY_DEFAULT_DIRECTORY_TOOL`); one call, never `read_file` on that target again |
| `TOOL_UNAVAILABLE` | `alternate` when a semantically valid tool exists (`browser`/`browser_action` → `web_fetch`, only when the request does **not** need real browser interaction); otherwise `replan` — the same unavailable tool is never retried |
| `TIMEOUT` / `NETWORK_ERROR` | tool-internal retries already ran first → one bounded `alternate` when a mapping exists, else one `retry-with-changes` ("a different tool, target or approach") |
| `HTTP_ERROR` | `404`/`403` → `replan` ("do not retry the same request"); `5xx`/other after internal exhaustion → one bounded `alternate`/`retry-with-changes` |
| `SECURITY_DENIED` | `replan` — never rewrite the command into a variant to bypass policy |
| `PERMISSION_DENIED` | `replan` — the user said no; do not obtain the effect another way |
| `PERMISSION_REQUIRED` | `await-approval` — wait for the decision, never spam alternatives |
| `OUTSIDE_WORKSPACE` | `replan` — a workspace-boundary verdict is a policy verdict (same target may not be re-attempted; a **different** target stays legal) |
| `CANCELLED` | `stop` immediately — no recovery, no corrective turn |
| `INTERNAL_ERROR` | `stop` immediately — no blind retries |
| anything else (`EXECUTION_FAILED`, `NOT_FOUND`, `INVALID_INPUT`, …) | `none` — policy not applicable, legacy behavior untouched |

### 2. Anti-loop: semantic failure signature + bounded budget

```ts
signature        = semanticFailureSignature(tool, args) :: code :: target   // normalized, order-insensitive
denialSignature  = tool :: code :: target                                   // whitespace/case-normalized, args ignored
```

- The **precise** signature catches "same failure repeated" and "equivalent
  variants" (`exit 1` ≡ `EXIT 1`, `read_file {path:"src"}` ≡ `{path:"SRC"}`)
  while a genuinely changed call stays a different signature.
- The **denial** signature is deliberately coarser: for policy/permission
  verdicts *any* retry against the same target is a bypass attempt, so
  `cat /etc/shadow` → `cat  /etc/shadow ` stops the run.
- Budgets are centralized constants, per-signature and per-run, and are
  independent of the Phase 3 turn budget:

  - `RECOVERY_MAX_ATTEMPTS_PER_SIGNATURE = 1`
  - `RECOVERY_MAX_TOTAL_ATTEMPTS = 3`

### 3. Loop integration (`agentHarness.executeLoopInner`)

One `RecoveryGovernor` per run. Every terminal tool failure feeds it —
preflight errors (INVALID_INPUT/TOOL_UNAVAILABLE), `!allowed` denials,
non-zero exits, custom-tool failures and executor-forced settlements
(cancel/timeout/throw). After the batch is fully settled (every `tool_call`
still gets a transcript answer):

- `stop: true` → the run returns `success: false` with the recovery error
  (`Recovery exhausted…`, `Recovery budget exhausted…`,
  `Policy bypass attempt blocked…`, `Approval is still pending…`, `Cancelled:
  recovery stopped…`, `Internal tool error…`). Emitted as
  `agent:error { code: "RECOVERY_STOP" }`.
- otherwise the granted recovery is pushed as **one** corrective `user`
  message naming the deterministic alternate — the model's next turn is a
  recovery, not a guess.

Phase 3's turn budget, no-progress guard and semantic equivalent-failure guard
are unchanged and still apply; Phase 5 only *adds* progress-neutral recovery
signals (a recovery instruction is a corrective turn, and failed recoveries
consume the Phase 3 failure accounting exactly as before).

## Behavior (before → after)

| Scenario | Before | After |
|---|---|---|
| `read_file(dir)` | `NOT_A_FILE` envelope, model guesses, extra turns | one `list_dir` recovery instruction delivered; repeats stop the run |
| `browser` unavailable | same call retried / model guesses | one `web_fetch` alternate when semantics allow; interaction requests (`screenshot`, `click`, …) are told web_fetch is NOT equivalent |
| web fetch timeout after 3 internal attempts | model may repeat identically | one bounded changed strategy; an identical repeat stops |
| HTTP 404 | possible identical retry loop | `replan` instruction; an identical retry stops |
| policy denial (`SECURITY_DENIED`/`PERMISSION_DENIED`) | model free to try variants | replan instruction, and any retry against the same target stops with `Policy bypass attempt blocked` |
| approval required | model could spam alternates | `await-approval`; a repeat stops with `Approval is still pending` |
| cancel / internal error | generic handling | recovery stops immediately, run ends with a distinguishable error |
| generic `exit 1` shell failure | Phase 3 semantic guard | unchanged (`EXECUTION_FAILED` has no recovery policy) |

## Tests

`src/core/harness/__tests__/recoveryIntelligence.test.ts` (25 tests) — governor
unit tests (all codes, budgets, signatures, envelope extraction) plus the
harness scenarios A–J on the REAL loop with a stubbed provider:

| # | Scenario | Assertion |
|---|---|---|
| A | read dir → `list_dir` recovery | `read_file(dir)` → follow-up request contains the `NOT_A_FILE` hint naming `list_dir`; task completes (3 turns) |
| B | unavailable browser → no repeated browser | one `browser_action` attempt, alternate `web_fetch` instruction, `web_fetch` succeeds, no second browser call |
| C | timeout exhausted → bounded alternate | `TIMEOUT` after internal retries → "different strategy" instruction; identical repeats are disallowed; run completes by switching target |
| D | 404 → no loop | `replan` mentions 404 + "Do not retry the same request"; identical retry stops at turn 2 |
| E | permission denied → no bypass variants | scope-denied `shell` twice → `Policy bypass attempt blocked`, 2 turns |
| F | security denied → no bypass | out-of-workspace write twice → `Policy bypass attempt blocked`; nothing written outside the workspace |
| G | cancel → no recovery | `CANCELLED` stops the run at turn 1; exactly one provider turn, no corrective prompt |
| H | repeated equivalent failure → stop | second identical `NOT_A_FILE` → `Recovery exhausted`, 2 turns |
| I | successful recovery → continue | recovery then completion with `success: true` |
| J | recovery itself fails → bounded stop | granted recoveries ≤ `RECOVERY_MAX_TOTAL_ATTEMPTS`; run stops at ≤ 3 turns instead of the 20-turn budget |

Deterministic: stubbed provider + stubbed tool fetches, temp dirs, no real
provider and no long timers (the only waits are the tool's own 250/750 ms
internal retry backoff in the two fetch scenarios).

## Validation

| Gate | Result |
|---|---|
| `bun run typecheck` | PASS |
| `bun test` (full) | **3415 pass / 20 skip / 0 fail** (3435 tests, 292 files) |
| `bun run build` | PASS — bun `index.js` 2.81 MB, node `index.js` 2.93 MB |
| `npm pack --dry-run` | PASS — `toolnetcli-1.3.0.tgz`, 6 files |

Phase 4 baseline was 3390 pass / 20 skip (3410 tests, 291 files): +25 tests,
+1 file, zero failures, zero regressions (Phase 3 adaptive-budget,
max-turns/progress, integration, security and teamwork suites all unchanged).

## Files changed

- `src/core/harness/recovery.ts` (new) — `RecoveryGovernor`, policy tables,
  signatures, alternate selection, browser semantics guard, terminal errors,
  `extractStructuredError`.
- `src/core/harness/index.ts` — barrel exports for the policy.
- `src/lib/harness/agentHarness.ts` — per-run governor, `noteRecovery` wired to
  every structured failure path, bounded corrective instruction delivery, and
  the code-driven recovery stop.
- `src/core/harness/__tests__/recoveryIntelligence.test.ts` (new) — 25 tests.

## FINAL

Phase 5 complete.
Structured recovery: PASS
Anti-loop: PASS
Security-denied behavior: PASS
Directory recovery: PASS
Unavailable tool handling: PASS
Tests: 3415 pass / 0 fail / 20 skip (3435 tests, 292 files); typecheck PASS; build PASS; `npm pack --dry-run` PASS.
