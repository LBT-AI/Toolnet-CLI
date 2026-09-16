# Phase 89 — Reliability, Observability & Fault Recovery

Baseline commit: `fac9c75` (Phase 88 handoff, `feat(tui): harden production terminal interface`).

## 1. Source references actually inspected

| Reference | Verdict | What was taken |
|---|---|---|
| `anomalyco/opencode` dev `packages/opencode/src/session/retry.ts` | ADAPT | bounded attempts, jittered exponential backoff, Retry-After honoring with caps, terminal-vs-transient split |
| `anomalyco/opencode` dev `packages/opencode/src/provider/error.ts` | ADAPT | bounded redacted provider error evidence; protocol errors normalized at the provider boundary, not in the harness |
| `anomalyco/opencode` dev `packages/opencode/src/session/processor.ts` | KEEP (invariants only) | ToolNet keeps its own AgentHarness; only the lifecycle evidence model (request→stream→tool→retry→failure→completion) informed turn spans |
| `anomalyco/opencode` dev `packages/opencode/src/session/llm.ts` | KEEP (invariants only) | stream terminal-condition handling informed the silent-EOF defense |
| `openai/codex` main `codex-rs/codex-api/src/telemetry.rs` | ADAPT | per-attempt timing/outcome shape, instrumentation independent from request correctness |
| `openai/codex` main `codex-rs/otel/src/config.rs` + `metrics/config.rs` | ADAPT | exporter defaults to none; local in-memory by default; config boundary validated; telemetry failure non-fatal |
| `openai/codex` main `codex-rs/core/src/mcp_tool_call/telemetry.rs` | ADAPT | operation duration + outcome classification with sanitized bounded tags |
| OpenRouter ORI Eval docs | ADAPT | deterministic comparisons, pinned dimensions, explicit failure classes — extended the existing EvalRunner taxonomy |

Not copied: Codex Statsig/export setup, OpenCode session processor internals, OTEL SDK dependency (v1 uses the internal span model; remote export remains out of scope for Phase 89).

## 2. Ownership map (before → after)

| Concern | Before | After |
|---|---|---|
| AgentHarness / AgentEngine / ModelRouter / ToolRegistry / ToolGateway / SessionStore / ContextManager / RepositoryIntelligence | single owners (Phases 73–88) | unchanged, guarded by static tests |
| Failure classification | `src/core/models/failureKind.ts` | extended in place (`stream-incomplete`, `quota`; structural + transport-code evidence) |
| Retry policy | provider-internal loops only, message-regex-based | canonical classifier extended; provider honors Retry-After with bounds; quota 429/401/cancel terminal |
| Stream reliability | none (silent EOF read as success) | `src/lib/streamReliability.ts` — terminal validation + `StreamStallWatch` |
| Logging | `src/lib/telemetry.ts` (crash/audit), prose logs | `src/lib/observability/logger.ts` — structured JSONL, rotated, 0600, redacted |
| Metrics | ad-hoc | `src/lib/observability/metrics.ts` — bounded series, sanitized labels, canonical names |
| Tracing | none | `src/lib/observability/trace.ts` — in-memory bounded spans with parent/child correlation |
| Health snapshot | none | `src/lib/observability/healthSnapshot.ts` — read-only, no probes |
| CLI faces | inline in `src/index.tsx` | `src/commands/observabilityCli.ts` (`toolnet health/logs/trace`), formatting-only |
| Secret redaction | `redactSecret` + `redactOutputSecrets` | reused everywhere; reader-side re-redaction added; no second implementation |

The ONE new owner: `ObservabilityHub` (`src/lib/observability/hub.ts`) — process-wide, best-effort, never throws, never gates control flow. Wired into `agentHarness` (turn lifecycle, model attempts, fallbacks) inside `try {} catch {}` so observability failure can never break a run.

## 3. Phase 88 Tier 3/4 closure (the mandated first task)

New deterministic suites driving production modules (same idiom as Tier 2):

| Tier 3 requirement | Test file | Status |
|---|---|---|
| submit-during-tool-run, ctrl-c during stream, resize during stream | `tests/e2e/tier3-cross-feature/*.test.ts` (4 files) | PASS |
| modal-permission racing (FIFO, double-reply, cancel races) | `tests/e2e/tier3-cross-feature/modal-permission-racing.test.ts` | PASS |
| Tier 4 scenarios (coding workflow, slash flow, session mgmt, error recovery) | `tests/e2e/tier4-scenarios/*.test.ts` (4 files) | PASS |

Defect found & fixed during closure: the render-fault fallback frame shrank with tiny reported terminal sizes, losing its actionable guidance — now clamped to a readable floor regardless of reported geometry (`src/tui/renderers/errorBoundary.ts`).

## 4. Stream reliability

- `requireStreamTerminal`: a stream is complete only with a terminal finish reason; a silent EOF after deltas throws `StreamIncompleteError` (retryable, classified `stream-incomplete`) — the half-answer can never surface as success.
- `StreamStallWatch`: bounded inactivity window (120s default); fires once, aborts the underlying request; an inactivity abort converts to a retryable `TimeoutError`, never user-cancellation. No pause/resume API — the stream is fully consumed before tools run, so local tool time cannot be misread as provider inactivity.
- Wired at the single choke point `AgentHarness.completeModelOnce`.

## 5. Retry ownership & matrix

- Single classification authority: `failureKind.ts`. Matrix pinned by tests: 429/5xx/transport retryable; 401/403 auth terminal; 400/422 terminal; quota 429 terminal (recognized from provider wording, `isQuotaExhaustedMessage`); permission/cancelled never retried and never health-affecting; unknown terminal.
- Provider (`openaiCompatible.ts`): Retry-After honored (seconds or HTTP-date), bounded to 30s, abort-interruptible; backoff bounded with jitter; every exhausted attempt records the true status so the classifier sees real evidence.
- Health: quota/cancel/permission/bad-input never poison `ProviderHealth`; transport/server/auth failures do.

## 6. Observability details

- Correlation: `CorrelationContext` (sessionId, turnId, runId, modelRequestId, toolCallId, backgroundJobId, subagentId, teamworkNodeId, externalHarnessRunId, traceId/spanId). Existing identity propagated; no disconnected random ids.
- Logs: JSONL at `~/.toolnetcli/logs/toolnet.jsonl`, 5 MiB × 5 files, 14-day retention, mode 0600, rotation + `cleanOldLogs`. Levels debug/info/warn/error; cancellations and permission denials are `info`/`warn`, never `error`.
- Metrics: bounded 500 series; allowed label keys (`provider`, `model_family`, `model`, `tool`, `outcome`, `error_class`, `harness`, `operation`, `status`) sanitized and capped at 64 chars; canonical names for model/provider/tool/turn/compaction/repo/MCP/external-harness counts, durations and errors.
- Trace: spans for agent_turn, model_request, provider_attempt, tool_call, verification, test, compaction, external_harness, mcp_call; bounded 500; no span per token.
- Privacy: local-only by default; no fetch/remote exporter anywhere in `src/lib/observability` (guarded by a static test); credentials and prompts are never logged (redaction on write and on read).

## 7. CLI

- `toolnet health [--json]` — read-only component snapshot (session store, provider registry, sessions count, observability logs; unprobed components report `unknown`). No paid calls, no index rebuild side effects.
- `toolnet logs [--level] [--session] [-n] [--json] [--follow]` — bounded tail read (windowed, not whole-file), filters, human or JSONL output, poll-based follow, re-redacted at display.
- `toolnet trace [traceId] [--json] [-n]` — local span inspection.
- `/doctor` extended with observability-log and health-snapshot checks; `runDoctor` stays under 2s (verified).

## 8. Crash reporting & recovery

- Existing `src/lib/crashRecovery.ts` (Phase 85) and `src/lib/telemetry.ts` crash reports remain the owners; observability logs add bounded, redacted lifecycle context around them. No second recovery store.

## 9. Chaos / fault injection

- `tests/chaos/helpers/faultServer.ts` — test-only deterministic fault injection (status sequences, truncated SSE streams, stalls, quota bodies, Retry-After headers, raw-socket connection reset via `createResetServer`). Not wired into production; no env backdoor.
- `tests/chaos/provider-fault-matrix.test.ts` — 503→recovery, permanent 503 bounded, connection reset bounded + classified `network`, Retry-After honored/capped/interruptible, quota not retried, 401 terminal, cancel never retried, truncated stream classified `STREAM_INCOMPLETE`, complete stream validates, Retry-After surfaced on streaming errors.
- `tests/chaos/process-leaks.test.ts` — real /proc-based process-tree checks (SIGTERM-ignoring child force-cleaned), listener-leak guards across repeated harness/external-harness cycles, memory bounds (metrics/trace/log ring).
- `tests/chaos/headless-exit-codes.test.ts` — real subprocess runs: `--version`/`--help`/`health`/`logs`/`trace` → 0; unknown command → 2 with usage pointer; `-p` without provider → non-zero with classified error. `nonInteractive.ts` now exits by verdict: SUCCESS 0, FAILED 1, TIMEOUT 124, CANCELLED 130 — a half-finished run can never exit 0.

## 10. Architecture guards

`src/lib/observability/__tests__/architecture.test.ts`: exactly one hub/logger/registry/store; no `TelemetryBus`/`ReliabilityBus`/`MetricsEventBus`/`TraceEventBus`/`ProviderHealthV2`/`ReliabilityEvidenceV2`; observability code never touches tools/providers/credentials/permissions/session-store; no remote endpoints or `fetch` in observability; harness call sites observe only through the hub.

## 11. Defects found during this phase (root cause → fix → regression)

1. Health snapshot called `sessionStore.doctor()` (full 10.8k-session scan, 4.2s) → doctor timed out at 5s. Fix: snapshot uses a directory listing only; deep scan stays in `toolnet session doctor`. Regression: 2k-session timing test + read-only assertion.
2. Registry grew to 41 commands (`/logs`, `/trace` added to the TUI palette) → 6 palette tests + doctor-secret tests failed. Fix: observability moved to canonical CLI runners (`observabilityCli.ts`); registry restored to 39; no TUI surface duplication.
3. Provider swallowed the real failure status across attempts (`lastError` never set on HTTP failures) → permanent-503 chaos case hung. Fix: record redacted status evidence per attempt; cap the 429/503 retry sleep to the final attempt (no sleep before giving up).
4. `ECONNRESET` buried on `err.cause` by fetch → "connection reset" classified `unknown` (terminal). Fix: `transportErrorCode`/`isRetryableTransportError` (cause chain + undici wording); classified retryable `network`. Regression: reset-socket chaos case.
5. Quota-exhausted 429 retried like a transient rate limit. Fix: body-aware detection at the provider + `quota` class (terminal, health-neutral). Regressions in matrix suite.
6. Trace-store test isolation: `/trace` CLI test saw spans from prior suites. Fix: `traceStore.clear()` in test setup.
7. Unknown top-level commands fell through into the interactive TUI (scripting hang). Fix: fail fast with exit 2 + usage pointer; `auth`/`eval`/`harness` added to known subcommands (regression caught by the non-TUI isolation suite).

## 12. Test results & gates

- Full suite: 2648 pass / 0 fail / 3 skip (25 new chaos/observability/failure-taxonomy tests + 42 Tier 3/4 tests from the closure task).
- Typecheck: 0 errors. Build, `npm pack --dry-run`, `git diff --check`: clean.
- Five consecutive clean full-suite runs + PTY acceptance (120x40/100x30/80x24/60x20 + live resize) re-run before commit — see final report for the recorded runs.
- Hygiene: `rg "Phase [0-9]+|phase [0-9]+|PHASE [0-9]+|§[0-9]+" src` → 0.

## 13. Known limitations & Phase 90 boundary

- Trace store is in-memory only (bounded); a durable trace file was deliberately skipped — local inspection suffices for v1 and avoids a second persistence owner.
- Remote OTEL export remains unimplemented by design (opt-in requirement belongs to a later release decision).
- `--follow` polls rather than tailing an open fd, so rotation is followed correctly at the cost of a 400ms poll interval.
- Phase 90 owns Golden Acceptance/release; no release, branding, or marketplace changes were made here.
