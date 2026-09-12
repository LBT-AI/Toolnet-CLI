# Phase 82 — Provider Intelligence + Multi-Upstream Routing

Status: **DONE** · Baseline: `6dafe39` (Phase 81) · Schema: routing-intelligence v1

## What changed

Phase 79/80 decided **which model** to use. Phase 82 adds the missing half of
the routing decision: **which provider/upstream serves that model**, with the
same guarantees — deterministic, bounded, evidence-based, no secrets.

```
AgentHarness
  → ModelRouter
      ├─ model selection        → RoutingProfile (Phase 80)     [unchanged]
      └─ provider/upstream choice → ProviderRoutingPolicy (NEW)
            → resolveProviderRoutes   (guard-clause filters)
            → scoreRoute              (deterministic scorer)
            → invokeRouteChain        (bounded fallback)
  → ProviderRegistry → ModelAdapter → provider
```

One router, one registry, one catalog — no second runtime. The tool path
(`ToolRegistry → Permission → ToolGateway`) is untouched.

## 1. ProviderRoute (`route.ts`)

```
LOGICAL MODEL   anthropic/claude-3.5-sonnet
  ├─ ROUTE openrouter :: together     → routeId openrouter::together::anthropic/claude-3.5-sonnet
  ├─ ROUTE openrouter :: default
  └─ ROUTE toolnet    :: default
```

- `routeId = providerId::upstreamId::apiModelId` (lower-cased ids; model id
  preserved because OpenRouter ids contain slashes).
- Upstream identity is **declared only** (`metadata.upstream*` on the model or
  provider); when a provider does not publish it, the route is
  `providerId::default::apiModelId`. Never inferred.
- Routes are a derived read-only projection over `ModelCatalog +
  ProviderRegistry` — a model is NOT duplicated per upstream in the catalog.
- `logicalKey` (exact, trimmed, lower-cased apiModelId) is the
  provider-independent identity; there is deliberately no prefix/fuzzy
  matching.

## 2. Candidate resolution (`routeResolver.ts`)

`resolveProviderRoutes(request, options)` — deterministic, guard clauses in
order, every removal recorded as a typed `RouteRejection`:

```
provider-denied → provider-not-allowed → provider-disabled → unknown-model
→ model-disabled → missing-capability → context-insufficient
→ price-constraint → provider-unavailable → score → tie-break
```

Two explicit soft relaxations (recorded in `relaxed[]`, never silent):

- **unknown ≠ violation** — a route whose context/price metadata is unknown is
  kept; unknown is not proof of a constraint breach.
- **unavailable pool relaxation** — if the hard filters would leave nothing but
  every survivor is merely marked `unavailable`, the pool is retained and the
  relaxation reported, so routing degrades observably instead of failing on a
  catalog that looks healthy but is fully down.

Reference matching (§9): canonical `provider/model` → that exact model; bare
id → every provider serving the identical native id (exact match only);
`request.provider` pins one provider.

## 3. ProviderRoutingPolicy (`providerPolicy.ts`)

| Policy              | Weights                                   |
|---------------------|-------------------------------------------|
| `priority`          | priority                                  |
| `cheapest`          | cost                                      |
| `fastest`           | latency                                   |
| `balanced`          | priority + cost + latency + reliability   |
| `reliability-first` | reliability ×3 + latency                  |

No policy names a vendor. Constraints (hard, pre-score): `allowProviders`,
`denyProviders` (wins over allow), `maxInputPrice`, `maxOutputPrice`,
`minContextLength`, `requiredCapabilities`, `allowFallback`.

An explicit request policy (`cheapest`/`fastest`/…) governs the **provider
layer too** — `routing explain --policy cheapest` and a real request select
identically. Provider-pinning model policies (`explicit`, `fallback`,
`capability-first`) map to the configured provider policy.

## 4. Scoring (`routeScoring.ts`)

`scoreRoute` → weighted mean of normalized 0..1 components
(`priority`, `cost`, `latency`, `reliability`), all weights owned by the policy.
Unknown inputs are **NEUTRAL (0.5)** — never best, never worst: undeclared
pricing is not free, missing latency samples are not fast.

Ordering (`compareRoutes`) — the **policy score is primary**:

1. policy score (so `cheapest` really is cheapest, `fastest` really fastest)
2. provider health rank
3. declared provider priority (tie-break)
4. providerId → upstreamId → apiModelId (lexical, total order)

This ordering was changed **during this phase**: the eval caught that declared
priority outranked the policy score, which made `cheapest`/`fastest` dead
policies whenever priorities differed. Priority is now a tie-break, not a
trump card.

## 5. Failure classification (`failureKind.ts`)

One table: `kind → { retryable, affectsHealth }`.

| Kind | Retryable | Affects health |
|------|-----------|----------------|
| rate-limit, timeout, network, server, unavailable | yes | yes |
| auth | no | **yes** |
| bad-request, permission, cancelled, schema, unknown | no | no |

Auth is provider-attributable (stale credentials live on the provider side of
the contract); permission/cancellation/bad-request are caller faults and can
never degrade a provider's health. This classification feeds both the fallback
executor and health recording, so "do not retry this" is cleanly separated
from "do not learn from this".

## 6. Performance intelligence (`routePerformance.ts`)

Per route: sample count, success/failure/caller-fault counters, latency EWMA +
bounded ring (20) + median, TTFT EWMA, derived success rate.

- `ROUTE_LATENCY_MIN_SAMPLES = 2` before observed latency is trusted;
- `ROUTE_METRIC_TTL_MS = 6h` — stale records decay to unknown (withheld, not
  zeroed);
- non-finite input is discarded, never recorded;
- serialization (`toJSON`) is numbers and ids only — no prompt/response
  content by construction.

## 7. Bounded fallback (`router.invokeRouteChain`)

- each route **at most once** per request (`maxAttempts = min(config, routes)`);
- only retryable kinds advance the chain (429, 5xx, timeout, network,
  unavailable) — auth, 400/422, permission, cancellation, schema are terminal;
- the caller's `AbortSignal` is checked before every attempt and passed into
  the attempt;
- a partially streamed turn is **terminal** (the consumer already saw output —
  replaying it on another provider would duplicate content);
- health + route performance are recorded from every real outcome, via the
  shared classifier;
- `invokeWithFallback` is a thin wrapper over the same executor — there is no
  second fallback implementation.

The harness (`agentHarness.ts`) walks the resolved route chain for every model
call: single-route chains take the pre-Phase-82 path verbatim (identity path);
multi-route chains engage the bounded executor and emit `agent:routing` events
for each provider switch.

## 8. Decision evidence (`ModelRouter.explain`)

`explain(request)` returns the full decision with **no provider call, no health
mutation, no billing**: selected route, ordered candidates, per-route scores
with component breakdown, complete rejection list, relaxations, the exact
fallback chain that production `resolve()` would attempt (head + configured
fallback refs + ranked-pool fill, gated by `providerFallbackEnabled()`),
human-readable reasons, and the logical model key.

Chain filtering guarantee (found by the eval): a route the policy layer
rejected (allow/deny, disabled, capability, context, price) can never appear in
the decision chain via the model-selection merge — fallback cannot be used to
bypass constraints.

Multi-upstream resolution: a bare model id served by several providers is the
**supported** case — the best provider is chosen deterministically (health →
priority → id) and the alternates stay reachable in the chain. The previous
"ambiguous" error is gone; `toolnet/openrouter` model ids remain canonical
unambiguous references.

## 9. Persistence (`routingIntelligence.ts`)

`~/.toolnet/cache/routing-intelligence.json`, schema v1:

- **never persisted**: API keys, prompts, responses, headers, auth data;
- atomic write (temp + rename), mode 0600, cache dir 0700;
- corrupt/invalid file → quarantined (`.corrupt-<ts>`), never thrown;
- stale records dropped on load (decay), tracker pruned to the TTL;
- best-effort: persistence failure can never fail a request or CLI read.

Wiring: hydrated once per process at model-layer import; snapshotted after
every real multi-route invocation from the harness.

## 10. OpenRouter specialization (`openrouter.ts`)

Upstream/provider metadata published by OpenRouter is normalized into route
metadata **declared-only**: missing fields stay `unknown`, never guessed into
`true`/`0`/free. Discovery failure keeps the stale-but-valid cache; a failed
refresh can never erase another provider's catalog (Phase 80 cache isolation).

## 11. CLI (`toolnet routing …`)

| Command | Behavior |
|---------|----------|
| `routing status` | profile, model policy, provider policy, fallback toggle, chain, exclusions, available profiles/policies |
| `routing explain <model>` | full dry decision: selected route, scores, rejections, relaxations |
| `routing providers <model>` | every route that could serve the model, with health/price/context |
| `routing simulate <model> --policy <name>` | alternative-policy dry decision — no provider call, no health mutation, no billing |

All output is secret-free (no keys, no auth headers). The TUI catalog panel
consumes the same `routingView` projection read-only — no duplicated routing
logic.

## 12. Routing eval (`src/core/eval/routingEval.ts`)

20 deterministic cases run against **the production router** (real resolver,
scorer, health model, classifier — isolated registries, no network, no
billing): healthy-vs-unhealthy, cheapest/unknown-price, fastest/insufficient
samples, capability/context/price filters, deny/allow lists, disabled
provider/model, unknown + fuzzy-reference rejection, multi-upstream, fallback
chain ordering, fallback veto, all-filtered, unavailable-pool relaxation,
lexical tie-break.

The eval is hermetic (`activeProviderId: () => null`) — it can never be
hijacked by ambient config, and it never mutates the process-wide routing
config or the live catalog.

## 13. Live acceptance (§15)

`runLiveAcceptance` extended with the §15 dry-routing step: after discovery it
inspects provider candidates and records the dry decision evidence
(`providerCandidates`, `fallbackChain`, `dryDecision`). Still **zero billing**
unless `TOOLNET_LIVE_BILLED_TEST=1`. Without `OPENROUTER_API_KEY` it returns
`ENVIRONMENT` skip — explicitly not a pass.

## Defects actually found and fixed (§17)

The routing eval was run as a defect hunt, not written to pass:

1. **Policy score was not primary** — declared priority outranked the score, so
   `cheapest`/`fastest` were dead policies. Fixed in `compareRoutes`; the eval
   and unit tests now assert `cheapest really wins`.
2. **`explain` fallback chain wrong** — it reported *every candidate* as the
   fallback chain, diverging from production `resolve()`. Fixed to mirror the
   production chain (head + configured refs + pool fill, same enable gate).
3. **Explicit pin ignored `requiredCapabilities`** — a pinned model missing a
   required capability was silently returned instead of raising
   `ModelCapabilityError`. Fixed: pin is a pin, not a capability waiver.
4. **Rejected routes leaked into the decision chain** — the model-selection
   merge could re-introduce a provider the route policy excluded (e.g.
   allow-list), so fallback could bypass constraints. Fixed with a chain
   filter over recorded rejections.
5. **"Ambiguous model" regression vs §1/§9** — a bare id served by several
   providers threw instead of routing. Fixed: deterministic best-provider
   head, alternates in the chain.
6. **Eval hermeticity** — the routing eval read the ambient active provider
   and could be hijacked by developer config. Fixed.
7. **Dead persistence module** — `routingIntelligence.ts` was exported but
   never wired (the Phase 77.12 anti-pattern). Fixed: hydrate at model-layer
   load, snapshot after real multi-route invocations.

## Test matrix & gates

- 23 new unit tests (`providerRouting.test.ts`): route identity, policies,
  failure classification, performance boundedness/serialization, scoring
  neutrality + determinism, resolver guard clauses, §17 regressions.
- 6 routing-eval tests, 20 built-in cases.
- Live acceptance: `ENVIRONMENT` skip (no `OPENROUTER_API_KEY` in this
  environment) — classified, not faked.

Gates on the final revision:

```
bun run typecheck   PASS
bun test            2067 pass / 3 skip / 0 fail  (3 consecutive clean runs)
bun run build       PASS
npm pack --dry-run  PASS
```

Phase 73–81 regressions included in the full suite. No timeout was raised.

## Known limitations

- Health/performance are per-process + persisted snapshot; no cross-device
  sharing.
- TTFT is recorded only when the transport reports a first-token signal.
- Upstream metadata only as rich as providers publish (OpenRouter's listing
  endpoint publishes no per-upstream identity → routes are `::default::`).
- No provider-level circuit breaker yet (unavailable detection is consecutive
  failures only).
- Live billed routing verification requires explicit opt-in
  (`TOOLNET_LIVE_BILLED_TEST=1`) and is not exercised in CI.
