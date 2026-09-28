# Production Readiness Audit

## TN-P0-001: Failure Overwritten as Done
- **Severity**: P0
- **Area**: Agent lifecycle (TUI)
- **Root cause**: In `src/tui/events/agentWiring.ts`, after checking `!result.success` and calling `statusManager.failed()`, execution continued unconditionally to `tuiState.agentPhase = "done"` and `statusManager.done()`. This masked actual runtime failures as successful completions.
- **Reproduction**: Run a command that fails, observe the UI transitions from "Error/Failed" to "Done".
- **Risk**: FAILED turns falsely report success. User assumes operation was safe/complete when it failed, leading to data loss or confusion.
- **Fix**: Wrapped the `done` state transition in the `else` branch of `if (!result.success)` and updated `tuiState.agentPhase = "error"` to preserve the error state.
- **Regression test**: N/A (tested via suite stability).
- **Status**: Fixed

## TN-P0-002: Canonical Errors Reaching TUI
- **Severity**: P0
- **Area**: Error propagation (Event layer)
- **Root cause**: The `AgentEvent` type supports a `{ type: "error" }` event, but `buildTuiAgentCallbacks` in `agentWiring.ts` lacked a `case "error"` block to consume it, causing engine-level errors to be dropped silently by the TUI.
- **Reproduction**: Trigger an engine-level error event; notice the UI ignores it and may hang or drop into an incorrect state.
- **Risk**: Agent can be left in an unresponsive state if it errors during processing, since the UI ignores the event and waits indefinitely.
- **Fix**: Added `case "error"` in `onEvent` of `buildTuiAgentCallbacks` to appropriately finalize reasoning, set `agentPhase = "error"`, and call `statusManager.failed(event.error)`.
- **Regression test**: N/A (tested via suite stability).
- **Status**: Fixed

## TN-P1-003: Shell Redirect Parser False Positive (`2>/dev/null`)
- **Severity**: P1
- **Area**: Permissions/Security
- **Root cause**: `tokenizeShell` in `src/lib/security/shellParser.ts` parsed `2>/dev/null` incorrectly by treating `2` as a separate argument rather than part of the redirection operator `2>`. This led the `SecurityEngine` to falsely classify harmless redirected commands as system mutations.
- **Reproduction**: Run `ls 2>/dev/null`.
- **Risk**: Legitimate commands are denied by default, causing poor UX and "false permission deny" bugs.
- **Fix**: Modified `tokenizeShell` and `parseShellCommand` to properly recognize `2>`, `1>`, `2>>`, `1>>`, `2>&1`, `&>`, and `>&` as monolithic stream redirection operators.
- **Regression test**: Included in `bun test src/lib/security/`.
- **Status**: Fixed

## TN-P0-004: Final-boundary Steer Race
- **Severity**: P0
- **Area**: Agent lifecycle (Queue/Steering)
- **Root cause**: `AgentHarness` checks `pendingInputs` at the very end of its loop. If a steer arrives between that check and the completion of `sendMessage` in the TUI, the turn ends, `agentPhase` becomes `done`, and the steer sits orphaned in `pendingInputs`.
- **Reproduction**: Submit a follow-up ("steer") at the exact millisecond the agent completes its response.
- **Risk**: User prompts are silently dropped/nuốt. The user thinks the agent is processing the instruction, but the agent is idle.
- **Fix**: Added a final boundary check inside `sendMessage` right before marking the turn as complete. If `pendingInputs.count()` is > 0, it restarts `sendMessage` with a continuation flag to flush the queued follow-up without wiping the phase.
- **Regression test**: Covered via E2E lifecycle tests.
- **Status**: Fixed
