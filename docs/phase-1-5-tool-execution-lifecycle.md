# Phase 1.5 — Tool Execution Lifecycle

Invariant:
Every accepted callId settles exactly once. For each unique callId in a batch,
`terminalResultCount(callId) === 1`. That means one provider-facing tool message
and one terminal AgentEvent (`tool-result` | `tool-error`).

## Canonical path

```
provider tool_calls (adapter)
→ AgentHarness.executeLoopInner          src/lib/harness/agentHarness.ts
→ executeToolBatch                       src/lib/harness/toolExecutor.ts   ← settlement point
    → runTool (harness closure)          preflight → dispatchTool → approval → verify
        → AgentHarness.dispatchTool      scope gate → ToolGateway
            → ToolGateway.execute        src/lib/security/toolGateway.ts (SecurityEngine, hooks, cache)
                → _executeToolRaw        src/lib/agentTools.ts → tool implementation
→ onMessage → messages.push({role:"tool", tool_call_id})   (transcript, provider-facing)
→ HarnessEvent tool:complete | tool:error
→ toAgentEvents                          src/core/agent/agentEngine.ts → tool-result | tool-error
→ buildTuiAgentCallbacks                 src/tui/events/agentWiring.ts (activity open/close)
```

## Lifecycle

The code has no explicit state enum, and none was added. The states are implicit:

RECEIVED (tool_call parsed) → PREFLIGHT (dup-id check, classification, unknown-tool / schema check,
scope + security + approval gate) → RUNNING (`executedCount++`, abort listener registered) → terminal.

Terminal outcomes and their `structuredError.code`:

| Outcome | Code |
|---|---|
| success | — (exitCode 0) |
| tool failure | EXECUTION_FAILED (or tool-specific: NOT_FOUND, HTTP_ERROR, …) |
| unexpected throw | INTERNAL_ERROR |
| unknown tool | TOOL_UNAVAILABLE |
| invalid args | INVALID_INPUT |
| approval needed, no front-end | PERMISSION_REQUIRED |
| user denied / scope denied | PERMISSION_DENIED |
| security hard deny | SECURITY_DENIED / OUTSIDE_WORKSPACE |
| cancel | CANCELLED |
| run timeout | TIMEOUT |

Lifecycle state is never derived from message strings. The executor reads the
typed `AbortSignal.reason` (`TimeoutError` DOMException ⇒ TIMEOUT). All results
carry the Phase 1.4 `structuredError`.

## Settlement guard

Two small guards, both scoped to one batch (one assistant turn, one run). Neither is process-global.

1. **Executor (`settleOnce`)**, per started call: runTool resolving, runTool rejecting
   (sync or async), and the abort signal race, and the first to arrive wins. The winner removes the
   abort listener (active registration → 0). A later contender goes to
   `onLateCompletion` (logged as `tool.late_completion_ignored`) and is otherwise
   ignored. When the executor itself settles a started call (abort or throw), it
   calls `onForcedSettle` so the owner can close that call's activity.
2. **Harness (`emitTerminal`)**, per callId: every `tool:complete` / `tool:error` for a
   call goes through one function backed by a batch-local `Set`. A second
   terminal event is dropped and logged (`tool.duplicate_settlement`).

Duplicate callId: the executor drops any later tool_call that reuses an id seen earlier in the
same batch. That call does not execute and gets no second answer. It is reported in
`duplicateCallIds` and logged as `tool.duplicate_call_id`, and the first occurrence keeps its
result. The same id in a different turn or run does not collide, because providers may reuse ids across turns.

## Defects found and fixed

| # | Defect | Fix |
|---|---|---|
| 1 | `runTool` throw rejected the whole `executeToolBatch`. Every call in the batch was orphaned (no transcript answer), `tool:start` never closed, and the run crashed. | Executor converts it to one INTERNAL_ERROR result; siblings unaffected |
| 2 | Cancel while running: executor waited for the tool, and a late success became the result and emitted `tool:complete`. | Abort wins the race and settles CANCELLED/TIMEOUT. The late result is ignored and its terminal event suppressed |
| 3 | Approval required with no front-end, and user deny: `tool:start` emitted but no terminal event (stale active tool) | One `tool:error` terminal on both paths |
| 4 | Scope deny: `dispatchTool` emitted an id-less `tool:error` (TUI callId = tool name) plus the id-bearing one, so two terminal events and a bogus TUI row. No structured error. | Id-less emit removed. PERMISSION_DENIED added |
| 5 | Gateway executor-throw path returned `allowed:false` with no typed error, and the harness labelled it SECURITY_DENIED | Gateway returns INTERNAL_ERROR; harness keeps a typed gateway error |
| 6 | Malformed args (`read_file {path: 123}`) threw inside the SecurityEngine, in both the `needsApproval` classifier and the gateway, so the batch was orphaned and the run crashed | Classifier fails closed (sequential path). Harness preflight returns INVALID_INPUT before any gate or implementation runs |
| 7 | Unknown tool name reached the security engine as an "external MCP tool" and came back SECURITY_DENIED | Preflight: not registered and not exposed this turn → TOOL_UNAVAILABLE |
| 8 | Same callId twice in one turn executed twice and produced two transcript messages with that id | First occurrence only |

## Emission audit (item 24)

- The transcript tool message is written in exactly one place: the executor `onMessage` → `messages.push`, once per unique id.
- `tool:complete` / `tool:error` with an id: only in the harness `runTool` and `onForcedSettle`, both routed through `emitTerminal`.
- There is one mapping layer, `toAgentEvents`: `tool:complete`→`tool-result`, `tool:error`→`tool-error`.
- The TUI already ignores a late `tool-result` or `tool-error` for a callId it marked cancelled. This was unchanged, and spinner visuals were not touched.

## Fake-success audit (item 25)

Late success after cancel was reported as success; fixed (#2). The executor throw was
mislabelled as a security denial; fixed (#5). No `catch → success:true` path was found.
The raw non-JSON tool stdout wrapper (`exitCode: 0`) is genuine tool output and was left alone. Deny paths
return typed failures and never synthesize normal output.

## Policies documented (not changed)

- Parallel failure isolation: when B fails, A and C still complete. There is no group cancellation.
- Cancellation is run-wide only (one combined signal: user abort, loop abort, run timeout). There is no per-call cancel API, and the tests cover run-wide semantics.
- A cancelled underlying operation keeps its own signal and may finish in the background, but its result is discarded.
- The web_fetch internal retries (Phase 1.3) stay inside one `runTool` invocation, so they produce one terminal result.

## Results

Success:
PASS

Failure:
PASS

Internal throw:
PASS

Permission approve:
PASS

Permission deny:
PASS

Security deny:
PASS

Unavailable:
PASS

Cancellation:
PASS

Late completion:
PASS

Duplicate settlement:
PASS

Duplicate callId:
PASS

Parallel out-of-order:
PASS

Active cleanup:
PASS

CallId regression:
PASS (`toolCallResultCorrelation`, `assistantToolInterleave`; parallel stays concurrent, with no serialization)

Structured errors:
PASS (`toolErrorContract` unchanged and passing)

Browser regression:
PASS (`browserAvailability`, `agentHarnessBrowserSchema`, `browserTool`)

web_fetch regression:
PASS (`webFetchTimeout`, `safeFetch`, plus a new production-path test: 503→200 retry gives one terminal result)

## Tests

`src/core/__tests__/toolExecutionLifecycle.test.ts` has 36 tests. It replaces an earlier draft that asserted a throw escapes.

- Executor layer: A, B, C (+ sync throw), H, I, J (both orders), K, L, M (+ run-scope), P (deferred B→C→A),
  Q, run-wide cancel, classifier throw. Each asserts one message per id and that live abort listeners return to 0.
- Production layer: a stubbed provider `fetch` drives the real adapter → AgentHarness → ToolGateway → executor →
  HarnessEvent → AgentEvent → transcript. It covers success (including the follow-up provider request carrying exactly
  one tool result), parallel, unknown tool, invalid input, real-gateway security deny (with an execution counter),
  approve, deny, and no approval front-end. It also covers dispatch throw, cancel + late success, duplicate id,
  web_fetch retry, and mixed activity cleanup.
- Races use deferred promises and a `setImmediate` flush barrier. There are no sleeps and no timeout changes.

Updated: `src/teamwork/__tests__/abortAndOAuthRegression.test.ts`. The in-flight call that triggers the abort now
settles CANCELLED instead of reporting its late "ok" (3 cancelled instead of 2). Unstarted calls still never execute.

## Full validation

- Typecheck: PASS (`tsc --noEmit`, exit 0)
- Tests: 3294 pass / 0 fail / 20 skip (3314 tests, 285 files)
- Build: PASS

The suite was run with `CLAUDECODE` unset. When Bun runs under that variable it prints condensed output, and
`lspGoldenE2E` asserts on the output of a spawned `bun test`. That makes the test fail for environmental reasons
unrelated to this phase; it passes once the variable is unset.

## Files changed (this phase)

- `src/lib/harness/toolExecutor.ts`: settlement guard, abort/timeout race, throw → INTERNAL_ERROR, duplicate-callId handling, classifier fail-closed, `validateToolInput`
- `src/lib/harness/agentHarness.ts`: `emitTerminal` guard, preflight (TOOL_UNAVAILABLE / INVALID_INPUT), approval-path terminals, forced-settle hook, scope-deny cleanup
- `src/lib/security/toolGateway.ts`: executor-throw result carries INTERNAL_ERROR (no policy change)
- `src/core/__tests__/toolExecutionLifecycle.test.ts`: new/replaced
- `src/teamwork/__tests__/abortAndOAuthRegression.test.ts`: in-flight cancel expectation

Not touched: security policy, maxTurns, streaming, spinner, assistant fragment, recovery logic.

Production behavior changed:
YES
