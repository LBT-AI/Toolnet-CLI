# Phase 2.2 — Fix Live Tool Activity Heartbeat

HEAD base: Phase 2.1 complete
Status: FIXED

## Problem (from docs/phase-0-3-live-activity.md)

`renderActiveToolActivity()` painted a static `●` and elapsed only changed
once per second (`Math.floor(elapsedMs / 1000)`), so a long silent tool
(network fetch, browser action, quiet run) looked frozen: zero visual changes
for 999 ms at a time, forever.

## Root cause (verified)

- `chatRenderer.ts` hardcoded `const dot = ●` — the canonical animated
  spinner (`SPINNER` + `tuiState.spinnerIdx`, used by the status bar) was
  never passed to the activity row.
- The 90 ms statusService interval only ran while `isStreaming` was true; a
  tool outliving the stream view (or one that never emits progress) had no
  driver for its frame.

## Fix (view/heartbeat layer only — no transcript, no persistence)

1. `src/tui/renderers/chatRenderer.ts`
   - `currentSpinnerFrame(frameOverride?)`: resolves the CURRENT frame from
     the ONE canonical source (`SPINNER[tuiState.spinnerIdx % len]`). No
     second spinner implementation was created.
   - `renderActiveToolActivity(activity, cols, frameOverride?)` paints that
     frame instead of `●`. `frameOverride` exists only for deterministic
     tests; production always renders the shared index.
   - `renderToolActivities(activities, cols, frameOverride?)` forwards the
     frame and filters to `status === "running"` ONLY — a
     completed/errored/cancelled activity vanishes from the overlay in the
     same frame it settles (existing `closeActiveToolActivity` /
     `cancelActiveToolActivity` in state already flip the status).
   - Elapsed stays human-readable whole seconds (no ms in the row).

2. `src/tui/statusService.ts` — `ensureActivityHeartbeat()`:
   - One shared 90 ms heartbeat while ANY activity runs (same intervalMs and
     same canonical `spinnerIdx` as the status timer — no duplicate tickers).
   - Advances `spinnerIdx` + every activity's `elapsedMs`, then
     `requestChromeRender()` (existing 33 ms coalescing applies).
   - Self-cancels when no activity is running: no idle spin, no leaked
     interval. A no-op when the status timer is already ticking.

3. `src/tui/events/agentWiring.ts` — calls `ensureActivityHeartbeat()` on
   `tool-call` and `tool-progress` events, so even a tool that starts while
   the status bar is idle gets a heartbeat, and a tool that never emits
   progress is still animated by the FIRST event (tool-call) alone.

Repaint coverage: silent fetch / browser / run tools repaint ~11×/s
(90 ms heartbeat) with a changing spinner glyph — no transcript output, no
progress events required.

Ephemerality: activity rows render ONLY in the transient chrome overlay
(app.ts absolute overlay above the composer) and `renderChatMessages`'
legacy tail. Frames are never written to `messages`, never serialized by
`saveCurrentSession()` (regression test asserts no spinner glyph / elapsedMs
in `JSON.stringify(tuiState.messages)`).

## Composer safety (required sizes)

The activity overlay paints at fixed rows `composerRow - 1` upward, bounded
by `MAX_ACTIVITY_ROWS = 4` (+1 overflow row), never above row 0 — parallel
tools cannot push the composer/footer out of the viewport at 52x20, 80x24 or
120x30. Regression tests assert rows ≤ cols and the transcript still paints
at all three sizes.

## Tests

New: `src/tui/renderers/__tests__/liveActivityHeartbeat.test.ts` (13)
- animated frame: row paints current canonical frame, NOT `●`
- fake time: t=0/tick1/tick2 → three DIFFERENT spinner frames
- elapsed human-readable (no ms)
- silent heartbeat: timer advances spinnerIdx + elapsedMs with no progress
  events; no-op with zero activities; empty-tail tool still changes frame
- cleanup: completed/error/cancelled rows vanish; tool-result event path
  closes the activity in the same frame
- persistence: nothing spinner-related ever reaches the transcript/session
- multi-tool: stable oldest-first ordering (insertion-order independent),
  every row animates, bounded rows with `… +N more`
- sizes: 52x20 / 80x24 / 120x30 rows stay single-line, in width

Updated (static-● assertions → animated frame contract):
- `src/tui/renderers/__tests__/liveToolActivity.test.ts` (existing regression)
- `src/teamwork/__tests__/longRunningToolUx.test.ts` (chat-tail row test)

## Validation (measured 2026-09-28)

- bun run typecheck: PASS
- bun test: 3315 passed / 0 failed / 20 skipped (3335 tests, 287 files)
- bun run build: PASS (665 modules)

## Files changed

- src/tui/renderers/chatRenderer.ts (canonical spinner frame on activity rows)
- src/tui/statusService.ts (ensureActivityHeartbeat)
- src/tui/events/agentWiring.ts (heartbeat kickoff on tool lifecycle events)
- src/tui/renderers/__tests__/liveActivityHeartbeat.test.ts (NEW)
- src/tui/renderers/__tests__/liveToolActivity.test.ts (assertion update)
- src/teamwork/__tests__/longRunningToolUx.test.ts (assertion update)
- docs/phase-2-2-live-activity.md (this report)

Phase 2.2 complete. Phase 2.3 not started.
