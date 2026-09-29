# Phase 0.8 — Tool Result Correlation

HEAD: 825cee8
Status: BUG REPRODUCED

## Primary out-of-order test

Calls:
A: get_cwd (call-cwd)
B: browser (call-browser)
C: read_file (call-file)

Completion order:
TUI observed locally: B then A. (C is missing/pending).
Engine API: A, B, C (strictly preserves original `tool_calls` order).

Canonical mapping (Engine):
A -> "/root"
B -> "Playwright error"
C -> "File content"

Transcript mapping (After reconciliation):
Index 0: call-cwd -> "/root"
Index 1: call-browser -> "Playwright error"
Index 2: call-cwd (Duplicated ID from TUI) -> "File content" (Stolen from Engine's C!)

Rendered mapping:
The renderer iterates through all tool messages. At Index 2, it sees `tool_call_id: call-cwd`, looks up the name `get_cwd`, and renders `✓ GetCwd` followed by `File content`. This perfectly matches the observed symptom where `GetCwd` rendered a `Playwright error` (if C had been the browser tool).

Finding:
REPRODUCED

## Same tool name test

PASS. When multiple tools share the same name (e.g., `read_file` on `a.txt` and `b.txt`), an out-of-order completion triggers the same blind fallback, causing content swapping or duplication.

## 3-tool test

PASS. A third tool completing in the engine while the TUI is out-of-order forces the reconciliation fallback to merge the TUI's remaining tool message with the engine's 3rd tool message, corrupting the `tool_call_id` invariant.

## Reconciliation test

PASS. The bug is exclusively isolated to `syncTranscriptPreservingReasoning`.

## Duplicate result

PASS. If the TUI has duplicate results, the reconciliation merges the first and blindly pushes/merges the second, causing transcript bloat.

## Unknown callId

PASS. An `UNKNOWN` callId in the TUI forcefully merges with a valid `KNOWN` callId in the engine if they align in the fallback loop, polluting the canonical state.

## Cross-turn delayed result

PASS. Delayed results crossing into the next turn suffer the same fate because `syncTranscriptPreservingReasoning` operates on the full transcript array and applies the same blind `role === "tool"` fallback.

## Root cause layer

Agent event: CORRECT (Emits correct out-of-order events).
State: CORRECT (Appends what it receives).
Reconciliation: BUG (The `mergeTranscriptMessages` function uses `engineMsgs[eIdx].role === currentMsg.role` as a fallback when `matchIdx === -1`. This forcefully merges two entirely different tool results just because both have `role: "tool"`, completely ignoring the `tool_call_id`).
Renderer: CORRECT (Faithfully renders the corrupted transcript).

## Invariant

`tool_call_id` identity MUST be strictly preserved. A tool result must NEVER be merged with another tool result if their `tool_call_id`s differ.

Severity:
P0 (Transcript corruption causes hallucinated UI state and feeds incorrect tool outputs back into the model's context window).

Production behavior changed:
NO
