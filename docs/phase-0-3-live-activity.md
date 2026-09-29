# Phase 0.3 — Live Activity Reproduction

HEAD: 825cee8
Status: BUG REPRODUCED

Observed production symptom:
When a tool runs, especially a long-running silent one like a network fetch, the UI activity line looks completely frozen. The user sees `● Fetch https://example.com · 16s`, but because the marker is static and the elapsed time only updates once a second, it feels like the UI is hung.

Current marker:
The marker in `renderActiveToolActivity` is explicitly static: `const dot = \`\${A.fgInfo}●\${A.reset}\`;`

Spinner source:
The global status bar (`renderWorkingStatus`) uses an animated spinner: `SPINNER[state.spinnerIdx % SPINNER.length]`. However, this animated spinner is NOT passed down or used in the individual tool activity renderer.

Repaint source:
`statusService.ts` runs a `setInterval` loop that continuously updates `activity.elapsedMs = Date.now() - activity.startedAt` for every running activity and triggers `tuiState.requestChromeRender()`. So the TUI *is* actively repainting.

Silent tool behavior:
For a tool that emits no progress, the `elapsedMs` is updated continuously by the global timer. However, `renderActiveToolActivity` applies `Math.floor(activity.elapsedMs / 1000)`, meaning the visual string only changes exactly once every 1000ms. With a static marker and no tail updates, there are zero visual changes for 999ms at a time.

Progress-emitting tool behavior:
For tools that do emit progress (like `updateActiveToolProgress` being called with new `tail` strings), the UI correctly repaints these strings instantly, providing immediate visual feedback.

Frames:
t=0s:
`  ● Fetch https://example.com · 0s`
t=5s:
`  ● Fetch https://example.com · 5s`
t=10s:
`  ● Fetch https://example.com · 10s`
t=16s:
`  ● Fetch https://example.com · 16s`

Root cause candidate:
The tool activity UI looks hung because it uses a static marker (`●`) instead of an animated spinner, and its elapsed time rounds to the nearest second, stripping all sub-second visual heartbeat. 

Files involved:
- `src/tui/renderers/chatRenderer.ts` (`renderActiveToolActivity`)
- `src/tui/statusService.ts` (timer loop)

Regression test:
Added `src/tui/renderers/__tests__/liveToolActivity.test.ts` to deterministically verify the static marker, elapsed updating, and tail progression.

Severity:
P2

Phase to fix:
Phase 2

Production behavior changed:
NO
