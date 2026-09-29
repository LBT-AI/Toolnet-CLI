# Phase 0.4 — maxTurns Reproduction

HEAD: 825cee8
Status: BUG REPRODUCED

Production default:
The default maxTurns in `agentHarness.ts` and `resolveMaxTurns` fallback is 10. The `default` profile defines no specific maxTurns, so it inherits this fallback 10 (unless explicitly passed via CLI options, e.g. for `runSubagent` where it passes 8, or `runTurbo` where it passes 5).

Resolution precedence:
`resolveMaxTurns` checks sequentially:
1. `optionMaxTurns`
2. `profileMaxTurns`
3. `configMaxTurns`
4. `fallback` (10)

Definition of one turn:
In `agentHarness.ts`, the loop is `while (turnsUsed < maxTurns)`. One turn represents exactly one completion request to the provider model. A tool call execution occurs *within* that turn's iteration, and the loop continues, adding +1 to `turnsUsed` for the next provider request.

Reproduction:
Simulated 10 consecutive turns where the agent makes unique tool calls (e.g., `shell("echo 1")` to `shell("echo 10")`). Because each turn executed a new tool, the progress tracker recognized it as forward progress (`next.toolCalls > previous.toolCalls`). 
However, at exactly turn 10, the loop condition `turnsUsed < maxTurns` triggers a hard exit, returning `Exceeded maximum turn count (10)` before the task finishes. 

Progress evidence:
The `ProgressTracker` specifically counts `toolCalls`, `mutations`, `commands`, `diagnostics`, `newFiles`, and checks if `responseFingerprint` changed. Any increase in these cumulative counters is explicitly considered `progressed: true`. Since the simulated agent issued a novel tool call each turn, `progressed: true` was correctly satisfied every turn.

Final result:
success: false
turnsUsed: 10
toolCallsCount: 10
error: "Exceeded maximum turn count (10)"

Why this is not no-progress:
The `repeated-tool` guard and `no-progress` guard never trigger because the tool arguments and fingerprints are genuinely unique across the turns. The failure is purely due to the fixed hard cap.

Failed-tool turn cost:
A failed tool call *does* consume a turn budget. The provider emits the tool call (costing 1 turn), the executor runs it and returns an error, and the next loop iteration (the recovery turn) costs another turn. Therefore, complex recoveries rapidly exhaust the fixed budget of 10.

Profiles:
- default: undefined (uses fallback 10)
- minimal: 6
- reasoning: 16
- turbo: undefined (overridden in runtime options to 5)
- subagent: undefined (overridden in runtime options to 8)

Root cause candidate:
The harness enforces a hard, absolute ceiling of 10 loops (`while (turnsUsed < maxTurns)`) regardless of whether the agent is actually stuck in a loop or making legitimate, verified progress on a complex task.

Regression test:
Added `src/core/harness/__tests__/maxTurnsProgress.test.ts` to deterministically verify that a 10-step progressing agent fails, while an infinite loop is correctly caught by guards *before* max turns.

Severity:
P1

Phase to fix:
Phase 3

Production behavior changed:
NO
