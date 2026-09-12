# Phase 80 — Model Intelligence, ORI-style Eval, and Routing Profiles

Phase 79 made Provider/Model/Router canonical. Phase 80 turns that into a
**model-intelligence layer**: tasks are classified deterministically, routing is
driven by profiles + declared metadata + observed health + real eval evidence,
and models are measured **on the production execution path**.

Nothing from Phase 73–79 was rewritten:

- one `ProviderRegistry`, one `ModelCatalog`, one `ModelRouter`
- one `AgentEngine`, one `AgentHarness`, one `ToolRegistry`, one `ToolGateway`
- tool execution still goes `AgentEngine → ToolRegistry → Permission → ToolGateway`

The provider layer never executes tools.

---

## 1. Architecture

```
Task / user prompt
      │
      ▼
TaskClassifier            §2   deterministic, no LLM call
      │
      ▼
RoutingProfile            §3   weights + required/preferred capabilities + eval dims
      │
      ▼
ModelRouter.resolve()     §5   filter → score → rank → rung fallback
      │  ├── ModelCatalog        (metadata, tri-state capabilities, pricing, context)
      │  ├── ProviderRegistry    (health, priority, enabled)
      │  ├── ProviderHealth      (rolling latency, consecutive failures)
      │  └── ModelPerformanceProfile (eval evidence, OPTIONAL)
      ▼
ModelAdapter
      │
      ▼
AgentHarness  ── tools ──► ToolRegistry → Permission → ToolGateway → Executor → Verifier
```

`AgentHarness` no longer reads a provider map or env directly; it calls
`resolveRuntimeModel()` once and the router answers. CLI, TUI, `simple-repl`
and `smartPlanner` all resolve through the same `ModelRouter`.

---

## 2. TaskClassifier (`src/core/models/taskClassifier.ts`)

Deterministic, keyword + signal based. **No model name is ever used to
classify, and no LLM is called.**

| TaskType | Signals |
|---|---|
| `coding` | code fences, file paths, edit/fix/implement/refactor verbs |
| `debugging` | error/trace/failing/test/stack/regression |
| `planning` | plan/design/before/architecture/roadmap |
| `review` | review/audit/check carefully/critique |
| `search` | find/grep/search/locate/where is |
| `tool_heavy` | `requestedTools.length >= 3` (`TOOL_HEAVY_THRESHOLD`) |
| `vision` | image attachments |
| `long_context` | `contextSize >= 100_000` (`LONG_CONTEXT_THRESHOLD`) |
| `reasoning` | reason/prove/why/derive/analyze deeply |
| `fast` | trivial one-liner asks |
| `background` | background/job/queue role or mode |
| `general` | fallback |

```ts
interface TaskClassification {
  primaryType: TaskType;
  secondaryTypes: TaskType[];
  requiredCapabilities: CapabilityRequirement;   // hard filter
  preferredCapabilities: CapabilityRequirement;  // soft score
  confidence: number;
  reasons: string[];
  profile: RoutingProfileName;                   // suggested profile
}
```

`classificationToRoutingRequest()` bridges a classification into a
`RoutingRequest` without mutating user-explicit model choices.

Example: `"fix this TypeScript error and run the tests"` →
`primaryType = coding`, `secondaryTypes = [debugging, tool_heavy]`,
`required: { tools: true }`, `preferred: { reasoning: true }`.

---

## 3. RoutingProfiles (`src/core/models/profiles.ts`)

Nine profiles: `auto`, `quality`, `balanced`, `fast`, `cheap`, `coding`,
`reasoning`, `tool-heavy`, `long-context`.

```ts
interface RoutingProfileDefinition {
  id, label, description;
  ranking: "policy" | "score";
  policy: RoutingPolicyName;
  weights: ScoreWeights;               // capability, preference, eval, health, latency, cost, context
  requiredCapabilities?: CapabilityRequirement;
  preferredCapabilities?: CapabilityRequirement;
  evalDimensions: EvalDimension[];     // which eval axes this profile trusts
}
```

- `auto` / `balanced` keep Phase 79's policy ordering (no behaviour change for
  existing users).
- `quality` weights `eval: 3`, `cost: 0.25`, prefers reasoning + native tool calls.
- `fast` weights `latency: 3` on **observed** latency only.
- `cheap` weights `cost: 3` on **declared** pricing only.
- `coding` **requires** `tools: true`.
- `reasoning` **requires** `reasoning: true`.
- `tool-heavy` requires `tools: true` and weights `toolUse`/`reliability` eval.
- `long-context` weights `context` against the request's target.

**No profile maps a role to a vendor.** There is no `coding = Claude`,
`reasoning = GPT` anywhere in the codebase (asserted by a guard test).

All weights live in the profile — `scoring.ts` holds no magic numbers besides
named references (`NEUTRAL`, `COST_REFERENCE_USD`, `LATENCY_REFERENCE_MS`,
`CONTEXT_REFERENCE_TOKENS`, `MIN_LATENCY_SAMPLES`).

---

## 4. ModelScorer (`src/core/models/scoring.ts`)

```
total = Σ(weight_key × component_key) / Σ(weight_key)
```

Components (each normalized `0..1`, `NEUTRAL = 0.5` when genuinely unknown):

| Component | Source | Unknown handling |
|---|---|---|
| `capability` | profile preferred capabilities met | tri-state; unknown never counts as satisfied |
| `preference` | caller `preferredCapabilities` | same |
| `eval` | `ModelPerformanceProfile` for the profile's dims | `0` when insufficient samples |
| `health` | `ProviderHealth` | `unknown` provider → neutral |
| `latency` | rolling successful latency | `NEUTRAL` below `MIN_LATENCY_SAMPLES = 2` |
| `cost` | declared input+output pricing | unknown pricing → `NEUTRAL`, never "free" |
| `context` | context window vs. target | neutral when no target |

**Hard filter first.** A model missing a `requiredCapabilities` entry is removed
before scoring, so a model without `tools` can never win a `tools: true` task.

---

## 5. ModelRouter integration (`src/core/models/router.ts`)

Resolution ladder (unchanged from Phase 79, now profile-aware):

1. explicit `provider` + `model` → resolved, **no scoring, no substitution**
2. explicit `model` (parsed via the Phase 79 reference parser) → same
3. profile/policy ranking over the filtered candidate set
4. configured fallback rungs
5. structured `ModelRoutingError` with the reasons every candidate was rejected

Real `cheapest` / `fastest` (Phase 79 placeholders now complete):

- `cheapest` sorts on **normalized pricing metadata**. Unknown pricing is
  `NEUTRAL`, never `0`.
- `fastest` sorts on **observed provider latency** and reports
  `insufficient_data` when there are not enough samples. No hard-coded latency.

Every decision returns a `routingReason` explaining the winner and the runner-up,
with secrets redacted.

---

## 6. Persistent model cache (`src/core/models/cache.ts`)

`~/.toolnet/cache/models.json` (under the existing ToolNet home), schema
``MODEL_CACHE_SCHEMA_VERSION = 1``, TTL 24h.

- atomic write (tmp + rename)
- corrupt / wrong-schema file → quarantined, not fatal
- stale cache still hydrates the catalog (usable offline)
- **per-provider isolation**: `setCachedProviderModels` / `removeCachedProvider`
  touch only one provider, so a failing OpenRouter refresh cannot erase the
  ToolNet catalog
- refresh happens only on explicit `toolnet models refresh`, never in the
  routing hot path

---

## 7. Routing config persistence (`src/core/models/routingStore.ts`)

Persisted in the canonical config owner (`appConfig.ts`, schema v3) — **no new
config file was introduced**.

```
toolnet routing show
toolnet routing profiles
toolnet routing profile <profile>
toolnet routing model <model>
toolnet routing fallback add <model>
toolnet routing fallback remove <model>
toolnet routing reset
```

Atomic writes, validated patches (`validateRoutingPatch`), and full backward
compatibility: v2 configs migrate to v3 with `routing.profile = "auto"`,
`routing.policy = "priority"`, `routing.fallback = []`.

---

## 8. TUI model catalog

`/catalog` is registered in the **single** slash-command registry (`/catalog
[--provider <id>] [--capability <name>] [--free|--paid] [--use <model>] [search]`).

The TUI is a **consumer**: it reads `ModelCatalog`, `ProviderRegistry` and
`ProviderHealth` through the shared `buildCatalogRows` projection. It never
constructs a provider, performs no network I/O, and writes no config.
Selection (`--use`) reuses the exact `/model <id>` path (`ctx.setModel`), so the
catalog cannot become a second place that mutates model state.

`buildCatalogRows` exposes tri-state columns (Tools / Reasoning / Vision as
`yes`/`no`/`?`), context, price label and health, for CLI and TUI alike.

---

## 9. Eval core (`src/core/eval/`)

```
EvalRunner → AgentHarness → ModelRouter → ModelAdapter → provider
```

The runner **never calls `provider.chat` directly**. Forcing a model goes
through `RoutingRequest.explicitModel`, so eval and production share one path —
which is the whole point: a benchmark that measures a different path measures
nothing.

Modules:

| File | Responsibility |
|---|---|
| `types.ts` | `EvalSuite`, `EvalCase`, `EvalResult`, `EvalObservation`, `EvalRunRecord` |
| `schema.ts` | versioned record validation |
| `graders.ts` | deterministic graders |
| `runner.ts` | execution, observation capture, failure classification, metrics |
| `store.ts` | append-safe `~/.toolnet/evals/` JSONL + index |
| `profile.ts` | `PerformanceSample` → `ModelPerformanceProfile` |
| `suites.ts` | built-in suites |
| `liveAcceptance.ts` | live probe with explicit ENVIRONMENT skip |

Case types: `TEXT`, `CODE`, `TOOL`, `REASONING`, `STRUCTURED_OUTPUT`.

---

## 10. Deterministic graders

No LLM-as-judge. Every grader inspects evidence the runtime actually produced.

| Grader | Verifies |
|---|---|
| `ExactMatchGrader` | normalized final text equality |
| `ContainsGrader` | required substrings (all/any) |
| `RegexGrader` | pattern match on final text |
| `JsonSchemaGrader` | extracted JSON against a schema subset |
| `ToolCallGrader` | the **observed tool-call stream** — names, args, required-call satisfaction |
| `FileMutationGrader` | the **real filesystem** (content, created/deleted/unchanged) |
| `CommandExitGrader` | **real exit codes** from observed command executions |
| `RunStateGrader` | run-level outcome (`cancelled`, no-crash, permission respected) |

`ToolCallGrader` is what makes "the model *said* it fixed the file" a **FAIL**
when no tool ran, and `FileMutationGrader` is what makes it a **FAIL** when a
tool ran but the file is untouched.

---

## 11. Coding and tool-call eval

Coding suite runs against a temp workspace seeded from
`src/core/eval/fixtures/` and verifies the **real filesystem**:

| Case | Assertion |
|---|---|
| A read + answer | answer matches `NOTES.md` content |
| B fix TS bug | `sum.ts` corrected (`sum.check.ts` passes) |
| C run tests | real test command executed, exit 0 |
| D make test pass | failing check now exits 0 |
| E scope discipline | `other.ts` unchanged after a scoped edit |
| F permission denial | denial respected, no mutation |
| G malformed task | no crash, structured failure |
| H cancellation | run stops, classified `CANCELLED` |

Tool-call metrics measured separately from model prose:

- tool selection accuracy
- schema validity
- permission compliance
- execution success
- retry correctness
- unnecessary tool calls
- duplicate tool calls (`countDuplicateToolCalls`)

---

## 12. Normalized metrics and failure classes (`runner.ts`)

`EvalResult` normalizes: `success`, `score`, `durationMs`, `inputTokens`,
`outputTokens`, `toolCalls`, `failedToolCalls`, `retries`, `cost`, `provider`,
`model`, `failureClass`.

`failureClass` ∈ `CORE_RUNTIME | MODEL_COMPLIANCE | PROVIDER_PROTOCOL |
TOOL_FAILURE | PERMISSION | TIMEOUT | CANCELLED | ENVIRONMENT`.

A provider timeout is **not** a model-quality failure and a runtime bug is
**not** a model-quality failure; both are classified before aggregation.

---

## 13. EvalStore and ModelPerformanceProfile

`EvalStore` writes versioned JSONL plus an index under `~/.toolnet/evals/`:
append-safe, records model/provider identity, timestamp, suite version and
ToolNet version/commit when available. **No secrets are persisted.**

`aggregatePerformance()` produces:

```
coding, reasoning, toolUse, structuredOutput, reliability, latency, costEfficiency
```

A dimension scores only with `MIN_SAMPLES = 3`; otherwise it stays empty
(`isProfileEmpty`), and the router treats it as no evidence. No invented
benchmark numbers.

---

## 14. Router ↔ eval integration (guarded)

Eval data is **optional**. With no eval history the router still resolves on
capability + health + metadata. With history:

- `coding` profile prefers the `coding` score
- `tool-heavy` prefers `toolUse` + `reliability`
- `quality` weights the profile's `evalDimensions`

An explicit model always wins over scoring.

---

## 15. CLI

```
toolnet eval list
toolnet eval run <suite> [--model <model>]
toolnet eval compare <modelA> <modelB>
toolnet eval results
toolnet eval show <runId>
toolnet models [--provider <id>]
toolnet model <model>
toolnet providers
toolnet routing <show|profiles|profile|model|fallback|reset>
```

`toolnet eval compare` prints success rate, coding, tool use, reliability,
latency, cost and tokens side by side, **always with the sample count**, and
refuses to declare a winner on too few samples.

`toolnet provider` remains the provider *configuration* command from Phase 79;
`toolnet providers` is the registry view.

---

## 16. Live acceptance

`src/core/models/liveAcceptance.ts` and `src/core/eval/liveAcceptance.ts`.

If `OPENROUTER_API_KEY` is present: discover models → resolve through the router
→ simple completion → streaming completion → tool-capable completion when
available → usage normalization → provider health update → one eval smoke case.

If the key is absent the probe returns:

```
ENVIRONMENT: OPENROUTER_API_KEY missing
```

and the test **skips**. It never reports a fake PASS, and it never makes a
billed call to prove it is not configured. Every failure is classified as
`CORE_RUNTIME | MODEL_COMPLIANCE | PROVIDER_PROTOCOL | ENVIRONMENT`.

The same pipeline runs against ToolNet when ToolNet credentials are configured.

---

## 17. Defect found and fixed

`instanceof OpenRouterProvider` was silently failing across the
`import`/`require` boundary in `discovery.ts`, so OpenRouter models were being
downgraded to generic discovery and lost their capability metadata. Discovery now
keys off the provider's declared `kind`/protocol rather than a fresh class
identity check. Regression covered by `openrouterRefresh.test.ts`.

---

## 18. Architecture guards (`src/core/eval/__tests__/architecture.test.ts`)

Static tests assert:

- exactly one `ModelRouter`, one `ModelCatalog`, one `ProviderRegistry` owner
- one `AgentHarness`, one `ToolRegistry` class
- `EvalRunner` never calls `provider.chat` / `provider.stream` directly
- the TUI and CLI never construct a provider for inference
- no model-specific branching in `AgentEngine`
- no hard-coded `Claude` / `GPT` / `Gemini` routing
- `/catalog` is registered in the single command registry

---

## 19. Failure tests

Model unavailable, provider unavailable, 429, 500, timeout, abort, malformed
metadata, corrupt cache, unknown pricing, unknown latency, insufficient eval
samples, missing tool capability, context too small, all candidates filtered,
and fallback exhaustion. Implemented with early returns and guard clauses rather
than nested branches.

---

## 20. Performance

`ModelRouter.resolve()` is fully local — **no network call in the hot path**.
Discovery and cache refresh are separate commands. `routingPerformance.test.ts`
asserts a routing decision over a normal catalog lands well inside the 10 ms
budget without a tight wall-clock assertion on a single sample.

---

## 21. Gates

| Gate | Result |
|---|---|
| `bun run typecheck` | PASS |
| `bun test` | **1872 pass / 3 skip / 0 fail** |
| `bun run build` | PASS (552 modules) |
| `npm pack --dry-run` | PASS (`toolnetcli@1.2.4`) |

Phase 73–79 regressions pass. Existing invariants updated deliberately, not
weakened:

- config `schemaVersion` assertions now use `CURRENT_SCHEMA_VERSION` (and assert
  the new routing defaults) instead of the literal `2`
- the slash-palette command count went 38 → 39 because `/catalog` joined the one
  registry; the test now also asserts `/catalog` is present

No timeout was raised to hide a flaky test.

---

## 22. Known limitations

- No LLM-as-judge (intentional, deferred).
- Eval history is local; no remote eval service, no billing, no distributed
  benchmark.
- `cheapest` / `fastest` degrade to neutral/insufficient-data when metadata or
  latency samples are missing — they never guess.
- The pre-Phase-79 active-provider path remains as a compatibility fallback.
- Live OpenRouter acceptance is environment-gated and reports `ENVIRONMENT` when
  no key is present rather than passing.
- Health is in-memory and resets with the process.
