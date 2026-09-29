# Phase 3 — Agent Loop / Adaptive Turn Budget

HEAD base: Phase 2 closed (2.1–2.4)
Status: FIXED

## Problem (from docs/phase-0-4-max-turns.md)

The loop was `while (turnsUsed < maxTurns)` with an absolute default of 10.
A task with real, verifiable progress on every turn died at turn 10 with
`Exceeded maximum turn count (10)` — while genuinely stuck runs were already
caught by the repeat/no-progress guards before the budget mattered. The bug
was the ONE absolute ceiling, not the budget concept itself.

## Design (required shape — implemented)

Separate concepts, all values CENTRALIZED in
`src/core/harness/continuation.ts` (no scattered literals):

| Concept | Value | Meaning |
|---|---|---|
| soft/base budget | existing resolved budget (`resolveMaxTurns`: option → profile → config → 10; TURBO 5, SUBAGENT 8, minimal 6, reasoning 16 unchanged) | the run's starting turn budget |
| extension chunk | `ADAPTIVE_EXTENSION_CHUNK = 5` | bounded increment granted per boundary decision |
| hard safety cap | `ADAPTIVE_HARD_CAP = 35` | ALWAYS terminates; never extends; no infinite agent |
| tool-work ceiling | `ADAPTIVE_MAX_EXTENSION_TOOL_CALLS = 30` | meaningful distinct successful tool executions across all extensions |
| equivalent-variant bound | `ADAPTIVE_MAX_EQUIVALENT_FAILED_VARIANTS = 2` | failed executions of the SAME tool with SEMANTICALLY equivalent arguments before the semantic loop guard fires |
| synthesis reserve bar | `ADAPTIVE_MIN_VERIFIED_FOR_EXTENSION = 2` | verified results required to reserve ONE final synthesis turn at the boundary |

### Meaningful progress (observable, from existing evidence)

`decideAdaptiveExtension` consumes a snapshot built from the EXISTING
`ExecutionEvidenceCollector` + the loop's completion-gate evidence
(`recordEvidence` counts only `ok: true`):

- distinct successful (tool, args) signatures this run — new successful tool work
- verified mutations (`successfulMutations` / collector `verifiedMutations`)
- tests passed, verifications passed — verification
- meaningful NEW results == any of the above increasing

A failed retry alone is NOT meaningful progress: `failedToolCalls` (cumulative)
is tracked, and extensions are denied when failures outweigh all useful work
(`failedToolCalls > distinctSuccessful + verified`). Failures therefore consume
turns but never grant budget.

### Boundary decision (once per soft-budget level, in the outer loop header)

The loop became `outer: do { boundary; inner: while (turnsUsed < maxTurns) … }`.
When a level's turns are consumed without a final answer:

1. meaningful recent progress → EXTEND: budget += 5 (capped at 35), event
   `agent:thinking { reason: "budget-extended" }`, run continues;
2. task effectively complete (verified ≥ 2, tools were used, synthesis pending)
   → RESERVE: exactly ONE more provider turn for the final synthesis. The
   reserve turn can end only the run: gate-accepted prose returns success;
   a gate bounce or an empty turn settles with the boundary verdict — the
   reserve never earns further budget;
3. no progress / failures dominating / ceilings reached → STOP EARLY with a
   distinguishable terminal error (below).

### Repeated-tool guard (two tiers)

- Tier 1 (pre-existing, untouched): exact identical (tool, args) repeats →
  `Infinite loop detected: …` per `exceedsRepeatedToolCalls`. Interleaved
  edit→test cycles keep resetting it, so legitimate repair loops pass.
- Tier 2 (NEW, semantic): `semanticFailureSignature(tool, args)` normalizes
  whitespace/case and orders object keys, so "exit 1", "EXIT 1", "exit  1"
  collapse to one equivalent variant. Failed executions accumulate PER VARIANT
  GROUP; past the bound (3rd failure of an equivalent group) the run stops:
  `No-progress loop detected: the same tool failed with N equivalent argument
  variants…`. Changing the actual command (edit→different test→fix) creates
  NEW groups — never trips the guard.

### Guarantees

- Hard cap always terminates: `decideAdaptiveExtension` returns
  `stopKind: "hard-cap"` for EVERY snapshot at `turnsUsed ≥ 35` — even a
  maximally progressing one (unit-proven). No infinite agent.
- Legacy fidelity: with `adaptiveContinuation: false` (new ExecutionOptions
  flag, default on) the budget is the exact legacy hard stop. A model that
  never called ANY tool settles at the budget with the EXACT legacy error
  (`legacy-budget` path) — narrating runs keep their historical contract.
- Security policy and recovery engine untouched. Profiles unchanged.

### Distinguishable terminal errors

- Hard cap → `Hard safety cap reached (35 turns for one task). Stopping to
  protect resources.` (event code `HARD_CAP`)
- No-progress → `No meaningful progress: N failed execution(s) outweigh M
  verified result(s). Stopping instead of extending the budget.` (`NO_PROGRESS`)
- Repeated loop (semantic) → `No-progress loop detected: the same tool failed
  with N equivalent argument variants…` (`EQUIVALENT_FAILURE_LOOP`)
- (exact identical repeats keep the historical `Infinite loop detected: …`)
- None of these is the generic `Exceeded maximum turn count (N)`, which now
  only appears for opt-out runs and never-called-any-tool runs.

## Tests (deterministic — stubbed fetch, temp dir, no real provider, no timers)

`src/core/harness/__tests__/adaptiveBudget.test.ts` (12 tests):

- A: 15 meaningful unique turns → completes via bounded extension.
- B: 25 progressing turns → bounded continuation, still < hard cap.
- (boundary) at the 30-distinct-call ceiling with 2 verified mutations → ONE
  reserve synthesis turn → completes SUCCESS with the synthesis in `output`.
- C: infinite identical tool → early stop, `Infinite loop detected`.
- D: equivalent failed command variants → early stop (before 10 turns),
  `…equivalent argument variants`.
- E: 12 edit→test iterations with changing evidence → allowed, completes.
- F: failures burn turns but never extend: 12 equivalent-variant failures
  stop long before the budget.
- G: unit-level — at the cap EVERY snapshot stops (`hard-cap`); extension
  math bounded by the cap; `hardCapError` text exact.
- H: TURBO via `runTurbo` (5-turn shape, completes in 4); SUBAGENT via
  `runSubagent` (8-turn shape respected); `adaptiveContinuation: false` →
  exact legacy `Exceeded maximum turn count (10)`.
- Terminal errors: hard-cap / no-progress / repeated-loop strings mutually
  distinct, none generic; semantic signature equivalence pinned.

Updated `maxTurnsProgress.test.ts` test 1 to the explicit legacy opt-out
(`adaptiveContinuation: false`) — its asserted contract (10 unique tool turns
die at 10 with the legacy error) is unchanged and still verified.

## Validation

- `bun run typecheck` → PASS (tsc --noEmit, clean)
- `bun test` → **3362 pass / 0 fail / 20 skip** (3382 tests, 290 files)
- `bun run build` → PASS (index.js 2.91 MB)
- `npm pack --dry-run` → PASS (toolnetcli-1.3.0.tgz, 6 files)
- Phase 1/2 regression suites re-run explicitly (harness core, tool lifecycle,
  error contract, browser, abort/OAuth, lspGoldenE2E, security integration,
  streaming acceptance matrix + streaming hardening): **227 pass / 0 fail**

## Files changed

- src/core/harness/continuation.ts (adaptive policy: constants, snapshot,
  `decideAdaptiveExtension`, `semanticFailureSignature`, error builders)
- src/core/harness/index.ts (barrel exports)
- src/lib/harness/agentHarness.ts (outer/inner budget-level loop, boundary
  decision, progress accounting, semantic loop guard, reserve turn, tail
  settle with distinguishable errors)
- src/lib/harness/types.ts (`adaptiveContinuation?: boolean` opt-out)
- src/core/harness/__tests__/adaptiveBudget.test.ts (NEW)
- src/core/harness/__tests__/maxTurnsProgress.test.ts (legacy path now via
  explicit opt-out flag; assertions unchanged)
- docs/phase-3-agent-loop-budget.md (this file)

Production behavior changed: YES — that is the point of this phase, scoped to
the loop budget (soft budget + bounded progress-gated extensions + early
stops + hard cap). Security policy, recovery engine, provider wiring and
profiles untouched.
