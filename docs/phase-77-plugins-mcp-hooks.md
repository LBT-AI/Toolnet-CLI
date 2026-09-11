# Phase 77 — Plugin System, Hook Lifecycle, MCP

Phase 73 (Agent Core), 74 (LSP), 75 (Scoped Subagents) and 76 (Background +
Teamwork DAG) were already green. Phase 77 adds **extension surfaces** without
adding an execution path: plugins and MCP servers contribute tools and hooks to
the existing kernel, and nothing else.

```
plugin module / MCP server
        │
        ▼
  PluginRuntime / McpManager      ← one of each; load + normalize only
        │
        ▼
  toolRegistry (canonical)        ← ONE registry, dynamic entries owner-scoped
  hookRegistry (canonical)        ← ONE hook table
        │
        ▼
  ToolGateway  ── permission ──► _executeToolRaw ──► registry entry ──► plugin handler
        │                                              │                  or MCP client.callTool
        │                                              ▼
        │                                        ToolResult (normalized)
        ▼
  Agent Engine (AgentHarness)     ← the ONE loop, unchanged
```

The model-visible tool set is exactly `toolRegistry.schemas()`. Plugins and MCP
servers register *into* it, so the TUI no longer concatenates a second list.

---

## 1. Hook lifecycle (`src/core/hooks`)

`types.ts` declares the canonical contract:

| Concept | Values |
|---|---|
| `HookName` | `agent.start/end`, `model.before/after`, `tool.before/after/error`, `file.beforeWrite/afterWrite`, `shell.before/after`, `session.start/end`, `background.started/completed`, `teamwork.node.before/after` |
| `HookClass` | `observe` (telemetry), `transform` (may rewrite payload), `block` (may veto) |
| `HookDecision` | `{action:"continue"}` · `{action:"deny", reason}` · `{action:"transform", args}` |
| `HookFailurePolicy` | `ignore` · `warn` · `block` (fail closed) |

**Class is declared by the registry table, not by the plugin.** A plugin cannot
downgrade `tool.before` to an advisory hook, and an `observe` hook that returns
`deny` or `transform` is ignored with a warning rather than silently obeyed.

`registry.ts` provides the single `HookRegistry`:

* execution is **strictly sequential** in registration order (`priority`
  ascending, ties keep load order via stable sort) — `Promise.all` is never used
  because hooks mutate a shared payload;
* every hook is bounded by a timeout (`HOOK_TIMEOUT_MS`, 5s;
  per-registration override);
* `unregisterOwner(owner)` removes exactly one plugin's hooks;
* `run()` returns a `HookRunReport` carrying `completed`, `failures`, `skipped`
  and `deniedBy` plus the **final payload** — callers must adopt
  `report.output`, never a local variable, or a transform would be skipped.

Failure semantics: `observe`/`transform` edges default to `warn`; the
pre-execution edges (`tool.before`, `file.beforeWrite`, `shell.before`,
`teamwork.node.before`) default to **`block`**, so a security hook that throws
denies the operation instead of silently becoming a no-op.

### Where hooks actually fire

| Edge | Fired from | Class |
|---|---|---|
| `tool.before` | `ToolGateway.execute` (before the permission decision) | block |
| `shell.before` | `ToolGateway.execute` (shell-class tools) | block |
| `tool.after` | `ToolGateway.execute` (success **and** cache hits) | transform |
| `tool.error` | `ToolGateway.execute` (non-zero exit or executor throw) | observe |
| `file.afterWrite` | `ToolGateway.execute` (file-mutating tools) | transform |
| `agent.start` / `agent.end` | `AgentHarness.executeLoop` (the one loop entry) | observe |
| `background.started` / `background.completed` | `BackgroundJobService.launch` / `settle` (detached) | observe |
| `session.end` | TUI `shutdownAndExit` (bounded teardown) | observe |

Everything else in the `HookName` union is declared in the contract but has no
call site yet — deliberately, per the phase brief. Declaring them makes the
contract stable for plugin authors; wiring them is a one-line change once a
single authoritative edge exists.

`agent.start`/`agent.end` are fired in the **harness**, not per front-end, so
every entry point (TUI, headless, subagent, teamwork node, REPL) reports exactly
one start/end pair and none can forget or double-report it.

Ordering guarantee for `tool.*`: because `tool.before` runs *before*
`securityEngine.evaluate`, a hook veto means no permission evaluation and no
process — and a `transform` hook's rewritten args are what the security engine
actually evaluates.

---

## 2. Plugin contract (`src/core/plugins`)

```ts
interface PluginDefinition {
  id: string;
  name?: string;
  version?: string;
  compatibleToolNet?: string;          // semver range, npm plugins only
  capabilities?: { tools?; hooks?; providers?; mcp? };
  setup(context: PluginContext): PluginHooks | void | Promise<…>;
  dispose?(): Promise<void> | void;
}
```

`PluginContext` is deliberately narrow — workspace root, a namespaced logger,
frozen per-plugin `options`, `registerTool`, `registerHook`. There is **no**
provider, executor or permission handle, so a plugin cannot patch the runtime.

Tools may be registered imperatively (`ctx.registerTool`) or returned
(`{ tools: [...] }`); both go through the same private registration helper, so
there is one registration code path.

### Canonical naming

| Kind | Canonical tool name | Permission resource |
|---|---|---|
| built-in | `read_file` | — |
| plugin | `plugin__<pluginId>__<toolName>` | `plugin:<pluginId>/<toolName>` |
| MCP | `mcp__<serverId>__<toolName>` | `mcp:<serverId>/<toolName>` |

Function names stay inside the provider-legal `[A-Za-z0-9_-]` charset (the `.`
form in the brief would break native function calling on OpenAI-compatible
APIs). The human-readable `:`/`/` form is used for permission resources and
audit/UI. Namespacing means a plugin tool named `write_file` becomes
`plugin__x__write_file` and **cannot** shadow the built-in.

`toolRegistry.register(def, owner)` rejects duplicates (returns `false`) rather
than overwriting, and `unregisterOwner(owner)` withdraws a whole plugin or
server atomically.

### Config (`77.4`)

One source: `<workspace>/.toolnet/plugins.json` (then the configured global
file, first declaration per spec wins).

```json
{
  "plugins": [
    "./plugins/format-after-write.ts",
    { "package": "@toolnet/example-plugin", "enabled": true, "options": { "foo": "bar" } }
  ]
}
```

A bare string, `{ package }`, `{ path }` and `{ spec }` are all normalized;
`path` forces the file interpretation. Malformed entries and unreadable JSON
produce warnings and are skipped — never a throw.

### Loader (`77.3`)

```
CONFIG → RESOLVE → (COMPATIBILITY) → IMPORT → VALIDATE EXPORT → INIT
```

Each stage returns a discriminated failure with its stage and a human reason, so
one broken plugin is skipped with a precise message and the rest still load:

* `resolve` — file missing, or npm package not installed (Phase 77 does **not**
  auto-install arbitrary packages);
* `compatibility` — npm plugins only, checked against `compatibleToolNet` (from
  the module export or `package.json#toolnet.compatibleToolNet`); file plugins
  are local development code and skip the gate;
* `import` / `validate` — bad module or no usable export (`default`, `plugin`,
  `definition`, or `activate`/bare-function treated as `setup`);
* `init` — `setup()` threw; anything it registered before throwing is rolled
  back via the owner-scoped unregister.

`PluginRuntime.loadAll()` is idempotent (it disposes the previous generation
first) and `dispose()` releases tools, hooks and then calls each plugin's own
`dispose`, tolerating failures.

---

## 3. MCP (`src/core/mcp`)

`McpManager` is a thin orchestration layer over the existing hardened runner
(`src/lib/mcpRunner.ts`) — trust gating, env scrubbing, connect timeout, result
bounding and secret redaction all stay in one connector implementation. The
manager adds lifecycle, normalization, registry sync, cancellation and bounds.

### Server types

* **local stdio** — `{ command, args, env?, cwd?, disabled? }`, spawned with an
  allowlist-only environment (`scrubChildEnv`); workspace config is discovered
  but untrusted until `/mcp enable`, and trust is fingerprinted on
  `command + args + cwd`.
* **remote HTTP/SSE** — not wired in Phase 77. `mcpRunner` documents the
  mandatory `safeFetch` routing a future transport must use (scheme guard,
  localhost policy, redirect hop limit, cross-origin header strip, auth-header
  redaction). Adding it is explicitly out of scope here.

### Manager API (`77.14`)

`sync(baseDir)` · `connect(nameOrId)` · `disconnect(nameOrId)` · `status(name)`
· `listServers()` · `listTools(serverId)` · `callTool(serverId, tool, args,
signal)` · `dispose()`. One manager, one client per `(root, serverId)`; repeated
calls reuse the same process (asserted in the live E2E).

### Untrusted schema normalization (`77.17`)

Every `tools/list` entry is data, not a contract:

* name must be a non-empty string, sanitized into the provider-legal charset;
* description truncated at `MCP_MAX_DESCRIPTION_CHARS`;
* `inputSchema` must be object-shaped, within `MCP_MAX_SCHEMA_DEPTH`,
  `MCP_MAX_SCHEMA_PROPERTIES` and `MCP_MAX_SCHEMA_BYTES`;
* `required` is intersected with declared properties (a dangling entry makes
  providers reject the whole schema);
* risk comes from `annotations.destructiveHint` / `readOnlyHint` first, then the
  underlying tool name — never the namespace.

A tool that cannot be normalized is **rejected with a reason** and excluded, so
one malformed tool never aborts discovery for the whole server.

### Tool filters and bounds (`77.22`, `77.35`)

Per-server config may set `enabledTools` (allowlist), `disabledTools` (denylist,
wins over allow) and `maxConcurrentCalls` (default 4). Every call also passes
through the global `ToolRateLimiter` in the gateway — nothing bypasses it.

### Permission (`77.16`)

MCP tools are ordinary registry entries, so they go through
`securityEngine.evaluate` like everything else. In `workspace` mode a mutating
external MCP tool is **DENY** (the underlying name is inspected, so the `mcp__`
prefix cannot make a write look like a read); in `ask` mode it requires
confirmation. The E2E asserts the strongest property: a denied call leaves the
tool **and** the server never receives the request (verified with a call log the
fixture server writes).

`plugin:*` tools carry their declared risk: `read` passes, anything else is an
approval checkpoint. Registering a plugin tool grants it no privilege.

### Cancellation, crash isolation, output (`77.18`–`77.20`)

* calls are cancellable (`AbortSignal`) and bounded by the runner's timeout;
* a dead child means that server's tools are withdrawn from the registry and
  subsequent calls return a typed `MCP_SERVER_DEAD` failure — the CLI keeps
  running;
* responses are normalized to `{ stdout, stderr, exitCode }` after secret
  redaction and byte-bounded truncation. The raw protocol envelope never reaches
  the model.

### Auth (`77.21`)

Phase 77 lands the **abstraction + policy**, not a full OAuth flow: secrets stay
in the explicit `config.env`/`auth` fields (never a global env var), are
scrubbed from child environments, and are redacted from tool output, logs and
audit. `mcpRunner` records the contract for a future OAuth provider.

---

## 4. Examples

### Plugin that formats after a write (`77.23`)

`.toolnet/plugins/format-after-write.ts` — disabled unless listed in
`.toolnet/plugins.json`. It hooks `file.afterWrite` and only runs a formatter
that the project **already** has configured; it never installs one.

### Plugin that guards secret files (`77.24`)

`.toolnet/plugins/deny-secret-files.ts` — a `tool.before` hook that returns
`{action:"deny"}` when a read targets `.env*` / `credentials.json`. It is an
**additional policy layer**; it does not replace `PermissionEngine`, which still
evaluates every call.

Both live under `examples/plugins/` and are inert until the user opts in.

---

## 5. Security model

* External tools cannot spawn a second runtime: a static guard test asserts
  `src/core/plugins/**` and `src/core/mcp/**` contain no `provider.chat`/
  `provider.stream`, no `ToolGateway.execute`, no `executeToolBatch`, no
  `for await`.
* A broken **blocking** hook fails closed.
* A plugin tool's `execute` never re-enters the gateway (the gateway is already
  the caller), so no infinite permission recursion is possible.
* Plugin ids and canonical tool ids are unique; duplicates are rejected, not
  merged.
* Structured logs carry `pluginId` / `serverId` / `hook` / `status` / `duration`
  only — never tokens, credentials, OAuth secrets or raw payloads.

---

## 6. Tests

| Suite | Tests | Covers |
|---|---|---|
| `hooksRegistry.test.ts` | 22 | class table, ordering + priority, deny/transform/continue, observe cannot veto or transform, failure policies (warn / fail-closed / override), hook timeout, abort, dispose/reset |
| `pluginRuntime.test.ts` | 27 | compat ranges (incl. fail-closed), config normalization + precedence + malformed JSON, loader staging (resolve/compat/validate), derivePluginId, registry registration + canonical naming, rollback on failing setup, duplicate id, namespacing vs shadowing, crash isolation, tool timeout, dispose idempotency, output normalization |
| `mcpCanonical.test.ts` | 20 | schema rejection matrix, name sanitization, description/size/depth caps, annotation-driven risk, canonical names + permission resources, owner-scoped registration/unregistration, duplicate rejection, tool filters, malformed policy, manager status/dispose |
| `pluginsMcpHooksE2E.test.ts` | 22 | **live stdio MCP server** (real spawn → initialize → tools/list → call → deny → reuse → withdraw), untrusted skip, plugin tool through the gateway, approval for mutating plugin tools, subagent MCP scoping, hook order/error routing/block/transform/fail-closed/withdrawal, background hooks, **both shipped example plugins loaded and exercised**, architecture guards |

Live E2E uses `helpers/fakePhase77McpServer.ts`: a genuine JSON-RPC stdio
server process (`echo`, `read_fixture`, `fail_tool`, `slow_tool`,
`dangerous_write`) that logs every call so a denied call can be proven not to
have reached it.

The two shipped samples under `examples/plugins/` are **loaded from disk and
exercised** by the same suite — a sample that rots is a failing test, not a
stale doc.

### Gate results

| Gate | Result |
|---|---|
| `bun run typecheck` | PASS |
| `bun test` | **1521 pass / 2 skip / 0 fail** (110 files), 8/8 consecutive green runs |
| `bun run build` | PASS (495 modules) |
| `npm pack --dry-run` | PASS (`toolnetcli@1.2.4`, 6 files) |
| Phase 73/74/75/76 regression | PASS (148 tests across 12 suites) |

---

## 7. Known limitations

1. **Remote MCP transport is not wired.** Only stdio is available; the future
   HTTP/SSE transport must route through `safeFetch` as documented in
   `mcpRunner`.
2. **No plugin/MCP hot reload.** Restarting ToolNet is the supported path.
3. **No automatic npm install.** A configured-but-missing package is skipped
   with an explicit "not installed" reason.
4. **OAuth is an abstraction only.** One tested flow (`config.env`/`auth`
   header) exists; the interactive OAuth provider is deferred.
5. **Some hook edges are declared but not fired** (`model.before/after`,
   `session.start`, `file.beforeWrite`, `shell.after`, `teamwork.node.*`). The
   contract is stable; wiring each is a one-line change at its authoritative
   site.
6. **`src/lib/plugins/pluginManager.ts` remains** for the `/plugins` CLI and the
   legacy capability-grant model. Its model-facing tool exposure was removed
   (the registry is now the only source) and its `onAgentStart` / `onAgentEnd` /
   `onToolCall` callbacks are adapted onto the canonical hook registry, so both
   plugin generations share one hook engine.
7. **Runtime `P8 — medium terminal degrades to compact B2` flake** (pre-existing,
   banner timing) and one wall-clock modal-animation test remain load-sensitive.
   The first full-suite run after adding the live MCP E2E exposed the latter; the
   live suite was consolidated to a single server spawn after which 6/6 full
   runs were green. Both are logged as known flaky, not masked by raising
   timeouts, and both pass reliably in isolation.
