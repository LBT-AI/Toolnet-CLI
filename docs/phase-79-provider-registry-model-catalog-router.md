# Phase 79 — Provider Registry + Model Catalog + Model Router

ToolNet moves from "an agent that happens to hold a ProviderAdapter" to a single
agent kernel with a canonical **ProviderRegistry**, **ModelCatalog** and
**ModelRouter** in front of it.

No new agent loop. No second tool registry. No second MCP execution path.
The provider layer selects a model and invokes it — nothing else. Tool
execution still belongs to `ToolRegistry → Permission → ToolGateway`.

## 79.0 — Architecture before / after

Before (Phase 78):

```
AgentHarness ──► getActiveProvider()   (module-level config lookup)
             └─► getActiveDefaultModel()
                     │
                 ModelAdapter ──► provider.chat()
```

Provider selection, model metadata and capability lookup were three separate
ad-hoc lookups scattered across the harness, the TUI, `simple-repl` and
`smartPlanner`, and model metadata was only whatever the active provider's
`listModels()` happened to return that session.

After (Phase 79):

```
                     AgentEngine
                          │
                     AgentHarness
                          │
                     ModelRouter                ← one router
                          │
                  ProviderRegistry              ← one registry
                     ╱    │    ╲
            OpenRouter  ToolNet  OpenAI-compatible / custom
                     ╲    │    ╱
                     ModelCatalog               ← one catalog
                          │
                  Capability normalization      ← one schema, tri-state
                          │
                   Provider health
                          │
                    Routing policy

Tool execution (unchanged, NOT the provider layer):

AgentEngine → ToolRegistry → Permission → ToolGateway → Executor → Verifier
```

The pre-existing provider abstraction (`src/providers`) is **reused**, not
replaced. `ProviderRegistry.createInstance` delegates to the original
`createProviderInstance` factory; there is exactly one instance factory in the
codebase (asserted by a test).

## 79.1 — ProviderRegistry (`src/core/models/registry.ts`)

```ts
register(registration, { replace?, skipModels? }): ProviderDefinition
unregister(id): boolean
get(id) / has(id) / list() / enabled() / ids() / size()
setStatus(id, status) / setEnabled(id, enabled) / setPriority(id, priority)
addModels(id, models) / replaceModels(id, models)
healthOf(id) / recordSuccess / recordFailure / markUnavailable / resetHealth
createInstance(id): Provider | null
resolve(modelRef): { provider, model }
modelsOf(id): string[]
```

* **One registration per provider id.** A duplicate throws
  `DuplicateProviderError`; `{ replace: true }` is the explicit override used by
  bootstrap/reload.
* **`ProviderDefinition.models` is computed, never stored.** It is read from the
  catalog on every `get`/`list`, so there is a single source of truth.
* Provider kinds: `openrouter`, `toolnet`, `openai-compatible`, `anthropic`,
  `gemini`, `custom`.
* Provider metadata carried: `id`, `name`, `kind`, `baseURL`, `authentication`
  (env var **name** + presence only), `capabilities`, `models`, `status`,
  `health`, `priority`, `enabled`, `metadata`.

## 79.2 — ModelCatalog (`src/core/models/catalog.ts`)

Keys are canonical ids `${providerId}/${apiModelId}`, so two providers can serve
the same upstream model without colliding and an id that itself contains slashes
(OpenRouter) is representable.

```ts
add / addMany / remove / removeProvider
replaceProviderModels(providerId, models)   // atomic per provider
list / listByProvider / get / has / find / filter / size
snapshotProvider(id)                        // rollback copy
onChange(listener)
```

`replaceProviderModels` builds the complete new index **before** mutating, so a
partial or failed discovery can never leave the catalog half-updated, and one
provider's failure never disturbs another's entries.

`ModelDefinition` fields: `id`, `providerId`, `apiModelId`, `displayName`,
`contextWindow`, `maxOutputTokens`, `inputModalities`, `outputModalities`,
`capabilities`, `pricing`, `limits`, `status`, `metadata`.

## 79.3 — Capability normalization (`src/core/models/capabilities.ts`)

One schema, **tri-state**:

| field | meaning when `undefined` |
|---|---|
| `tools` | unknown — do not claim the model accepts tool schemas |
| `nativeToolCalls` | unknown — adapter keeps the conservative structured path |
| `streaming`, `reasoning`, `vision` | unknown |
| `structuredOutput`, `jsonMode`, `embeddings`, `imageGeneration` | unknown |

Rules:

1. **Unknown is never promoted to `true`.** A hook or adapter that needs a
   capability checks `=== true`; `undefined` fails a requirement.
2. Only *documented* provider declaration surfaces are read (`tools`,
   `nativeToolCalls`, `supports_vision`, OpenRouter's `supported_parameters`,
   …). Nothing is inferred from a model-id substring.
3. Two derived edges exist, both from an explicit declaration: `nativeToolCalls
   === true ⇒ tools = true`, and `tools === false ⇒ nativeToolCalls = false`.

**This phase fixes the historical loss of `tools` / `nativeToolCalls`.** The
chain provider → `ModelDefinition` → adapter cache → `ModelAdapter` gate is now
lossless, and `toLegacyCapabilities` is the single, tested bridge into the
adapter's `ModelCapabilities` cache (published by
`syncAdapterCapabilities()`), so a capability discovered from a provider
actually reaches the gating decision.

## 79.4 — Model references (`src/core/models/ref.ts`)

`parseModelRef(input, { knownProviders, defaultProvider })`.

Qualification is decided by **whether the first segment names a provider we
know**, never by counting slashes:

| input | provider | model |
|---|---|---|
| `openrouter/anthropic/claude-sonnet` | `openrouter` | `anthropic/claude-sonnet` |
| `toolnet/gpt-x` | `toolnet` | `gpt-x` |
| `anthropic/claude-3-5-sonnet` (unknown first segment) | — | `anthropic/claude-3-5-sonnet` |
| `gpt-4o` | — (or `defaultProvider`) | `gpt-4o` |

Rejected as malformed (`InvalidModelReferenceError`): empty, whitespace-only,
whitespace-bearing, leading `/`, trailing `/`, `//`.

## 79.5 — OpenRouter (`src/providers/openrouter.ts`, `src/core/models/openrouter.ts`)

`OpenRouterProvider extends OpenAICompatibleProvider` — it reuses the existing
OpenAI-compatible transport (OpenRouter's chat surface is OpenAI-shaped) and adds
only the genuinely OpenRouter-specific part: `discoverModels()` against
`GET /api/v1/models`, returning raw records. Normalization lives in the model
layer, so the adapter reports what the remote said instead of deciding how the
catalog represents it.

Normalization reads `context_length`, `top_provider.{context_length,
max_completion_tokens, is_moderated}`, `architecture.{input_modalities,
output_modalities, modality}`, `supported_parameters` and `pricing`.

* Pricing is per-token strings → USD per 1M tokens, converted exactly once.
  `-1` ("not applicable") becomes `undefined`, never a negative price that would
  poison `cheapest` routing.
* Missing capability fields stay `undefined`.
* Malformed rows (no `id`) are skipped; the rest of the listing is kept.
* A non-OK response throws, so the caller preserves the previous catalog.

Default endpoint `https://openrouter.ai/api/v1`, auth `OPENROUTER_API_KEY`
(attached when present; never logged).

## 79.6 — ToolNet and generic OpenAI-compatible providers

`src/core/models/providers.ts` projects existing state into the registry:

* `registrationFromConfig(config)` maps a legacy `providers.json` entry →
  `ProviderRegistration` (`kindFromLegacyType` maps `type`/`id`).
* `openRouterRegistration(env)` is the built-in OpenRouter entry (registered
  when `OPENROUTER_API_KEY` exists, or on request).
* `bootstrapProviderRegistry()` is **idempotent** (`replace: true`,
  `skipModels: true`) and never clears discovered models — safe to call on every
  CLI/harness start.

Backward compatibility is explicit: no config migration is required, the config
file is never rewritten, environment variables keep working, and a model the
catalog cannot resolve falls back to the pre-existing active-provider lookup.

## 79.7 — ModelRouter (`src/core/models/router.ts`)

```ts
resolve(request: RoutingRequest): ResolvedModel
candidateChain(request): ModelDefinition[]
```

Selection priority: **explicit provider + model → explicit model → policy-selected
model → configured fallback chain → structured `ModelRoutingError`.**

Policies: `explicit`, `priority` (default), `cheapest`, `fastest`,
`capability-first`, `fallback`.

* Required capabilities are filtered **before** cost/priority are considered.
* Cost limit uses the blended price; an **unknown price is never treated as
  free** — it cannot be proven to exceed the limit, so it is kept, and it sorts
  last under `cheapest`.
* `fastest` uses observed EMA latency; a provider with no latency sample sorts
  last rather than first.
* Disabled providers are skipped. Providers whose health is `unavailable` are
  dropped only when a healthy candidate exists, so an explicit capability
  requirement can still be satisfied.
* **An explicitly requested model is never silently swapped.** Under a
  non-fallback policy the chain is exactly that model. The chain widens only
  when fallback is enabled (policy `fallback`, a configured policy of
  `fallback`, or a non-empty configured chain), and even then the explicit model
  stays first.
* Tie-breakers are deterministic: health rank → declared priority → model id.

## 79.8 — Bounded fallback and retry classification

```ts
invokeWithFallback(request, run, { maxAttempts, isTerminal, onAttempt, registry, router })
```

Retryable: `ProviderRateLimitError`, `ProviderUnavailableError`, HTTP 429, HTTP
5xx, timeouts, connection reset/refused, `fetch failed`.

Terminal (never retried, never falls back): `ProviderAuthError`, auth failures
(401/403), invalid request (400/422), permission denial, malformed tool schema,
cancellation/abort, and **any unclassified error** — the classifier fails
closed.

Attempts are bounded by `min(maxAttempts, candidates.length)` and every attempt
is recorded (model, provider, ok, retryable, duration) and fed into provider
health.

## 79.9 — Provider health (`src/core/models/health.ts`)

In-memory only: `requestCount`, `successCount`, `failureCount`,
`consecutiveFailures`, EMA `latencyMs`, `lastSuccessAt`, `lastErrorAt`,
redacted `lastError`.

Deterministic transitions: successes only → `healthy`; 1–2 consecutive failures
→ `degraded`; ≥ 3 → `unavailable`; any success → `healthy` again. Health never
changes an explicit user model selection unless fallback policy allows it.

## 79.10 — Configuration (backward compatible)

Existing `~/.toolnetcli/providers.json` and environment variables keep working
unchanged. The canonical view adds:

```
/toolnet routing        # policy, max attempts, fallback chain, exclusions
toolnet model set <ref> # persists AppConfig.defaultModel
```

The new `routing` block is optional and defaults to
`{ policy: "priority", fallback: [], maxAttempts: 3, excludedProviders: [] }`
(`setRoutingConfig` / `getRoutingConfig` / `resetRoutingConfig`).

## 79.11 — CLI

| command | purpose |
|---|---|
| `toolnet providers [list\|status] [--json]` | registered providers with status, model count, health, key env var + presence |
| `toolnet models [--provider <id>] [--json]` | catalog models with declared capabilities, context window, status, price |
| `toolnet models refresh [<id>]` | discover + atomically replace; a failing provider keeps its previous models |
| `toolnet model` | show the current default model |
| `toolnet model <provider/model>` | validate a reference and show its resolution (provider, capabilities, pricing, routing reason) |
| `toolnet model set <ref>` | persist the default model |
| `toolnet routing [--json]` | active routing policy and fallback chain |

`toolnet provider` remains the **config** command (`add`/`use`/`remove`/…);
`toolnet providers` is the canonical registry view.

Capability rendering is tri-state: `yes` / `no` / `unknown`. Nothing is printed
as supported unless the provider declared it. Secrets are never printed — only
the env var *name* and whether a value resolved.

Sample `toolnet providers`:

```
Providers (3)
────────────────────────────────────────────────────────────
  openrouter  kind=openrouter  status=connected  models=42  health=healthy  auth=OPENROUTER_API_KEY:set  priority=20  enabled
  toolnet     kind=toolnet     status=unknown    models=5   health=unknown  auth=TOOLNET_API_KEY:unset     priority=10  enabled
  private     kind=custom      status=failed     models=0   health=unavailable  auth=none  priority=100  enabled
      last error: HTTP 503: upstream down
```

## 79.12 — Streaming, usage and cost

Streaming is unchanged and still flows through the existing adapter: text,
reasoning, tool-call deltas, usage and finish reason are normalized once in
`ModelAdapter`. The provider layer does not emit its own event types.

Usage normalization additionally exposes `NormalizedUsage`
(`inputTokens`, `outputTokens`, `reasoningTokens`, `cachedInputTokens`,
`totalTokens`, `costUsd`). Cost is only reported when the provider supplies it —
nothing is estimated from missing pricing metadata.

## 79.13 — Structured errors (`src/core/models/errors.ts`)

Every failure carries `{ code, provider, model, retryable, cause }`:

`DUPLICATE_PROVIDER`, `PROVIDER_NOT_FOUND`, `MODEL_NOT_FOUND`,
`MODEL_CAPABILITY`, `PROVIDER_AUTH`, `PROVIDER_RATE_LIMIT`,
`PROVIDER_UNAVAILABLE`, `MODEL_ROUTING`, `INVALID_MODEL_REFERENCE`.

`toJSON()` returns a credential-free projection, and `redactSecret` scrubs
credential-shaped text (key-looking tokens, `Bearer …`) before any message is
stored in health, printed, or emitted.

## 79.14 — Agent integration

`AgentHarness` no longer looks up a provider itself. It calls

```ts
resolveRuntimeModel(options.model || this.config.model)
// → { model, provider, canonicalId?, resolved?, source: "router" | "legacy" }
```

which traverses `ModelRouter → ProviderRegistry → ModelAdapter → provider`.
Health is recorded around the single provider call (`completeModel` wraps
`completeModelOnce`) so success/failure counts are exact.

**Sentinel contract:** the runtime/harness pass the literal string `"default"`
to mean "whatever the provider defaults to". It is passed through unchanged —
reinterpreting it as "caller gave no model" would silently swap the model
actually called (and change context budgeting). Locked by a regression test.

## 79.15 — Live acceptance

`runLiveAcceptance()` performs a discovery-only probe (a public `GET`; **no
billed completion call**):

1. provider registered
2. models discovered
3. capabilities normalized
4. router resolves a discovered model
5. the same `ModelAdapter` path binds the resolved provider instance

Without `OPENROUTER_API_KEY` it returns `{ ran: false, ok: false, failureClass:
"ENVIRONMENT" }` — **skipped, never a fake pass**. Failures are classified as
`CORE_RUNTIME` / `MODEL_COMPLIANCE` / `PROVIDER_PROTOCOL` / `ENVIRONMENT`, so a
provider outage is never reported as a core regression.

## 79.16 — Architecture guards (enforced by tests)

* Exactly one `ProviderRegistry`, `ModelCatalog` and `ModelRouter` class exists
  in production sources, and the barrel hands back the same singletons.
* Exactly one `createProviderInstance` factory.
* `AgentHarness` calls `resolveRuntimeModel(` and does **not** call
  `getActiveProvider(`.
* No `provider.chat(` / `provider.stream(` in `src/tui/**` or `simple-repl.ts`.
* The model layer does not import `agentHarness` / construct `AgentHarness`.
* The model layer does not reference `toolRegistry` / `executeToolBatch` /
  `toolGateway` — it never executes tools.

## 79.17 — Test matrix

Unit: reference parsing (including slash-bearing ids and malformed input),
capability normalization (tri-state, tool preservation, aliases, OpenRouter
`supported_parameters`), catalog (dedup, provider isolation, atomic replace,
snapshot), registry (register/duplicate/unregister/lookup/list, health, models),
health (success/degraded/unavailable/recovery/EMA/redaction), router (explicit
model, explicit provider, capability filtering, priority/cheapest/fastest/
capability-first, exclusions, disabled, cost limit, no candidate, cancellation,
determinism), fallback (retryable vs terminal classification, bounded attempts,
health recording), OpenRouter (normalization, malformed response, `-1` pricing,
auth failure, redaction), discovery (atomic replace, preservation on failure,
empty listing, provider isolation, disabled skip), CLI (tri-state rendering,
JSON, key redaction, unknown provider/subcommand).

Integration: provider→catalog→router→adapter capability preservation through the
legacy bridge; `resolveRuntimeModel` resolving through the router; degradation to
the legacy path; the `"default"` sentinel; credential-gated live probe.

## 79.18 — Gate results

| Gate | Result |
|---|---|
| `bun run typecheck` | PASS |
| `bun test` | **1711 pass / 3 skip / 0 fail** — 1714 tests, 125 files |
| `bun run build` | PASS (535 modules, 2.15 MB) |
| `npm pack --dry-run` | PASS (`toolnetcli@1.2.4`, 6 files) |

Added tests: **126** (114 unit/integration + 12 CLI), taking the suite from 1588
to 1714.

Skipped (environment-gated, not passes): the clean-HOME TUI smoke test, the
`REAL MODEL E2E` compliance test, and the Phase 79 live OpenRouter probe —
the last one because `OPENROUTER_API_KEY` is not present in this environment.

**Pre-existing wall-clock sensitivity (not a Phase 79 regression).** Two
full-suite runs during development each produced exactly one failure, in a
*different* wall-clock-sensitive test each time:

* `B2 Twin Portal elapsed-time banner > animates through elapsed time and
  restores the cursor exactly once` — a real 100 ms frame timer in a 3 s budget.
* `Native Anthropic Provider > translates OpenAI tools to Anthropic format and
  parses response` — a real `Bun.serve` loopback round trip against a provider
  request timeout.

Both pass in isolation (`bun test src/banner/__tests__`,
`bun test src/providers/__tests__`), and two subsequent full runs were clean
(1711 pass / 0 fail). The phase adds 126 tests (~2.5 s of suite wall time), which
makes these pre-existing timers more likely to be squeezed. **No timeout was
raised to hide them**, and neither test is touched by this phase.

Phases 73–78 regression suites all pass, including `context.test.ts` and
`layer4Phase0Baseline.test.ts`, which caught a real regression during
development: interpreting the `"default"` sentinel as "no model given" swapped
the effective model and changed context budgeting. The fix is the passthrough
described in §79.14 plus a dedicated regression test.

## Known limitations

* **Live OpenRouter acceptance is unverified in this environment** — no
  `OPENROUTER_API_KEY` is present, so the credentialed probe is skipped. The
  discovery code is covered by stubbed-fetch tests and the probe is wired and
  ready; it is not claimed as passed.
* **No billed completion in the live probe.** Step 6 of the acceptance intent
  ("response returns") is intentionally not exercised automatically, because
  that would spend the operator's credit without consent. It runs under
  `runLiveCompletion`-style tests only when explicitly invoked.
* **Health is in-memory**, reset every process. No persistence, no cross-process
  sharing, no circuit breaker — deliberate for this phase.
* **`cheapest`/`fastest` need metadata.** Models whose provider declares no
  pricing or which have no latency sample sort last rather than being guessed;
  routing may therefore prefer a less-optimal but better-described model.
* **The legacy active-provider path still exists** as a fallback for references
  the catalog cannot resolve. It is a compatibility path, not a second router,
  and it is asserted to be the only remaining direct provider lookup.
* **`toolnet model set` requires the model to be in the catalog**, i.e.
  discovery must have run (`toolnet models refresh`). References are validated,
  never stored unchecked.
* **No eval/benchmark, harness adapters, or OpenCode/Claude-Code/Codex
  compatibility** — explicitly deferred to a later phase, along with MCP, DAG,
  plugin, LSP and permission changes.
