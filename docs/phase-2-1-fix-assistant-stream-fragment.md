# Phase 2.1 — Fix Assistant Text Fragmentation

HEAD base: 825cee8 (Phase 1 closed via Phase 1.6.1)
Status: FIXED
Prerequisite check: Phase 1 CLOSED (typecheck PASS, 3294/0/20, build PASS, npm pack PASS — see docs/phase-1-6-tool-execution-acceptance.md)

## Problem (from docs/phase-0-2-assistant-fragment.md)

Stream shape `text → tool-call → tool-result → text` fragmented into two
visually unrelated assistant messages, and the pre-tool text ("T") disappeared
from the transcript because `chatRenderer.ts` dropped `msg.content` entirely
whenever `tool_calls` was present. `advanceTurnAfterTools()` cut the assistant
draft identity with no link left between the pre-tool segment and the
post-tool synthesis.

## Trace (verified, not assumed)

```
provider delta
  → harness emitEvent("agent:stream_chunk")
  → toAgentEvents → { type: "text-delta" }
  → onTextDelta (agentWiring)
  → tuiState.appendAssistantDelta          → draft/msg1 (content "T")
  → tool-call event
  → tuiState.attachToolCall                → msg1 gains tool_calls; draft finalized
  → tool:complete → tool-result event      → tool message appended
  → next text-delta
  → advanceTurnAfterTools() bumps currentTurnId, resets draft state
  → appendAssistantDelta opens a NEW msg2  → transcript shows two loose fragments
  → chatRenderer: msg1.tool_calls set ⇒ msg1.content ("T") never painted
```

Key finding: the engine (agentHarness) already emits the CORRECT wire shape —
one assistant message per provider turn (gen1: pre-tool text + tool_calls,
gen2: synthesis), preserving assistant → tool → assistant order. The
fragmentation was a VIEW-layer defect: no semantic identity linking the
segments, plus the renderer dropping pre-tool text. The transcript wire shape
was therefore NOT changed.

## Fix (view/state layer only — production conversation semantics unchanged)

1. `src/tui/state.ts` — semantic response identity:
   - New `responseKey` on `AssistantDraft` and on every assistant `Msg`.
   - `ensureResponseKey()` assigns one key per model response; assigned on the
     first assistant segment and reused by every later segment of the same
     response (pre-tool text, tool-carrying segment, post-tool synthesis).
   - `advanceTurnAfterTools()` still bumps `currentTurnId` (reasoning
     correlation stays correct) but NO LONGER destroys response identity.
   - Key closes only on hard boundaries: `startNewRun()` or a real user/system
     message (`appendMessage` → `opensNewResponse`). Tool results, reasoning
     blocks and engine-driven messages never close it.
   - `attachToolCall()` stamps the tool-carrying segment with the active key
     (covers tool-only responses with no pre-tool text).
   - `replaceMessages()` backfills one key per contiguous assistant block for
     sessions saved before this change (resume/compaction safe).

2. `src/tui/renderers/chatRenderer.ts`:
   - Assistant messages with `tool_calls` now render `msg.content` FIRST
     (streaming caret included) before the tool-start rows. The pre-tool text
     no longer vanishes.
   - `prefix`/`prefixIndent`/`msgBg`/`wrapWidth` hoisted to the top of the
     message loop so every branch paints identical chrome.

3. `src/tui/events/agentWiring.ts` (transcript adoption `syncTranscript…`):
   - `transcriptMessagesCompatible()`: a shared `responseKey` is a HARD
     boundary — segments join only within one key; different/missing keys fall
     back to the tool-call-id heuristic. Cross-turn assistant messages can
     never merge (required test F).
   - `mergeAssistantContent()`: for two segments of ONE response, engine
     synthesis is APPENDED to the TUI text (`current + engine`) instead of the
     old prefix-containment heuristic that silently dropped text.
   - `mergeTranscriptMessage()`: tool_calls only merge across segments when
     both sides belong to the same responseKey; otherwise each side keeps its
     own — a next-turn assistant never inherits the previous turn's tool rows.

Wire safety: `sendMessage()` builds `apiMessages` as an explicit projection
(role/content/tool_calls/tool_call_id/name only), so `responseKey` never
reaches the provider payload; the harness builds its own transcript
independently. No provider-visible change.

## Required tests — all PASS (`src/tui/__tests__/assistantResponseIdentity.test.ts`)

| Test | Scenario | Result |
|------|----------|--------|
| A | "T" → tool → "ôi sẽ kiểm tra..." | PASS — 2 wire segments, ONE responseKey, renderer paints both texts, no orphan fragment |
| B | "Tôi " + "đang " → tool → "kiểm tra..." | PASS — gen1 content accumulates to "Tôi đang ", same identity |
| C | tool-only response | PASS — tool segment has content "" and shares the key; renderer paints no empty ✦ bubble |
| D | multiple tool calls | PASS — both calls attach to one segment, no extra fragment |
| E | tool failure mid-stream (`tool-error`) | PASS — text identity preserved across the failure |
| F | next user turn | PASS — user message closes the key; next assistant text gets a NEW responseKey; adoption test proves cross-turn messages never merge |
| + | transcript adoption (same key joins, different keys never merge; wire segmentation preserved) | PASS |
| + | `replaceMessages` backfill per contiguous assistant block | PASS |

## Phase 1 regression (callId / exactly-once settlement)

`src/core/__tests__/toolExecutionLifecycle.test.ts` + the touched TUI suites:
92 pass / 0 fail. Integration matrix unaffected (engine path untouched).

## Validation (measured 2026-09-28)

- bun run typecheck: PASS
- bun test: 3302 passed / 0 failed / 20 skipped (3322 tests, 286 files)
- bun run build: PASS (665 modules)

## Scope guards respected

- Spinner: untouched.
- maxTurns: untouched.
- Security/permission: untouched.
- Engine/harness transcript shape: untouched (assistant → tool → assistant order preserved for replay).

## Files changed

- src/tui/state.ts (responseKey identity, boundary rules, backfill)
- src/tui/renderers/chatRenderer.ts (pre-tool text rendering, hoisted chrome)
- src/tui/events/agentWiring.ts (merge/boundary semantics via responseKey)
- src/tui/__tests__/assistantResponseIdentity.test.ts (NEW — tests A–F + adoption + backfill)
- src/lib/__tests__/markdownTranscript.test.ts (AssistantDraft literal gains required responseKey field)
- docs/phase-2-1-fix-assistant-stream-fragment.md (this report)

Phase 2.1 complete. Phase 2.2 not started.
