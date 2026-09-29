# Phase 0.2 — Assistant Fragment Reproduction

HEAD: 825cee8
Status: BUG REPRODUCED

Observed symptom:
When the model streams text, emits a tool call, and continues streaming text, the assistant response fragments into multiple UI messages instead of forming a single continuous conversational turn. 

Reproduction:
Scenario tested via deterministic TUI callbacks:
1. `onTextDelta("T")`
2. `onEvent({ type: "tool-call" })`
3. `onEvent({ type: "tool-result" })`
4. `onTextDelta("ôi sẽ kiểm tra xem...")`

Canonical state:
The `tuiState.messages` array becomes fragmented into two distinct assistant messages:
- `msg1` (role: assistant): `content = "T"`, `tool_calls = [call1]`
- `msg_tool` (role: tool): `content = "ok"`
- `msg2` (role: assistant): `content = "ôi sẽ kiểm tra xem..."`

Rendered result:
Because the identity is split, they cannot render as one block. Furthermore, `chatRenderer.ts` completely skips rendering the text content of `msg1` once `msg.tool_calls` is populated, so the user only sees "T" momentarily before the tool call arrives, or the renderer otherwise malfunctions, leading to visual fragmentation.

Message IDs:
- Before tool call: `msg1` is created as `activeAssistantDraft` (e.g. `assistant_123_1`).
- After tool call attachment: `msg1` retains its ID and receives the `tool_calls` array.
- After tool result: `completedToolCallTurnId` is set.
- Next text delta: `advanceTurnAfterTools()` increments `currentTurnId`, clears `currentAssistantMessageId`, and `openAssistantDraft()` creates a NEW message `msg2` (e.g. `assistant_123_2`).

Root cause candidate:
The boundary that cuts the message identity is `advanceTurnAfterTools()`. By incrementing `currentTurnId` and calling `resetAssistantTurnState()` upon receiving text *after* a tool completes, the TUI drops the active assistant message ID and opens a brand new draft for the remaining text of the same model generation turn.

Files involved:
- `src/tui/state.ts` (`advanceTurnAfterTools`, `appendAssistantDelta`, `attachToolCall`)
- `src/tui/renderers/chatRenderer.ts` (dropping text content when `tool_calls` exist)

Regression test:
Added `src/tui/__tests__/assistantToolInterleave.test.ts` to deterministically verify the fragmentation across the TUI callbacks, including multi-chunk variants and zero-text control cases.

Severity:
P2

Phase to fix:
Phase 2

Production behavior changed:
NO
