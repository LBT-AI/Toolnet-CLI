# Phase 2.3 — Streaming / Message Identity Hardening

HEAD base: `825cee8c617599e31f8db5d8845852e5c615515c` + Phase 2.1/2.2 fixes
Status: HARDENED (audit + targeted fix; no TUI redesign)

## Scope

Audit the full assistant streaming path after 2.1/2.2 and harden the one real
gap found. No renderer redesign, no persistence format change, no
provider-protocol change.

## Audit result (verified by reading the code)

Already correct — pinned by tests, not changed:

- **One identity while streaming.** `appendAssistantDelta()` reuses the draft
  created by the first delta (`openAssistantDraft` returns the same
  `activeAssistantDraft` for the same `runId`/`turnId`), so every delta of one
  logical response appends to ONE message id with ONE `responseKey`
  (Phase 2.1 infra). A new id is created only after a real turn boundary.
- **UTF-8 / multi-byte boundaries.** All four provider stream readers
  (`openaiCompatible.ts` ~293, `anthropic.ts` ~317, `gemini.ts` ~329,
  `toolnet.ts` ~270) use `new TextDecoder()` +
  `decoder.decode(value, { stream: true })` and hold back the trailing
  partial line (`buffer = lines.pop()`), so multi-byte code points split at
  chunk boundaries reassemble before the TUI ever sees them. The TUI
  concatenates already-decoded strings — no re-encoding anywhere.
- **No duplicate append path.** The engine fans `agent:stream_chunk` out to
  BOTH `options.onTextDelta` and the `text-delta` normalized event, but the
  TUI's `onEvent` switch has no `text-delta` case — exactly one consumer per
  chunk. Reasoning likewise has exactly ONE live path (`onEvent` →
  reasoning-start/delta/end); the legacy `onReasoningDelta` is deliberately
  unwired (Phase 2.1 regression test pins this).
- **No partial render.** Renderers paint committed message content;
  a provider chunk split mid-code-point is reassembled at the provider layer
  before `onTextDelta` fires, so the frame can never show `\uFFFD`.
- **No double finalize.** `finalizeAssistantDraft` returns null when no draft
  is active; `finalizeActiveReasoning` clears the draft first and appends the
  transcript block exactly once (empty drafts are closed but not recorded).
- **Role separation.** Reasoning is appended as `role: "reasoning"` messages
  and never merged into assistant content; `appendReasoningDelta` already
  drops deltas whose sessionId/runId/turnId do not match the active run.

## The one real gap → fixed

`buildTuiAgentCallbacks()` (`src/tui/events/agentWiring.ts`) had NO
terminal-state guard: after `cancelled` / `error` / `agent-complete`, an
in-flight `onTextDelta` still called `appendAssistantDelta` — a late chunk
racing the abort could append text to a finished/cancelled turn.

Fix (single closure-local guard, no production behavior change before the
terminal event):

1. `settled` flag + `terminalPhase` (`"done" | "error" | "cancelled" | null`)
   per callbacks set:
   - `onTextDelta` drops deltas once settled.
   - `reasoning-start` / `reasoning-delta` drop events once settled.
   - `cancelled` / `error` / `agent-complete` set `settled` + `terminalPhase`
     on the FIRST terminal event and are idempotent: a duplicate terminal
     event re-runs nothing (no duplicated cancelled tool rows, no double
     finalize, no second `statusManager.failed` paint).
2. `agent-complete` arriving after `error`/`cancelled` is ignored — the
   terminal phase can never be flipped to a fake DONE.
3. Terminal events also `toolNames.clear()` so a stale staged tool name can
   never leak into a later response.

Production builds a fresh callbacks set per run (`agentEngine.run` inside
`sendMessage`), so the guard scopes exactly to one run's in-flight events.
Wire format, persistence format, renderer layout: unchanged.

## Tests (all deterministic — fake data, fake time, no real provider, no timers)

New `src/tui/__tests__/streamingHardening.test.ts` (18 tests):

- A1/A2: many tiny deltas → exact string, ONE stable message id + ONE
  responseKey, no duplicate text anywhere in the transcript.
- A3: duplicate `agent-complete` → finalize once, no duplicate.
- B1: Vietnamese + emoji with the 🇻🇳 surrogate pair SPLIT across deltas →
  exact reassembly, no `\uFFFD`, rendered frame contains the full text.
- B2: pins the provider decoder contract — a UTF-8 byte stream split at EVERY
  single byte (`decode(bytes, { stream: true })`) reassembles
  "Tiếng Việt 🇻🇳👌 — nhật ký 🧑‍🚀" exactly.
- B3: no lost prefix — content starts with the first delta, ends with the last.
- C1: reasoning → text keeps roles separate in both directions.
- C2: reasoning block recorded exactly once across text-delta finalize +
  later agent-complete.
- C3: cancel mid-reasoning records the partial block once; a late
  reasoning-delta cannot resurrect the draft.
- D1: text → tool → text: wire order kept, one responseKey.
- D2: tool → text with no pre-tool text: no orphan empty bubble.
- D3: multiple tools: 2 calls + 2 results, one responseKey, no duplicate rows.
- E1: provider error mid-stream → received content preserved VERBATIM, phase
  `error` (not done), late delta dropped.
- E2: `agent-complete` after error never fakes DONE.
- F1: cancel mid-stream → NO late delta appended.
- F2: `agent-complete` after cancel keeps phase `cancelled`.
- F3: duplicate `cancelled` events idempotent — exactly one cancelled tool row.
- G1: `JSON.stringify(tuiState.messages)` contains no spinner frames, no
  `spinnerIdx`/`activeAssistantDraft`/`activeReasoningDraft`/`toolActivities`,
  no `"streaming":true`, no duplicate draft content; reasoning stays a
  separate role in the persisted transcript.

Adapted `src/tui/__tests__/assistantResponseIdentity.test.ts` test F: it
previously reused one callbacks object across two simulated runs; production
builds a fresh set per run (and Phase 2.3 settles that set at its terminal
event), so the second turn now uses its own `callbacks()` — matching
`sendMessage` exactly. The asserted invariant (new user turn → NEW
responseKey) is unchanged.

## Validation

- `bun run typecheck` → PASS (tsc --noEmit, clean)
- `bun test` → **3333 pass / 0 fail / 20 skip** (3353 tests, 288 files)
- `bun run build` → PASS (bun build, 665 modules, index.js 2.89 MB)

## Verdict

- Stable message identity: PASS — one id + one responseKey per logical
  response across any number of deltas and tool segments.
- UTF-8: PASS — provider-level streaming decode; surrogate/multi-byte splits
  reassemble exactly; no corruption rendered.
- Tool interleave: PASS — text→tool→text, tool→text, multi-tool all keep wire
  order, one semantic key, no duplicates, no orphans.
- Error mid-stream: PASS — content preserved verbatim, terminal ERROR, no
  fake DONE, late deltas dropped.
- Cancel: PASS — no late delta appended after cancellation; duplicate
  terminal events idempotent.
