# Phase 78 — Remote MCP + OAuth/Auth + Extension Diagnostics

Status: **DONE**. Phase 73–77.12 suites stay green; this phase adds remote
transport, a complete OAuth lifecycle, secret-free diagnostics and the guards
that keep all of it on the one canonical pipeline.

---

## 78.1 — There is still exactly one MCP runtime

```
remote MCP config
   ↓
the SAME McpManager               src/core/mcp/manager.ts
   ↓
connectRemote()                   src/core/mcp/remoteTransport.ts
   ↓
MCP Client (Streamable HTTP / SSE)
   ↓
discover tools → schema normalization   src/core/mcp/schema.ts
   ↓
McpToolAdapter
   ↓
the SAME ToolRegistry             src/lib/harness/toolRegistry.ts
   ↓
the SAME Permission engine        src/lib/security/securityEngine.ts
   ↓
callTool → ToolResult → Agent Engine
```

Two transport **executors** exist, and exactly one of each:

| Kind | Executor | Notes |
|---|---|---|
| stdio | `src/lib/mcpRunner.ts` | Phase 77, unchanged |
| remote | `src/core/mcp/remoteTransport.ts` | Phase 78, new |

Both feed the same `applyTools()` → normalize → register loop. There is no
`remoteMcpManager`, no `remoteToolRegistry`, no agent/teamwork/subagent path that
reaches HTTP directly. A denied tool call never reaches the server (see 78.26).

---

## 78.2 — Remote configuration

```jsonc
{
  "mcp": {
    "remote-name": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "enabled": true,
      "timeout": 30000,
      "headers": { "X-Custom": "..." },
      "oauth": {
        "clientId": "...",
        "clientSecret": "...",
        "scope": "...",
        "redirectUri": "...",
        "callbackPort": 12345
      }
    }
  }
}
```

`command` (stdio) and `url` (remote) are both accepted by config discovery, so
remote servers are first-class citizens of the same discovery/trust model.
Validation (`parseRemoteServerConfig`) rejects before any transport exists:

- `url` must parse and be `http:`/`https:` — `file:`, `data:`, `javascript:`,
  `ws:` are refused
- `timeout` must be a positive finite number (ms)
- `headers` must be a flat `string → string` map
- `oauth.callbackPort` must be a valid port
- `enabled: false` is preserved and the server is never dialed

Header values are never logged; only names appear in warnings and diagnostics.

---

## 78.3 — Transport order

1. **Streamable HTTP** — attempted first.
2. **SSE** — attempted only if (1) would not connect *for transport reasons*.

Both are never active at once: the failed Streamable HTTP transport is closed
before the SSE transport is constructed, and a failure returns with nothing
left open.

```
try Streamable HTTP
  ├─ ok ─────────────────────────────────► connected (transport: streamable-http)
  └─ fail
       ├─ 401 / UnauthorizedError ────────► needs_auth        (no fallback: the
       ├─ registration error ─────────────► needs_client_registration   server
       └─ generic / protocol failure ─────► close → try SSE              would
                                                 ├─ ok ──► connected (transport: sse)
                                                 └─ fail ─► classified status
```

Auth and registration failures are **terminal for that server**: they describe
the server, not the transport, so retrying over SSE would only repeat the same
401. Protocol incompatibility (e.g. `405` on the POST endpoint) is transient and
falls back.

---

## 78.4 — Status machine

`connected: boolean` is not the source of truth. `src/core/mcp/status.ts` holds
one transition table; illegal jumps are refused.

| Status | Meaning |
|---|---|
| `connected` | MCP `initialize` + `tools/list` completed |
| `connecting` | connect/discovery in flight |
| `disabled` | `enabled: false` or trust revoked |
| `failed` | transport/protocol failure |
| `needs_auth` | server answered 401 / refresh token invalid |
| `needs_client_registration` | no DCR endpoint and no static client id |
| `disconnected` | deliberately disconnected |
| `untrusted` / `not-installed` / `unavailable` | Phase 77 states, unchanged |

```
disabled        → no connect attempted
connecting      → connected | needs_auth | needs_client_registration | failed
connected       → disconnected | failed (onclose / dead transport)
needs_auth      → connecting (after a successful auth)
```

`toDiagnosticStatus()` maps these onto the narrow diagnostic enum; a status that
withdraws tools (`isToolWithdrawingStatus`) always unregisters them.

---

## 78.5 / 78.6 — Discovery, refresh and close

After `connected`, tools are listed, normalized by the Phase 77 schema layer
(name sanitization, description cap, property/depth/byte caps, `required`
intersection, risk from annotations then name) and registered into the canonical
registry under `mcp__<serverId>__<tool>`.

**`notifications/tools/list_changed`** → the server's old tool generation is
unregistered and the current one registered. The agent engine is never
restarted; `tools-changed` is emitted.

**Transport close / server death** → status `failed`, the connection is dropped,
the server's tools are **withdrawn from the registry**, and a `tools-changed`
event is emitted, so the model cannot keep calling into a dead remote. The
process stays alive and no rejection escapes.

---

## 78.7 / 78.8 / 78.35 / 78.36 — Auth storage

Canonical store: `<toolnetHome>/mcp-auth.json`, **mode 0600**.

```ts
interface McpAuthEntry {
  name: string;
  serverUrl?: string;
  tokens?: { accessToken; refreshToken?; expiresAt?; scope? };
  clientInfo?: { clientId; clientSecret?; clientIdIssuedAt?; clientSecretExpiresAt? };
  codeVerifier?: string;
  oauthState?: string;
  authorizationServerUrl?: string;
  resourceMetadataUrl?: string;
}
```

- **Atomic write** — temp file + `rename`; no partial file can be observed.
- **Serialized mutation** — every write goes through one promise chain, so a
  token refresh and a client registration happening together cannot lose an
  update.
- **URL-bound credentials** — `getTokensFor(name, serverUrl)` returns nothing
  when the stored `serverUrl` differs. Re-pointing `github` from
  `https://one.example/mcp` to `https://evil.example/mcp` does **not** replay the
  old token, and the server's command fingerprint changes so trust is re-asked.
- **Corrupt file** — quarantined to `<file>.corrupt-<ts>`, the store resets to
  empty, startup continues, and the warning never quotes the file body (a parse
  error message can contain the token).

Tokens never enter the session transcript, a `ToolResult`, a model prompt, an
audit payload, or a log line.

---

## 78.9 / 78.10 / 78.13 / 78.14 — OAuth

```
connect remote → 401 Unauthorized
  → status needs_auth
  → startAuth(server)
      → discovery (RFC 9728 protected resource → RFC 8414 / OIDC metadata)
      → dynamic client registration (RFC 7591)  ← or needs_client_registration
      → PKCE (S256) + state, persisted
      → authorization URL  ──► CLI/TUI only, never the model
  → callback (loopback) or manual code
  → state validated BEFORE the exchange
  → token exchange (carries code_verifier)
  → tokens persisted (0600, URL-bound)
  → reconnect → connected → tools discovered
```

- `state` is generated, persisted, and compared with a constant-time compare. A
  mismatch throws `OAuthStateMismatchError` and **no token is saved, no connect
  is attempted**.
- The PKCE verifier and `state` are one-time values: cleared on a successful
  exchange and on a failed one.
- `needs_client_registration` is a **deterministic** answer, produced before any
  registration attempt when the metadata has no `registration_endpoint` and no
  static/stored client exists. There is no retry loop.
- Static client config (`oauth.clientId` / `clientSecret` / `scope` /
  `redirectUri`) is a legitimate pre-registration.

The RFC-level work is delegated to the MCP SDK's `auth()` orchestrator; the
store, the state gate, the one-time lifecycle and the bounded refresh are ours.

### 78.12 — Manual code fallback (headless / VPS)

```
toolnet mcp auth <name> --no-wait     # prints the authorization URL and exits
toolnet mcp auth <name> --code <c> --state <s>
```

No GUI or browser is required.

### 78.15 — Token refresh

Before dialing, an access token that is missing/expired (30 s skew) is refreshed
with the stored refresh token — **one attempt**. A failure clears the access
state and the server transitions to `needs_auth`. A missing client registration
clears the unusable token rather than presenting it again.

### 78.16 — Auth removal

`toolnet mcp logout <name>` disconnects, then removes tokens, client info, code
verifier and state. **The server config is not deleted**; the next connect
requires auth again.

---

## 78.11 — Callback server

- binds **127.0.0.1 only** (never `0.0.0.0`)
- port dynamic by default, `oauth.callbackPort` when configured
- canonical route `/mcp/oauth/callback`
- any other path → 404; missing `code` → 400 and a rejection
- bounded window (default 5 min, unref'd timer, `closeAllConnections` on close)

---

## 78.17 — Headers

```
user config headers  ──► reserved names dropped  ──► transport/auth headers win
```

Reserved (`Authorization`, `Cookie`, `Proxy-Authorization`, `X-Api-Key`,
`*-Token`, `*-Secret`, `Mcp-Session-Id`) are dropped from user config with a
warning listing **names only**. The OAuth provider owns `Authorization`; a user
header can never silently override it. `redactHeaderValues()` is the display
path.

---

## 78.18 / 78.19 — Timeouts, abort and retry

Separate timeouts: **connect** (`config.timeout`, default 30 s), **tool call**
(`MCP_CALL_TIMEOUT_MS`, default 30 s, env-overridable), **OAuth callback**
(default 5 min). Every request carries an `AbortSignal`.

`createGuardedFetch` — the only fetch a remote transport or OAuth exchange
receives — enforces `http:`/`https:` only, loopback **only when the configured
target itself is loopback** (a redirect from a public host into `127.0.0.1` is
refused), manual redirects with per-hop revalidation and a 3-hop cap, credential
headers stripped on an origin change, a hard per-request timeout, and redacted
error text.

Retry is bounded and is **not** applied to `401`/`403`, invalid schema,
permission denial, OAuth state mismatch or invalid client — the SDK's
reconnection is limited to one attempt with a backoff.

---

## 78.31 / 78.33 / 78.34 — Diagnostics and the CLI

```ts
interface ExtensionStatus {
  id: string;
  type: "plugin" | "mcp";
  status: "connected" | "disabled" | "failed" | "needs_auth"
        | "needs_client_registration" | "disconnected";
  transport?: "stdio" | "streamable-http" | "sse";
  toolCount?: number;
  error?: string;
  authenticated?: boolean;
}
```

Nothing in that model can carry a token, secret, verifier or header value.

```
toolnet mcp list
toolnet mcp status [name]
toolnet mcp connect <name>
toolnet mcp disconnect <name>
toolnet mcp auth <name> [--no-wait] [--code <c>] [--state <s>]
toolnet mcp logout <name>
```

Example output:

```
github
  type: mcp
  transport: streamable-http
  status: connected
  tools: 12
  auth: yes

internal
  type: mcp
  transport: stdio
  status: connected
  tools: 4
  auth: no

private
  type: mcp
  status: needs_auth
  tools: 0
  auth: no
```

The TUI exposes `/mcp list | show | connect | disconnect | auth | logout`, which
delegate to the same CLI entry point — the TUI is a consumer and never connects
or authenticates a transport itself (Phase 78.34).

---

## 78.37 — Resource cleanup

`dispose()` closes the Streamable HTTP transport, the SSE transport and stdio
clients, stops any pending callback server, drops listeners and timers, and
leaves `unavailable` status behind. Shutdown is bounded and non-throwing.

---

## 78.38 — Architecture guards (enforced by tests)

| Guard | Rule |
|---|---|
| remote transports | `new StreamableHTTPClientTransport(…)` / `new SSEClientTransport(…)` appear **only** under `src/core/mcp/**` |
| bare fetch | no module outside `src/core/mcp/**` calls `fetch(…/mcp…)` |
| imports | `core/teamwork/engine.ts`, `core/agent/agentEngine.ts`, `teamwork/subagentRuntime.ts` never import an MCP client or `remoteTransport` |
| one runtime | `core/mcp/` has `manager.ts` and no `remoteManager.ts` / `remoteToolRegistry.ts`; the manager imports the canonical `toolRegistry` and `registerMcpTools` |

---

## 78.40 — Gate results

| Gate | Result |
|---|---|
| `bun run typecheck` | PASS |
| `bun test` | **1585 pass / 2 skip / 1 fail** (113 files; the single failure is the pre-existing timing-flaky `B2 Twin Portal` banner test, which passes in isolation) |
| `bun run build` | PASS (519 modules) |
| `npm pack --dry-run` | PASS (`toolnetcli@1.2.4`) |

Phase 73–77.12 regressions pass, including `phase7711HooksE2E`,
`pluginsMcpHooksE2E`, `phase7712HookInventory`, `mcpCanonical`, background,
teamwork, subagent and LSP.

---

## 78.39 — Test matrix

Unit (`src/teamwork/__tests__/phase78RemoteMcpAuth.test.ts`):

| Area | Covered |
|---|---|
| remote config validation | http/https only, bad timeout, bad headers, bad callbackPort, `enabled:false` |
| header policy | reserved names dropped, auth headers win, error redaction |
| status machine | legal/illegal transitions, history, diagnostic mapping |
| auth store | 0600 mode, atomic temp cleanup, URL binding, concurrency, corrupt quarantine, removal, expiry maths |
| PKCE / state | mismatch rejected pre-exchange, no stored state rejected |
| callback server | loopback bind, canonical route, 404/400, capture, bounded timeout |
| guarded fetch | forbidden schemes, SSRF-into-loopback, loopback allow, bounded refresh |
| redaction | seeded secret absent from status/logs/events, present only in auth storage |

Integration (real HTTP MCP servers on 127.0.0.1):

| Area | Covered |
|---|---|
| Streamable HTTP | connect → `tools/list` → registry → permission → call → disconnect |
| SSE fallback | Streamable HTTP rejected (405) → SSE connected → call |
| OAuth | needs_auth → URL → PKCE callback → token → connected → call → logout |
| state mismatch | no token, no connect, token endpoint untouched |
| client registration | `needs_client_registration`, zero registration attempts |
| URL isolation | re-pointed server receives no old credential |
| tools changed | old tool unregistered, new tool registered, no restart |
| server death | status `failed`, tools withdrawn, no throw |
| subagent scope | remote MCP read allowed, denied tool cannot escalate |
| CLI | list/status/connect/disconnect/logout, manual-code fallback |
| architecture guards | transport construction, bare fetch, imports, one runtime |

---

## Known limitations

- **No WebSocket MCP transport** — out of scope for Phase 78.
- **Refresh is a single attempt.** A transient failure requires a reconnect
  (or explicit `toolnet mcp auth`) rather than an internal retry loop.
- **No token revocation request on logout.** Local credentials are destroyed;
  server-side revocation is a later phase.
- **Reconfiguration needs a re-sync.** `ensureManaged` keeps the config captured
  at first sight, so a changed `url` takes effect on the next sync/process start
  (and re-requires trust, by design).
- **SSE is a fallback, not a parallel path.** A server that only speaks SSE is
  supported, but Streamable HTTP is always attempted first.
- **One callback window at a time per server.** Starting a second `auth` for the
  same server replaces the pending callback.
- Server-side `Secret` values in header *values* are not stored anywhere, so
  they cannot be redacted from a diagnostic — only the names are reported.
