# Phase 0.5 — Browser + Web Fetch Reproduction

HEAD: 825cee8
Status: BUG REPRODUCED

## TN-R0-005A Browser

Advertised:
YES (unconditionally registered in `toolRegistry.ts`)

Playable/runtime available:
NO (if `playwright` is missing or binary is missing)

Capability probe:
There is no capability probe at startup or registration time to conditionally hide the schema.

Missing dependency behavior:
Returns a direct error to the model: `Playwright is not installed. To enable real browser features...`

Missing Chromium behavior:
Returns the raw Playwright launch error: `Executable doesn't exist at...`

Root cause candidate:
The `browser` tool is unconditionally registered in `toolRegistry.ts` regardless of the host environment's actual capabilities, advertising a tool that cannot be executed and luring the model into a doomed path.

Severity:
P1

## TN-R0-005B web_fetch

Timeout:
20000 ms (20 seconds) hardcoded in `safeFetch` configuration.

Retry:
NO (no internal retry loop or exponential backoff in `toolWebFetch`).

Fallback:
NO (does not fallback to an alternate fetcher or the browser tool).

Timeout result:
`Web fetch error (TIMEOUT): Request timed out after 20000ms...`

Network error result:
`Web fetch error (NETWORK_ERROR): Fetch failed...`

HTTP 500 result:
`HTTP 500 Internal Server Error (Xms)\nURL: ...`

Root cause candidate:
`toolWebFetch` lacks built-in resilience for common transient web errors (like timeouts and 5xx). It forwards the error directly as a failed tool result, forcing the LLM to manually reason about retrying.

Severity:
P1

## Turn cost

Because neither tool has internal recovery, a failure immediately returns a `success: false` result to the harness. This consumes 1 provider turn to receive the tool call, and requires at least 1 more turn for the model to attempt a retry or alternate path. Given the hard `maxTurns = 10` cap (Phase 0.4), transient web failures severely deplete the agent's limited budget.

## Tests

Added regression tests:
- `src/lib/__tests__/browserAvailability.test.ts`
- `src/lib/__tests__/webFetchTimeout.test.ts`

Production behavior changed:
NO
