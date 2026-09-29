# Phase 6 — Session / Steer / Agent Lifecycle Correctness

HEAD base: Phase 5 closed (`825cee8`, Phase 4+5 docs added)
Status: FIXED

## Audit (what was actually wrong)

| Area | Finding |
|---|---|
| `src/tui/events/agentWiring.ts` | **Timing hack confirmed.** The completion boundary re-entered the loop through `setTimeout(() => sendMessage("", true).catch(() => {}), 0)` for pending steers and `setTimeout(() => sendMessage(nextTask.text), 50)` for the queue. Between the harness returning and the timer firing, the session was observably IDLE with work still pending, the follow-up ran outside the run's completion step, and "the run ended" vs "the run continues" was decided by a timer. |
| `sendMessage("", true)` | A continuation was expressed as an **empty prompt** — a synthetic turn whose only purpose was to make the harness promote the steer on a later, wasted model turn. |
| status / phase | Terminal status was written inside the turn body (three places) *and* re-derived in the event wiring. `tuiState.agentPhase` could be `done` while `messageQueue` still held work, and the queue drain flipped status text asynchronously. |
| `src/core/session/resume.ts` | **Crash/resume defect.** `replaySession` marked `sawTerminalEvent` for a plain `session.status` projection (e.g. `running`, `waiting_permission`), so a journal that ends with a non-terminal status update looked finished: `activeAtEnd` was false and `resume()` never reported `interrupted`. |
| Already correct (verified, unchanged) | `PendingInputRegistry` (FIFO by monotonic admission, idempotent admit by id, exactly-once promote, cancellation, durable journal fold) and `ToolGateway`/harness single-loop ownership. |

## Design — one deterministic lifecycle owner

### 1. `src/core/session/lifecycle.ts` — `SessionRunDriver`

A per-session driver, no timers, no I/O; the run executor and the input sources
are injected:

```ts
driver.submit(text)          // start, or admit as a steer when busy
driver.resumePendingWork()   // promote steers / drain the queue (no empty prompt)
driver.cancel()              // settle the active run, stop the drain
driver.whenSettled()         // resolves at the settled phase
driver.idleBlockers()        // why IDLE is not allowed right now
driver.refreshIdle()         // re-evaluate once a blocker cleared
```

Invariant mapping:

| # | Invariant | Enforcement |
|---|---|---|
| 1 | ≤ 1 foreground provider request | `submit()` while `isBusy()` never starts a run — it admits a steer (`admitSteer`) and returns `{ started: false, admittedAsSteer: true }`. The drain is strictly sequential (`await run(...)`). |
| 2 | steer FIFO, exactly once, never lost/duplicated | `promoteSteers()` (registry state machine + journal) is the only promotion path; the driver calls it once per boundary and consumes the returned content into exactly one run. |
| 3 | atomic completion boundary, no empty prompt | `nextWork()` runs **synchronously** in the same step as the settle (steers → queue → settle), and is re-checked after `onSettle` so a steer admitted *inside* the settle window still becomes the next run. A continuation carries the promoted steer text as its prompt — never `""`. |
| 4 | IDLE gate | `idleBlockers(inputs)` is the canonical mapping (foreground request, active tool, pending permission, pending steer, queued message, continuation, compaction, foreground subtask). The driver reports IDLE only when `idleBlockers()` is empty; otherwise it stays at the terminal phase and `refreshIdle()` settles it later. |
| 5 | FAILED never DONE | `phase` is written exactly once per run from the outcome: `cancelled ? "cancelled" : success ? "done" : "failed"`. The TUI paints from that settle only. |
| 6 | canonical error always reaches the TUI | `canonicalRunError()` maps every outcome to an actionable string (`"Execution failed"` for a bare failure, `"Cancelled"` for a cancel); `onSettle` is delivered exactly once per run and the TUI calls `statusManager.failed(...)`. |
| 7 | cancel settles, late results cannot resurrect | `cancel()` sets a cancel flag + aborts; the settle classifies as `cancelled` even when the provider later reports success; the drain stops (no auto-continuation), and `settledRunIds` makes a second settle for the same run impossible. |
| 8 | crash/restart persists safe state, no destructive replay | Durable state stays in `SessionStore` (journal + pending-input fold); `replaySession` never re-runs a tool. Fixed above: a non-terminal `session.status` no longer hides a crash. |

### 2. TUI wiring (`agentWiring.ts`)

- The two `setTimeout` boundaries and the `sendMessage("", true)` hack are
  **removed**. One `SessionRunDriver` per session is created lazily
  (`driverForSession`) and wired to the real sources:
  `promoteSteers → pendingInputs.promote`, `admitSteer → pendingInputs.admit`,
  `dequeueMessage → messageQueue.dequeue`, `abort → tuiState.abortController.abort`.
- `sendMessage(text)` keeps its public signature (callers unchanged): slash
  commands and greetings short-circuit as before, then the input goes to
  `driver.submit`. `sendMessage("", true)` is now an explicit
  `driver.resumePendingWork()` semantics — no empty user message is ever created.
- The turn body moved to `runForegroundTurn(run)`: it appends one user message
  per promoted steer (FIFO) or the submitted text, runs the shared agent engine,
  adopts the transcript, and returns `{ success, error, cancelled }`. It no
  longer decides terminal status.
- `settleForegroundRun` is the single terminal transition: cancelled → phase
  `cancelled` + `statusManager.cancel()`; failed → phase `error` +
  `statusManager.failed(canonical error)`; done → phase `done` +
  `statusManager.done()` — and when the boundary already found the next work, the
  status is `Processing steer… / Processing next queued message (N remaining)…`
  with the spinner kept alive instead of flashing a terminal "Done".
- `onIdle` clears `messageQueue.setIsProcessing(false)` and returns the phase to
  `idle` only after the gate is clear.

### 3. Resume fix (`src/core/session/resume.ts`)

`sawTerminalEvent` is now set only by the three genuinely terminal events
(`session.completed` / `session.failed` / `session.cancelled`). A journal whose
last durable record is a plain status projection is therefore reported as
`activeAtEnd`, and `SessionStore.resume` reports `interrupted` with the crash
warning — instead of silently looking finished.

## Behavior (before → after)

| Scenario | Before | After |
|---|---|---|
| steer arrives while the run is returning | depends on a `setTimeout(0)` window; session could be IDLE with work pending | chosen in the same synchronous step as the settle; the steer is the next run |
| continuation | `sendMessage("", true)` — an empty prompt + a wasted provider turn to get the steer promoted | the promoted steer text IS the next run's prompt |
| queued message | `setTimeout(..., 50)` | drained synchronously in the same boundary |
| submit while busy | depended on `tuiState.isStreaming` only | driver backstop admits it as a steer: no second provider request, nothing lost |
| cancel with a late provider success | could paint Done | verdict `cancelled`, drain stopped, leftover steer preserved |
| failed run with queued work | continued, status text raced | `settled[0].phase = failed` + canonical error, then the queued work runs |
| IDLE | rendered whenever the turn body ended | only when `idleBlockers()` is empty |
| crashed run ending on a status event | `resume()` reported the stored status (looked finished) | `interrupted` + interruptedTools + "no tool is replayed automatically" |

## Tests

`src/core/session/__tests__/sessionLifecycle.test.ts` (13 tests, deterministic:
deferred promises and boundary barriers — **no sleeps, no timers, no provider**;
crash/resume uses the real `SessionStore` in a temp sessions dir):

| # | Scenario | Assertion |
|---|---|---|
| A | steer during provider stream | in-flight run untouched; exactly one request at a time; steer becomes the next run; continuation prompt is the steer text |
| B | steer during tool | promoted exactly once, after the tool phase (`steersPromoted === 1`) |
| C | steer exactly at completion | admitted inside `onSettle` → next run starts atomically, `idleCount() === 0` in between, IDLE reported once at the end |
| D | two rapid steers | both admitted as steers, one continuation, FIFO `["B","C"]`, source drained |
| E | cancel + steer | verdict `cancelled` (late success ignored), no auto-continuation, steer preserved and delivered by an explicit resume |
| F | provider failure + queued steer | `failed` recorded, steer then queue still run in order, nothing lost |
| G | crash before tool result | `interrupted`, call reported `started_without_completion`, no fabricated result, no automatic replay of the mutation, steer still pending |
| H | crash after tool result persisted | result replays exactly once, evidence recorded once, no interrupted call |
| I | resume | no duplicate user messages/tool results, promoted steer not pending, reconstruction idempotent |
| J | failure status | canonical error mapping + `failed` exactly once, never `done` |
| K | idle gate | every blocker enumerated; driver stays out of IDLE while blocked, reports IDLE once when cleared (`refreshIdle` idempotent) |
| L | compaction pending | `compaction` blocks IDLE until it finishes |

## Validation

| Gate | Result |
|---|---|
| `bun run typecheck` | PASS |
| `bun test` (full) | **3428 pass / 20 skip / 0 fail** (3448 tests, 293 files) |
| `bun run build` | PASS — bun `index.js` 2.82 MB, node `index.js` 2.94 MB |
| `npm pack --dry-run` | PASS — `toolnetcli-1.3.0.tgz`, 6 files |

Phase 5 baseline was 3415 pass / 20 skip (3435 tests, 292 files): +13 tests,
+1 file, zero failures, zero regressions (session architecture guards,
sessionSteer/queuedMessages regressions, canonical status, viewport render and
the whole Phase 3–5 suites all unchanged).

## Files changed

- `src/core/session/lifecycle.ts` (new) — `SessionRunDriver`, `idleBlockers`,
  `canSettleIdle`, `canonicalRunError`.
- `src/core/session/index.ts` — exports for the lifecycle module.
- `src/core/session/resume.ts` — terminal-event classification fix.
- `src/tui/events/agentWiring.ts` — removed both completion-boundary timers and
  the empty-prompt continuation; turn body extracted to `runForegroundTurn`;
  one terminal settle (`settleForegroundRun`) drives status done/failed/cancelled.
- `src/core/session/__tests__/sessionLifecycle.test.ts` (new) — A–L matrix.

## FINAL

Phase 6 complete.
One foreground request: PASS
Steer FIFO: PASS
Completion race: PASS
No empty prompt: PASS
Failure status: PASS
Idle invariant: PASS
Crash/resume: PASS
Tests: 3428 pass / 0 fail / 20 skip (3448 tests, 293 files); typecheck PASS; build PASS; `npm pack --dry-run` PASS.
