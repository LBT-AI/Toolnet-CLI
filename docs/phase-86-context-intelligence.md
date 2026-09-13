# Phase 86 — Context Intelligence / Token Budget / Compaction / Context Cache

This document is the handoff for Phase 87. It records what changed, what was
actually inspected, the defects found, and the exact boundary Phase 87 inherits.

## 1. Baseline

| Item | Value |
| --- | --- |
| Baseline commit | `d6391de` (Phase 85 docs) |
| Phase 85 code commit | `5d63ee3` |
| Phase 85 docs / CI-fix commits | `c3e90bd`, `cd3825a`, `d6391de` |
| Baseline gates | typecheck PASS · 2388 pass / 3 skip / 0 fail · build PASS · pack PASS |
| Working tree at start | clean, `main` up to date with `origin/main` |

No unexplained regression was present at baseline.

Before this phase a substantial context layer already existed under
`src/lib/context/` (token estimator, model budget table, tool pruner, atomic
compactor, context engine). Phase 86 **extends** it; it does not replace it and
does not create a second owner.

## 2. References actually inspected

| Reference | Verdict | What was taken |
| --- | --- | --- |
| OpenCode `session/compaction.ts` | ADAPT | Overflow-triggered compaction, protected recent tool results, a compaction event, and the notion that compaction is a lifecycle step the run continues from. The Effect runtime and its summarisation prompt were not copied. |
| OpenCode `session/overflow.ts` | ADAPT | Overflow is classified before it is acted on, and the usable window is derived from model metadata rather than a constant. |
| OpenCode `session/processor.ts`, `message-v2.ts` | NOT_APPLICABLE | ToolNet already has one processor (the agent loop) and one transcript; a second message conversion path would be a parallel system. |
| OpenCode issues 27924 / 32656 / 27519 / 14562 / 13946 | ADAPT | Used as an adversarial checklist: infinite compaction loop, output-budget mismatch, unrecognised overflow, media surviving compaction, and compaction exiting the run instead of continuing. Each has a corresponding guard or test below. |
| Codex `session/context_window.rs` | ADAPT | "Usable context" as distinct from the raw window, and a compaction scope separate from the active context. |
| Codex `tasks/compact.rs`, `compact_token_budget.rs` | ADAPT | Compaction as a token-budget transition with its own trigger; not copied as a Rust task architecture. |
| Codex `protocol/src/openai_models.rs` | ADAPT | `context_window` / `max_context_window` / effective-percentage concepts. ToolNet's catalog is the single metadata source; no second table was added. |
| Codex `models-manager/models.json`, `realtime_context.rs` | ADAPT | Bounded sections and concise carry-forward. No model-specific prompt text was copied. |
| ToolNet `src/lib/context/*` | EXTEND | The existing estimator, budget, pruner, atomic compactor and engine became compatibility callers of the canonical layer. |
| ToolNet `src/core/session/*` (Phase 85) | EXTEND | `context.compaction` added as a journal event type; checkpoints written through the existing store API. |

## 3. Ownership table (before → after)

| Responsibility | Before | After |
| --- | --- | --- |
| Token estimation | `lib/context/tokenEstimator` (bare numbers) | `core/context/estimator` (`TokenEstimate` with provenance); the lib module delegates |
| Model limits | `lib/context/modelBudgets` hard-coded table | `core/context/limits` (ModelCatalog first, compatibility table second, conservative fallback third); the lib module delegates |
| Budgeting | implicit in the engine | `core/context/budget` (`computeContextBudget`) |
| Planning / protection | none | `core/context/planner` (`planContext`, protected categories) |
| Compaction | `lib/context/atomicCompactor` called directly | `core/context/compaction` (bounded orchestration + progress guarantee) with the atomic compactor injected as the summary step |
| Overflow classification | none | `core/context/overflow` (`ContextOverflowError`) |
| Cache | none | `core/context/cache` (bounded, content-keyed) |
| Model-visible context | `ContextEngine.prepareMessagesForApi` | `core/context/manager` (`ContextManager.prepare`), with the engine as the compatibility wrapper |
| Durable history | `SessionStore` (Phase 85) | unchanged — the manager writes a `context.compaction` event + checkpoint through the store's public API |

Exactly one of each owner exists (guard-tested).

## 4. Architecture

```
SessionStore ── durable history (never deleted because it left a window)
      │
ContextManager ── what the model sees this turn
  ├─ TokenEstimator     (tokens + confidence + source)
  ├─ limits/budget      (ModelCatalog → usable input, output reserved)
  ├─ ContextPlanner     (protected vs prunable, with reasons)
  ├─ bounded compaction (prune first, then one summary step)
  └─ ContextCache       (bounded, content-keyed)
      │
AgentHarness → ModelRouter → ModelAdapter
```

`Session history != model-visible context`. The planner marks items it cannot
vouch for as *prunable*; it never deletes them from the store.

## 5. Token estimation

`TokenEstimate { tokens, confidence: "exact" | "high" | "low", source:
"provider_usage" | "tokenizer" | "estimated" | "unknown" }`.

- Only provider-reported usage is `exact`. It calibrates **future** estimates
  through a factor bounded to `[0.6, 1.6]` with `α = 0.3`; it never rewrites a
  recorded measurement and never claims the next request is the same shape.
- A provider that reports nothing is ignored, not treated as an empty prompt.
- Multibyte scripts are estimated tighter than latin text of equal length.
- `length / 4` exists only inside the estimator; a guard test fails the build if
  it reappears elsewhere.

## 6. Budgeting

`ContextBudget` = window / reservedOutput / reservedSystem / reservedTools /
usableInput / estimatedInput / remaining / threshold / source / confidence /
overThreshold / overflow.

Order of reservation: **output first**, then tool schemas, then system
instructions, then attachments; the transcript is admitted against what remains.
Output reservation is capped (`OUTPUT_RESERVE_CAP = 20 000`) so a large output
allowance does not withhold more input than the answer needs, while zero
reservation would guarantee an overflow on the first long reply.

- Catalog values are authoritative; a catalog entry declaring one of the two
  values supplies it and falls back for the other, marked `source: "catalog"`.
- Compatibility identities keep their pre-catalog capacity **and their
  established compaction trigger** (`compactionThreshold`), because a session on
  those names was measured against that cadence.
- The unknown-model fallback is deliberately narrow (32 000) and marked
  `source: "fallback"`. Guessing high is the dangerous direction.

## 7. Protected context

Protected: system instructions, any permission **decision** (a dropped DENY is
re-issued as if it never happened), the current task, the newest unresolved
failure, recent tool results, and the newest failure/permission evidence.

- `carriesPermissionDecision` recognises the explicit marker as well as the
  shapes tools actually emit (`"decision":"DENY"`, "permission denied",
  "forbidden", "denied by policy", "approval").
- `AgentHarness` additionally re-appends a retained-denial line after
  compaction/pruning, so a narrowed window cannot erase a DENY.
- The newest failure is kept as verification evidence; dropping it would let the
  model claim a fix is verified when it is not.

## 8. Tool-output pruning and duplicate reduction

`pruneOldToolResults` (reused) keeps the last N tool results in full fidelity,
preserves error/status detail, and maintains 1-to-1 `tool_call_id` pairing.

The planner adds **duplicate detection**: a tool result whose (role, content)
fingerprint matches a *newer* one is marked redundant. This is a planning
decision — the payload is still in durable history.

## 9. Compaction lifecycle

```
budget → plan → (threshold crossed or forced) → prune step → summary step
      → measure → accept only if it strictly reduced the estimate
```

- Deterministic pruning is tried first; a model call is only worth it once
  structural cleanup is exhausted. The summarizer is **injected**, so this layer
  never reaches for a provider.
- A successful compaction is journaled as `context.compaction` and followed by a
  checkpoint, in that order, through the `SessionStore` API. The original
  transcript is not overwritten.
- `CompactionRecord` persists ids, strategy, before/after estimates, and an
  opaque `summaryRef` — never credentials, prompts or reasoning.

## 10. Overflow recovery

`classifyContextFailure` separates `context_overflow` (the one case compaction
can fix) from `rate_limit`, `auth`, `unavailable`, `bad_request`, `cancelled`.
Only `context_overflow` is `compactionMayHelp`; everything else keeps its
Phase 82 semantics. Provider-specific wording stays in the provider error layer.

## 11. Progress guarantee (no infinite compaction)

- Every pass is measured before and after; a pass that does not **strictly**
  reduce the estimate terminates the run.
- Each strategy runs at most once before the next is tried (`maxPasses` default 3).
- The run must clear a minimum saving (`min(minSavingsTokens, before × 5%)`,
  floored at 1) to count as success; otherwise it fails with a reason.
- Zero progress ⟹ `no_reduction`, growth ⟹ `increased`, refusal ⟹
  `refused_integrity`, abort ⟹ `cancelled`. Nothing loops.

## 12. Session integration and resume

- `context.compaction` is a new `SessionEventType`; replay tolerates it as an
  additive event.
- `ContextManager.persistRecord` only journals for a session the store already
  owns — a context optimization must never create session files as a side effect.
- Resume restores history and the current compacted state; it does not
  re-summarise on load, and replay never executes tools.

## 13. Context cache

Two maps keyed by **content** (FVN-1a hash + length), not filename:

- file content (verified against size + mtime captured at read; a change is a
  miss; `invalidatePath` covers a same-size write in the same millisecond, which
  metadata alone cannot detect);
- token estimates keyed by `modelFamily::hash`.

Bounded by `maxEntries` and `maxBytes` with deterministic oldest-first
eviction. The cache is an optimization: correctness never depends on it, and
corruption cannot stop a run.

## 14. CLI and TUI

```
toolnet context status  [--session <id>] [--model <m>] [--json]
toolnet context explain [--session <id>] [--model <m>] [--json]
toolnet context compact [--session <id>] [--force] [--json]
toolnet context cache status [--json]
toolnet context cache clear
```

`status`/`explain` are read-only and local (no provider call, no mutation).
`compact` is a no-op with a reason when nothing can be cut, never a fabricated
success.

TUI: the sidebar context line now takes limits from the model catalog (removing
a hard-coded table), prefers the live estimated context over the cumulative
session counter, and shows `% · remaining · near limit / compacting`.

## 15. Eval

- `EvalCaseResult.context` and `EvalRunMetrics.context` carry per-case and
  aggregate context footprint (`estimatedInputTokens`, `actualInputTokens`,
  `compactions`, `cacheHits`). They are populated from the accounting the
  production request path already wrote for the case session — not a second
  estimator — and are absent when a case reported none (backward compatible).
- `src/core/eval/contextEval.ts` is a deterministic, offline suite over the same
  production API: output reservation, conservative unknown window, large
  transcript compaction, duplicate reads, shell-output pruning, failure-evidence
  preservation, DENY protection, goal preservation, no-progress termination,
  bounded passes, increase rejection, small-request no-op, cache invalidation.

## 16. Defects actually discovered

1. **Compatibility cadence silently changed** (`CONTEXT_BUDGET`). Deriving one
   uniform threshold moved the established compaction trigger for pre-catalog
   identities; a transcript that used to compact no longer did, breaking
   `src/teamwork/__tests__/context.test.ts`. Root cause: `getModelContextSpec`
   replaced absolute thresholds with a ratio, and the engine stopped consulting
   the compatibility trigger at all. Fix: carry `compactionThreshold` on
   `ModelLimits` for legacy/fallback identities and request compaction when that
   trigger fires. Regression-tested in `budget.test.ts`.
2. **Cache cannot detect a same-size same-millisecond write** — confirmed while
   writing the eval case. This is inherent to metadata-based verification; the
   contract is explicit invalidation, and both the unit test and the eval case
   now assert exactly that rather than an impossible guarantee.

## 17. Production-source hygiene

`src/core/context/**`, `src/commands/contextCli.ts`, `src/core/eval/contextEval.ts`
and every other file this phase introduced contain **no** phase-history labels.

Pre-existing repo-wide debt was found while checking this: `grep -rInE
"Phase [0-9]+|§[0-9]+" src` reports **904 occurrences across 286 files** from
earlier phases. The hygiene gate as written uses `rg`, which is **not installed
in this environment**, so previous phases' "zero matches" checks silently
reported nothing rather than passing. Purging 286 unrelated files is out of scope
for this phase; the debt is recorded here so Phase 87 can decide.

## 18. Tests

- `core/context/__tests__`: budget/estimator/limits/planning (19), compaction
  progress/failure/concurrency (24), overflow classification, manager lifecycle,
  architecture guards. **69 tests, all deterministic, no provider.**
- `core/eval/contextEval.ts` + its test: 13 deterministic context cases.
- `commands/__tests__/contextCli.test.ts`: 10 CLI tests.
- `teamwork/__tests__/context.test.ts`: the compatibility regression, restored.

## 19. Gate results

```
typecheck PASS
build PASS
npm pack PASS
bun test: 2390 pass / 3 skip / 0 fail   (3 consecutive clean full runs)
```

No test timeout was raised.

## 20. Live acceptance

No paid provider was used and none is required: the primary acceptance is the
deterministic local context suite. A live long-context smoke was **not** run —
`ENVIRONMENT/SKIPPED`, no credentials assumed and no quota deliberately burned.

## 21. Known limitations

- Token counts remain estimates except when a provider reports usage.
- `ContextManager` holds the cache/estimator singletons; a caller wanting
  isolation must inject its own (the eval does where it matters).
- Compaction concurrency is serialized per key within one process; it is not a
  cross-process lock (the session lock is Phase 85's, and compaction is bounded
  and idempotent).
- The context cache is in-memory; it does not survive a restart (deliberate —
  it is an optimization, not state).
- Repo-wide phase-history labels remain (see §17).

## 22. Phase 87 integration boundary

Phase 87 inherits: `ContextManager` as the only model-visible context owner;
`SessionStore` as the only durable history owner; `context.compaction` as the
journal event; `CompactionRecord` as the durable compaction shape. Phase 87 must
not add a second estimator, budget, planner, compactor, cache, or a parallel
transcript. Any new context feature belongs behind `ContextManager.prepare`.

## 23. Final commit

Recorded in the commit that follows this document.
