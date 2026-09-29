# Phase 1.1 — Fix Tool Result Correlation

Finding:
TN-R0-008

Root cause:
The `mergeTranscriptMessages` function in `src/tui/events/agentWiring.ts` used a fallback condition `engineMsgs[eIdx].role === currentMsg.role` when `matchIdx === -1`. This forcibly merged out-of-order tool results into whatever the next tool message in the engine API transcript was, replacing the `tool_call_id` and mixing contents. Additionally, `mergeTranscriptMessage` stripped critical UI properties like `durationMs` and `fileMutations`.

Fix:
1. Removed the blind `role === "tool"` fallback by enforcing `currentMsg.role !== "tool"` in the fallback branch.
2. Added a safe replacement block in the `else` branch: if an out-of-order tool was already pushed into `merged` during an earlier loop, it is safely looked up by `tool_call_id` and updated in place.
3. Updated `mergeTranscriptMessage` to use `{ ...currentMsg, ...engineMsg }` so that properties exclusive to the TUI (like `durationMs` and `fileMutations`) are fully preserved instead of dropped.

Invariant:
`tool_call_id` identity is now strictly preserved. Tools with different call IDs are never merged.

Out-of-order: PASS
Same tool name: PASS
Unknown callId: PASS
Duplicate: PASS
Cross-turn: PASS
Renderer: PASS

Regression:
All existing tests and tool correlation invariants hold.

Production behavior changed:
YES
