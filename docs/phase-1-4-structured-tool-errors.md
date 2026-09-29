# Phase 1.4 — Structured Tool Errors

## Contract
Implemented a canonical `StructuredToolError` type in `src/core/contracts.ts` containing the `code`, `message`, `retryable`, and `suggestedTool` fields. This data correctly flows through `agentTools.ts` -> `ToolGateway` -> `agentHarness.ts` -> Provider Adapters, reaching the LLM in JSON format.

## Codes implemented
- `TOOL_UNAVAILABLE`
- `TIMEOUT`
- `NETWORK_ERROR`
- `HTTP_ERROR`
- `NOT_FOUND`
- `NOT_A_FILE`
- `INVALID_INPUT`
- `OUTSIDE_WORKSPACE`
- `PERMISSION_REQUIRED`
- `PERMISSION_DENIED`
- `SECURITY_DENIED`
- `CANCELLED`
- `EXECUTION_FAILED`

## Browser
- Intercepts missing/unavailable Chromium and yields `TOOL_UNAVAILABLE` via `browserTool.ts` execution logic.

## Web fetch
- Returns `TIMEOUT`, `NETWORK_ERROR`, `HTTP_ERROR` (with status), and `INVALID_INPUT` mapped dynamically from the inner `SafeFetchError` or HTTP responses in `toolWebFetch`.
- Cancellation via AbortSignal is accurately reported as `CANCELLED`.

## Read file
- Attempting to read a directory yields `NOT_A_FILE` with `suggestedTool: "list_dir"`.
- Reading a non-existent file accurately yields `NOT_FOUND`.

## Security/Permission
- `ToolGateway`'s blocked operations are mapped in `agentHarness.ts` logic into `SECURITY_DENIED`, `OUTSIDE_WORKSPACE`, `PERMISSION_REQUIRED`, or `PERMISSION_DENIED` depending on user interaction and sandbox bounds.

## Cancellation
- Abort triggers are comprehensively mapped to `CANCELLED` in both `toolExecutor.ts`, `agentHarness.ts` and `agentTools.ts` execution contexts.

## Legacy compatibility
- Non-structured legacy fields (`stdout`, `stderr`, `exitCode`, `error`) have been carefully preserved. Generic command failures automatically backfill to `EXECUTION_FAILED` to ensure the model still perceives an actionable structure.

## Model-facing propagation
- PASS. Verified `agentHarness.ts` emits JSON into the `.content` property of the `tool` message roles which propagates into the final LLM-provider-facing adapter.

## CallId regression
- PASS. `tool_call_id` reconciliation tests continue to pass completely unmodified, as `AgentHarness.ts` binds `m.id` perfectly into `messages`.

## Tests
- Added `src/core/__tests__/toolErrorContract.test.ts` to assert end-to-end functionality of tools generating valid `structuredError` fields.
- Typecheck and all existing functionality remain stable.

## Production behavior changed
- YES (Tool output now emits an additional `structuredError` block inside the provider-bound JSON).

## Completion Patch 1.4.1

INTERNAL_ERROR:
IMPLEMENTED

suggestedAction:
IMPLEMENTED

details:
IMPLEMENTED

HTTP status details:
PASS

Internal exception:
PASS

Execution failure distinction:
PASS

Model-facing propagation:
PASS

Full validation:
- Typecheck: PASS
- Tests: 3260 passed / 0 failed / 20 skipped
- Build: PASS

Exact tests:
3260 passed / 0 failed / 20 skipped

Phase 1.4 acceptance:
PASS
