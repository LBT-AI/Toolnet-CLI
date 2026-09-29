# Phase 1.2 — Browser Capability

Finding:
TN-R0-005A

Root cause:
The `browser` tool was exposed unconditionally to the model even if the underlying `playwright` module or Chromium binaries were unavailable on the host. This caused the model to use the tool and fail at runtime, wasting provider turns.

Fix:
Implemented a canonical, cached async capability probe (`getBrowserCapability`) in `browserTool.ts`. This probe safely determines if Playwright and Chromium are available. Hooked the probe into `executeBrowserTool` to fail fast safely if invoked internally/directly while unavailable. Added a dynamic filter in `agentHarness.ts` that omits the browser schema from the provider's `toolsForRequest` payload if the host is incapable.

Capability states:
- missing module: Schema omitted, direct call returns `TOOL_UNAVAILABLE`.
- missing binary: Schema omitted, direct call returns `TOOL_UNAVAILABLE`.
- available: Schema exposed, functions normally.

Registry:
The `browser` tool remains registered statically in `toolRegistry` for internal compatibility, but is filtered exactly at the boundary before being sent to the provider.

Provider-visible schema:
Omitted for incapable hosts.

Direct invocation fallback:
Returns structured `TOOL_UNAVAILABLE: <reason>`.

Auto install:
NO

Tests:
Re-wrote `browserAvailability.test.ts` to deterministically mock `playwright` capability state using nested mock mutations, testing all four paths.
Added `agentHarnessBrowserSchema.test.ts` to assert that `AgentHarness` successfully omits the schema when unavailable.
PASS

Production behavior changed:
YES
