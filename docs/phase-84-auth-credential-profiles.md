# Phase 84 — Auth + Credential Profiles + Multi-Account Provider Identity

Handoff document. Read this before touching provider auth, provider keys, or
external-harness credential injection.

## 1. Baseline

| Item | Value |
| --- | --- |
| Repository | `/root/toolnet-cli` (GitHub `LBT-AI/Toolnet-CLI`) |
| Branch at start | `main`, clean worktree |
| Phase 83 commit | `119569f0b468756a9c7369c092c47dc6f27e2d9b` — *feat(harness): add external harness interoperability* |
| Phase 82 commit | `52bc32e` — *feat(models): add provider routing intelligence and bounded multi-upstream fallback* |
| Baseline gates | typecheck PASS · `bun test` 2121 pass / 3 skip / 0 fail · build PASS · `npm pack --dry-run` PASS |
| Phase 84 commit | see §14 (recorded after the gates pass) |

## 2. Source references actually inspected

| Reference | Verdict | What was taken |
| --- | --- | --- |
| `anomalyco/opencode` → `packages/opencode/src/auth/index.ts` | **ADAPT** | auth as a separate service, provider-keyed lookup, config/auth separation, don't put secrets in config. NOT copied: OpenCode stores ONE credential per provider; ToolNet needs named multi-account profiles. |
| `anomalyco/opencode` → `provider/provider.ts` + `session/llm.ts` | **ADAPT** | auth resolution stays OUTSIDE the provider instance; providers receive only the resolved secret for a call. |
| `anomalyco/opencode` → `cli/cmd/mcp.ts` | **NOT_APPLICABLE (architecture)** / ADAPT (UX) | only the `needs_auth` / `logout` / `status` UX vocabulary. MCP credentials stay in the Phase 78 store — never merged with provider credentials. |
| OpenRouter OAuth PKCE docs (`openrouter.ai/docs/guides/overview/auth/oauth`) | **REPLACE (protocol authority)** | the exact flow implemented here: `/auth?callback_url&code_challenge&code_challenge_method=S256`, headless `key_label` form with an on-screen code, `POST /api/v1/auth/keys` → `{key}`. Notably: **no state parameter and no refresh token** — modeled faithfully (see §7). |
| OpenRouter exchange endpoint reference | **KEEP** | 400/403/405 error semantics surfaced verbatim; code is single-use and expires in 10 minutes. |
| ORI install/login skill (`OpenRouterTeam/skills`) | **ADAPT** | login UX direction (`ori login`, `--no-browser`, existing `OPENROUTER_API_KEY` respected). NOT coupled: no ORI binary dependency. |
| Existing ToolNet primitives | **KEEP** | Phase 78 MCP store pattern (0600, atomic, lockdown, quarantine), `redactSecret` in `core/models/errors.ts`, `scrubChildEnv`, `getToolnetHome`, the Phase 81/82 appConfig section pattern. |
| `src/lib/auth.ts` | **NOT_APPLICABLE** | this is the legacy *gateway session token*, unrelated to provider credentials. Provider auth is a genuinely new layer, not a parallel abstraction. |

## 3. Files changed

New (all production code):

```
src/core/auth/types.ts            typed credentials, AuthProfile, status view
src/core/auth/errors.ts           profile-id validation + §23 structured errors
src/core/auth/credentialStore.ts  THE CredentialStore (0600, atomic, locked)
src/core/auth/registry.ts         THE AuthProfileRegistry (metadata + active)
src/core/auth/resolver.ts         THE CredentialResolver (precedence + redaction)
src/core/auth/legacy.ts           keys.json compatibility adapter (read-only)
src/core/auth/operations.ts       shared CLI/TUI facade
src/core/auth/context.ts          session auth pin context
src/core/auth/openrouterOAuth.ts  PKCE S256 + loopback + exchange
src/core/auth/login.ts            login orchestration (store-nothing-on-failure)
src/core/auth/harnessInjection.ts auth → external-harness credential bridge
src/core/auth/index.ts            barrel
src/commands/authCli.ts           toolnet auth <...>
```

Tests: `src/core/auth/__tests__/{credentialStore,resolver,openrouterOAuth,cliSecurity,architecture,liveAcceptance}.test.ts`

Modified:

| File | Change |
| --- | --- |
| `src/providers/registry.ts` | `resolveApiKey()` now delegates to the CredentialResolver; accepts optional `explicitProfile`/`sessionProfile`. No `process.env[...]` key reads remain in the provider layer. |
| `src/lib/appConfig.ts` | new `auth` section (`profiles`, `active`) — the canonical config owner; no second config file. |
| `src/lib/session.ts` | §15 session auth pinning (`authProfiles` map of **ids only**) + bridge wiring for `core/auth/context`. |
| `src/lib/toolnetHome.ts` | `auth-credentials.json` added to the 0600 hardening set (defense-in-depth). |
| `src/core/models/errors.ts` | bounded dynamic resolved-secret registry feeding `redactSecret`. |
| `src/core/externalHarness/{types,process,runner}.ts` | `credentialEnvAllowlist` declaration + explicit `credentialEnv` injection applied *after* `scrubChildEnv`, validated per adapter, never in argv. |
| `src/core/externalHarness/adapters.ts` | per-adapter credential env declarations (opencode/codex/claude); Hermes declares none. |
| `src/commands/harnessCli.ts` | `harness external run --auth-profile provider/profile`. |
| `src/lib/harnessCatalog.ts` | read-only `Auth Profiles` TUI section. |
| `src/index.tsx` | `toolnet auth` wired into dispatch + usage. |

## 4. Architecture before → after

Before:

```
ModelRouter → ProviderRegistry → createProviderInstance(config)
                                     └─ resolveApiKey(config)
                                          env → inline config → keys.json
```

After:

```
                          ProviderRegistry
                                │
                        CredentialResolver        ← ONE resolution path
                                │
                       AuthProfileRegistry         ← metadata/active (no secrets)
                                │
                         CredentialStore           ← 0600, atomic, locked
                          /     │      \
                       env   api_key  oauth_exchanged_key

ExternalHarnessRunner ──(explicit --auth-profile only)──► sanitized env
```

The provider layer emits no inference/route decision changes: **routes (Phase 82)
are not credentials**, and a credential is not a route.

## 5. Canonical owners

| Concern | Owner | Singleton |
| --- | --- | --- |
| Secret payloads | `CredentialStore` (`src/core/auth/credentialStore.ts`) | `credentialStore` |
| Profile metadata + active pointer | `AuthProfileRegistry` | `authProfileRegistry` |
| Precedence + secret access | `CredentialResolver` | `credentialResolver` |
| CLI/TUI facade | `AuthOperations` | `authOperations` |
| Session pin (ids only) | `core/auth/context.ts` + session metadata | — |
| Provider key resolution | `providers/registry.ts` delegates to the resolver | — |

## 6. Credential types (§4)

```ts
type CredentialType = "env" | "api_key" | "oauth_exchanged_key";
EnvCredential              { type: "env", envName }                    // no secret stored
ApiKeyCredential           { type: "api_key", secret }
OAuthExchangedKeyCredential{ type: "oauth_exchanged_key", secret,
                             oauthProvider, userId?, obtainedAt }
```

Deliberately closed. No generic arbitrary-header credential exists.

## 7. Resolver precedence (§8) — the contract

1. **explicit request profile** (`--auth-profile`, resolver call)
2. **session pin** (session metadata `authProfiles[providerId]`)
3. **active profile** for the provider
4. **environment** (a registered env profile reading that var, else the provider's standard var)
5. **legacy compat**: `keys.json` (via `legacy.ts`), inline provider config `apiKey`
6. **unavailable** → structured `CredentialUnavailableError`

Rules:

- An explicitly named profile that is unknown/unusable is **terminal** — no
  silent fallthrough to `OPENROUTER_API_KEY` (test: *"an explicitly requested
  profile that has no credential is TERMINAL"*).
- A malformed explicit profile id is terminal too.
- Provider ids outside the profile charset degrade to `unavailable` — the
  provider layer never throws because of auth bookkeeping.
- Env values are read at call time: rotating `OPENROUTER_API_KEY` takes effect
  immediately and nothing is copied into the store.

## 8. OpenRouter OAuth (§11/§12)

Flow (as implemented in `openrouterOAuth.ts` + `login.ts`):

1. `generatePkce()` → random verifier (`randomBytes(48)`, base64url) and
   `base64url(SHA-256(verifier))` challenge.
2. `generateState()` → random, one-time state.
3. Loopback mode: `startLoopbackServer()` binds **127.0.0.1 only** on an
   ephemeral port; the state lives in the **path** (`/callback/<state>`) so the
   provider's `?code=` append cannot corrupt it. Headless mode: documented
   `key_label` form, code pasted at a prompt.
4. `PendingFlowRegistry.consume(state)` validates **before** the exchange and is
   single-use (a consumed or expired flow can never complete again).
5. `exchangeCodeForApiKey()` POSTs `{code, code_verifier, code_challenge_method}`
   to `https://openrouter.ai/api/v1/auth/keys` → `{key}`.
6. Only then: `store.set(profileId, ...)` → `profiles.register(...)` →
   optionally `setActive(...)`.

Failure guarantees (each covered by a test): state mismatch, exchange failure,
callback timeout and malformed responses all **store nothing** — no credential,
no profile, no active pointer.

Because OpenRouter returns a user-controlled **API key** (no refresh token), the
credential is `oauth_exchanged_key` and is never described as refreshable.

## 9. Storage

| Property | Value |
| --- | --- |
| Path | `$TOOLNETCLI_CONFIG_DIR/auth-credentials.json` (default `~/.toolnetcli/auth-credentials.json`) |
| Mode | `0600`, re-asserted on every write and repaired on load; broadenings reported by `doctor` |
| Atomicity | temp file + `rename`, temp removed on failure; no `.tmp-*` leftovers |
| Serialization | all mutations run through a single promise queue (`withLock`); `set`/`remove` are sync-persisting and therefore atomic under the single-threaded runtime |
| Symlink | a symlink planted on the store path is **refused** |
| Corruption | quarantined to `<path>.corrupt-<ts>`, warn (contents never logged), start empty, never silently overwritten |
| Migration | none needed — nothing is copied out of env or the legacy store |

Path resolution is **lazy** (first use), so the canonical singleton follows the
`TOOLNETCLI_CONFIG_DIR`/HOME in effect at runtime — the same behavior as the
config owner. `CredentialStore.resetCache()` exists for tests and doctor flows.

Session pinning stores **only** `{ providerId: profileId }` in session metadata;
no secret is ever written to a session.

## 10. Redaction (§19)

`credentialResolver` registers every secret it hands out with the bounded
`resolvedSecrets` set in `core/models/errors.ts`, and `redactSecret()` scrubs
exact matches everywhere text flows (provider errors, health, discovery, cache
errors, auth errors, external-harness events/results). Pattern redaction remains
as a second line for keys ToolNet never resolved. Normal model ids are not
over-redacted (asserted).

## 11. External harness integration (§18)

- Default: an external harness uses **its own** auth. ToolNet injects nothing.
- Injection requires an explicit `--auth-profile provider/profile`.
- The target env name must be the provider's canonical variable **and** be
  declared in the adapter's `credentialEnvAllowlist`; otherwise
  `HarnessCapabilityError`.
- The value is applied *after* `scrubChildEnv` (which deliberately denies
  secret-shaped names), never placed in argv, never logged, and the harness'
  own config is never modified.
- Declarations: opencode → `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`; codex → `OPENAI_API_KEY`; claude → `ANTHROPIC_API_KEY`;
  hermes → none (no verified contract).

## 12. CLI / TUI

```
toolnet auth list
toolnet auth status [<provider>]
toolnet auth login openrouter [--no-browser] [--profile <name>]
toolnet auth add <provider> --profile <name> [--env <VAR>] [--secret-stdin]
toolnet auth use <provider>/<profile>
toolnet auth logout <provider>/<profile>
toolnet auth remove <provider>/<profile> --yes
toolnet auth doctor
```

- A key is **never** accepted as an argument (`--key` is refused with an
  explanation); entry is a hidden raw-mode TTY prompt, or one line from stdin
  only when `--secret-stdin` is explicitly passed.
- `--env VAR` registers an env-backed profile and stores no secret.
- TUI: a read-only `Auth Profiles` section in the harness panel
  (`harnessCatalog.ts`) showing provider → source/active and a
  "never — ids and sources only" note. The TUI never resolves a credential.
- `doctor` checks the store path, filesystem mode, quarantine state, per-provider
  status and env-only providers. It performs no billed call and prints no secret.

## 13. Defects found during this phase

| # | Defect | Fix |
| --- | --- | --- |
| 1 | A key inside a `cause` chain could reach `error.message` | `AuthError` redacts `message` on construction; tested. |
| 2 | `resolveApiKey` was the only secret reader but had no profile awareness | Delegated to the resolver; provider layer now has **zero** env reads. |
| 3 | The canonical store bound its path at construction, so a mid-process config-dir change (tests, embedded use) would write to the wrong home — observed as cross-test leakage into `~/.toolnetcli` | Lazy path resolution + `resetCache()`; tests verified no writes outside the temp dir. |
| 4 | Credential injection could not survive `scrubChildEnv` (by design), so an explicit profile would have been silently dropped | Deliberate post-scrub injection step gated on the adapter declaration. |
| 5 | The loopback callback had no test coverage for an *unknown path* attacker callback; the server would wait silently | Documented and tested (404 + flow times out + stores nothing). |
| 6 | `searchParams`-based state would be lost if the provider reconstructed the callback URL | State carried in the path, with an additional query-state check when present. |

## 14. Gates

```
bun run typecheck        PASS
bun test                 2212 pass / 3 skip / 0 fail   (3 clean full runs)
src/core/auth/ suite     91 pass / 0 fail               (5 consecutive clean runs)
bun run build            PASS
npm pack --dry-run       PASS
```

The 3 skips are the pre-existing Phase 7 / real-model E2E / Phase 79 live
OpenRouter skips — unchanged by this phase, no timeout was raised.

Regression: Phase 73–83 suites all pass unchanged.

Live acceptance:

| Check | Result |
| --- | --- |
| `OPENROUTER_API_KEY` environment source recognized, not persisted | exercised (asserts the honest "unavailable" answer when unset) |
| Billed/network OAuth smoke | **ENVIRONMENT skip** — requires `TOOLNET_AUTH_LIVE_TEST=1`; no key present in this environment |
| Interactive browser OAuth | manual by nature; the full loopback+exchange path is covered by a real-HTTP test with an injected exchange |

Classification: all skips are **ENVIRONMENT**, none is reported as a pass.

## 15. Known limitations

- No keychain/OS-vault backing; secrets live in a 0600 file (matching the Phase 78
  MCP store). This is deliberate for Phase 84.
- No credential rotation, no account cycling on 401/403 (explicitly out of scope:
  ToolNet must not evade rate limits by switching accounts).
- OAuth live verification is manual; the exchange is not run against the real
  endpoint in CI.
- `toolnet auth login` is implemented for OpenRouter only; `auth add` supports any
  provider with an env contract.
- Profile metadata lives in the app config; its existing file mode is 0644 (only
  the secret store is 0600). Profile metadata contains no secrets.
- The external-harness injection allowlist is a static per-adapter declaration —
  adding a new harness requires declaring its credential env names explicitly.

## 16. Phase 85 integration points

- `credentialResolver.lookup()` already accepts `sessionProfile`; any richer
  session/agent identity work should pass ids through it rather than reading the
  store.
- `AuthOperations` is the intended facade for new surfaces (web/daemon/IDE).
- `registerResolvedSecret` / `clearResolvedSecret` are the hooks for any new
  output channel that needs redaction.
- If OS keychain support is added later, implement it behind `CredentialStore` —
  do not add a second store.

## 17. Commit

`feat(auth): add credential profiles and provider authentication`

Exact hash and push status are recorded in the final report for this phase.
