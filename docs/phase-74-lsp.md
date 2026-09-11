# Phase 74 — LSP / Code Intelligence

Date: 2026-09-11
Status: **DONE**
Reference read first: OpenCode `lsp/lsp.ts`, `lsp/client.ts`, `lsp/server.ts`,
`lsp/language.ts`, `lsp/diagnostic.ts`, `lsp/launch.ts`, `tool/lsp.ts`.

Phase 73 was not modified beyond one additive line in the agent harness (§6).
No core regression was found or introduced.

---

## 1. Architecture

```
model
  → ToolRegistry (canonical `lsp` tool, risk: read)
    → permission gate (ToolGateway)
      → LspManager (one per workspace, lazy)
        → LspClient (one per root+server)
          → LspTransport (stdio JSON-RPC | in-memory in tests)
            → language server process
```

The `lsp` tool is the **only** new entry point and it flows through the exact
same registry → permission → execute pipeline as every other tool. There is no
second execution path.

## 2. File map

| File | Responsibility |
|---|---|
| `src/core/lsp/types.ts` | Normalized contracts (`Location`, `DiagnosticItem`, `SymbolInfo`, `LspTransport`, timeouts). |
| `src/core/lsp/languages.ts` | Extension → LSP `languageId` mapping. |
| `src/core/lsp/servers.ts` | Server specs, extension selection, binary discovery, root detection. |
| `src/core/lsp/transport.ts` | `Content-Length` framing, stdio transport, in-memory transport pair. |
| `src/core/lsp/normalize.ts` | Wire → normalized adapters (locations, symbols, hover, URIs). |
| `src/core/lsp/diagnostics.ts` | Diagnostic normalization, severity counts, `<diagnostics>` report. |
| `src/core/lsp/client.ts` | Handshake, document sync, request correlation, timeouts, cancellation, diagnostics cache. |
| `src/core/lsp/manager.ts` | Per-workspace manager: lazy start, reuse, broken-set, symbol cache, shutdown. |
| `src/core/lsp/tool.ts` | The canonical `lsp` tool: validation, dispatch, envelopes. |
| `src/core/lsp/index.ts` | Public API. |
| `src/lib/harness/toolRegistry.ts` | Registers the `lsp` tool (one entry, `risk: "read"`). |
| `src/lib/harness/agentHarness.ts` | §6: appends diagnostics after a mutation when a server is already running. |

## 3. Language support (74.2)

| Language | Server | Notes |
|---|---|---|
| TypeScript / JavaScript | `typescript-language-server` | project-local `node_modules/.bin` preferred over global |
| Python | `pyright-langserver`, `basedpyright-langserver` | either binary |
| Go | `gopls` | |
| Rust | `rust-analyzer` | |
| C / C++ | `clangd` | |
| Java | `jdtls` | |
| PHP | `intelephense` | |

**No server is ever installed by ToolNet.** Discovery checks, in order:
`node_modules/.bin` walking up to the workspace root, then `PATH`. When nothing
is found the capability is reported unavailable and the agent falls back to
`grep` / `glob` / `read_file`.

Enable a server yourself if you want semantic navigation:

```bash
npm install -g typescript-language-server typescript   # TS/JS
npm install -g pyright                                  # Python
```

## 4. Operations (74.3)

| Operation | Input | Result |
|---|---|---|
| `definition` | path, line, character | `Location[]` |
| `references` | path, line, character | `Location[]` (includes declaration) |
| `hover` | path, line, character | type/signature text |
| `document_symbols` | path | `SymbolInfo[]` |
| `workspace_symbols` | query | `SymbolInfo[]` |
| `diagnostics` | path | `DiagnosticItem[]` + `<diagnostics>` block |

Positions are 1-based (editor convention) at the tool boundary and converted to
LSP's 0-based form internally. Paths are workspace-relative. Servers return
`Location`, `LocationLink`, flat or nested `DocumentSymbol`, and `MarkupContent`
hover — all normalized to the table above, so the model never sees server
specifics.

Not implemented in this phase (deferred, per 74.3 "after it is stable"):
`rename`, `implementation`, `type_definition`, `call_hierarchy`.

## 5. Tool design (74.4)

One canonical tool named `lsp`, registered in `toolRegistry` with
`risk: "read"` and `category: "Code Intelligence"`. Read-only is deliberate: the
operations never mutate the workspace, so they auto-allow and never interrupt
the user with an approval prompt (approving every symbol lookup would defeat the
purpose). Mutations still go through the existing write/edit tools and their
permission checks.

Envelope returned to the agent:

```json
{ "stdout": "<readable results>", "stderr": "", "exitCode": 0,
  "operation": "definition", "available": true, "results": [ ... ], "count": 1 }
```

Unavailable server:

```json
{ "stdout": "LSP unavailable for …: Language server binary not found (tried: pyright-langserver). Fall back to grep/glob/read_file for this task.",
  "stderr": "", "exitCode": 0, "available": false, "results": [], "reason": "…" }
```

`exitCode: 0` for an unavailable server is intentional: a missing capability is
**not** a runtime failure and must not look like one to the Completion Gate. The
`available: false` flag makes the situation explicit, so nothing is fabricated.

## 6. Agent behaviour (74.5, 74.6)

The tool description instructs the model to prefer `lsp` over `grep` for symbol
lookups, reference finding, type information and diagnostics, and to fall back
when the tool reports unavailability.

After a successful `write_file` / `edit_file` / `replace_all` / `apply_patch`,
the harness appends LSP diagnostics for the changed file **if a server is
already running for it** (it never spawns one just to diagnose an edit). This is
a supplementary repair signal; it never replaces a typecheck, build or test run.
The hook is wrapped in `try/catch` and cannot fail a mutation.

## 7. Diagnostics (74.6)

- Normalized to `{ path, line, character, severity, message, source?, code? }`.
- Deduplicated (servers sometimes publish the same problem twice).
- Rendered as a `<diagnostics file="...">…</diagnostics>` block containing
  errors and warnings only; capped at 20 entries per file with a `... and N more`
  suffix.
- Diagnostics resolve on a timeout (default 5 s) with whatever arrived, so a
  quiet server never stalls the loop.

## 8. Performance (74.9)

- **Lazy startup** — a server starts on first use, never at boot.
- **Reuse** — one client per `(root, serverId)`, shared by every later call;
  concurrent first-calls are de-duplicated through an in-flight map.
- **Broken set** — a server that fails to spawn/initialize is never retried.
- **Timeouts** — initialize 45 s, request 10 s, diagnostics 5 s, shutdown 2 s
  (all overridable).
- **Cancellation** — every request accepts an `AbortSignal`; pending requests
  reject and diagnostics waits resolve immediately.
- **Caching** — `document_symbols` and `workspace_symbols` are cached for 15 s;
  `invalidate(path)` clears them after a mutation.
- **No TUI blocking** — all calls are async and bounded by timeouts.
- **Symmetric framing** — the JSON-RPC codec is implemented in-repo (no new
  dependency), with a streaming `Content-Length` decoder.

## 9. Tests (74.7, 74.8)

Deterministic; no language-server binary and no network required.

| Suite | Coverage |
|---|---|
| `lspCore.test.ts` (25) | language detection, server selection, local-binary preference, root clamping, framing (incl. split chunks + malformed frames), request correlation, timeout, cancellation, diagnostics normalization/dedupe/report, unavailable fallback, broken-set no-retry, URI/path normalization, ToolRegistry integration |
| `lspIntegration.test.ts` (12) | all six operations against a TS fixture on disk, server reuse + shutdown, invalid-input handling, abort, graceful fallback |
| `lspGoldenE2E.test.ts` (2) | rename `getUser → findUser`: `workspace_symbols` → `references` → edit only those files → diagnostics clean → **real `bun test` run in the fixture** → on-disk verification; plus safe degradation without a server |

The in-memory transport (`createMemoryTransportPair`) and
`createFakeLspServer` helper exercise the production client/manager code paths.

## 9b. Live Acceptance (74.11)

Proves the implementation against a **real language server process**, not the in-memory transport.

**Environment**

| Item | Value |
|---|---|
| Language server | `typescript-language-server` **6.0.0** (`--stdio`) |
| TypeScript | 5.9.3 |
| Fixture | `/tmp/toolnet-lsp-live` (`package.json`, `tsconfig.json`, `src/service.ts`, `src/controller.ts`, `src/index.ts`) |
| Transport | production stdio JSON-RPC (`spawnStdioServer`) — no fake, no memory transport |
| Suite | `src/teamwork/__tests__/lspLiveAcceptance.test.ts` |

Installed deliberately for this acceptance only, into the fixture's own
`node_modules/.bin` — which also exercises the project-local discovery path.
ToolNet's runtime policy is unchanged: it never installs a server, and reports
`available: false` with a clear reason when one is missing.

The suite is opt-in by availability: it runs when the fixture and binary exist,
and skips otherwise, so CI never depends on an installed language server.

**Results — 15/15 PASS**

| Check | Result |
|---|---|
| spawn → initialize handshake (`initialize` + `initialized`) | ✅ PASS |
| `definition` → `src/service.ts:6:17` (workspace-relative, 1-based) | ✅ PASS |
| `references` → `service.ts` + `controller.ts` + `index.ts` | ✅ PASS |
| `hover` → real signature containing `getUser` / `User` | ✅ PASS |
| `document_symbols` → `getUser`, `User` (with nested members) | ✅ PASS |
| `workspace_symbols("getUser")` → `src/service.ts` | ✅ PASS |
| `diagnostics` clean on untouched fixture | ✅ PASS |
| **live mutation**: `name: "ToolNet"` → `name: 123` produces a real TypeScript error; restoring clears it | ✅ PASS |
| cache invalidation: new symbol invisible while cached, visible after `invalidate()` | ✅ PASS |
| process reuse: `spawnCount === 1` across definition/references/hover/symbols/diagnostics | ✅ PASS |
| cancellation + bounded timeout leave the session usable | ✅ PASS |
| shutdown → `shutdown`/`exit` → process reaped, **0 orphans** | ✅ PASS |
| operations after shutdown degrade to `[]` (no respawn, no throw) | ✅ PASS |
| fallback regression (no binary): `available:false` + grep hint, no crash | ✅ PASS |

Two real findings from this acceptance were fixed:

1. **`diagnostics()` stalled on already-open documents.** It waited for a publish
   that never comes when the document is unchanged. `LspClient.openDocument` now
   reports whether it actually sent `didOpen`/`didChange`, and `diagnostics()`
   returns the cached batch immediately when the document is already in sync
   (returning it only after the timeout before).
2. **A disposed manager could respawn a server.** `LspManager.shutdown()` now
   marks the workspace disposed, so a late tool call cannot leak a process after
   the session it belonged to has ended.

**Behavioural note (standard LSP):** `typescript-language-server` only offers
complete cross-file resolution for documents loaded into the project. The
acceptance therefore reads the fixture files first (what a real agent does
before navigating) and the results are exact. `definition` on a symbol whose
module has not been loaded yet returns the import binding — a useful pointer,
and the target resolves once that file is read.

## 10. Definition of Done

| Criterion | Status |
|---|---|
| Canonical LSP manager | ✅ |
| Canonical `lsp` tool | ✅ |
| ToolRegistry integration | ✅ |
| TypeScript / JavaScript works | ✅ (deterministic fixture; real binary discovered when installed) |
| Python adapter / clear fallback | ✅ (`pyright-langserver` / `basedpyright-langserver`, explicit unavailable reason) |
| `definition` / `references` / `diagnostics` / `symbols` / `hover` | ✅ |
| Cancellation | ✅ |
| Unavailable-server fallback | ✅ |
| Deterministic tests | ✅ |
| `typecheck` | ✅ |
| unit tests | ✅ **1319 pass, 2 skip, 0 fail** |
| `build` | ✅ (462 modules) |
| `npm pack --dry-run` | ✅ (`toolnetcli@1.2.4`) |
| Phase 73 regression tests | ✅ (core deterministic E2E + harness core + critical scenarios: 48 pass) |
| **Live acceptance against a real language server** | ✅ **15/15 PASS** (see §9b) |

## 11. Known limitations

1. **No language server is bundled.** TS/JS semantics work as soon as
   `typescript-language-server` is on the machine (or in a project's
   `node_modules/.bin`); until then the tool reports unavailability and the
   agent falls back to text search. Verified against this repository:
   `available: false — Language server binary not found (tried: typescript-language-server)`.
2. **No auto-install.** By design, so ToolNet never mutates the user's global
   toolchain or downloads a server without consent.
3. **Deferred operations:** `rename`, `implementation`, `type_definition`,
   `call_hierarchy` are not implemented yet (explicitly sequenced "after it is
   stable" by the phase spec).
4. **Diagnostics are supplementary.** They are the server's static view; a
   typecheck/build/test run remains the source of truth for completion.
5. **Live acceptance requires the server to be installed.** It is verified with
   `typescript-language-server@6.0.0`, but the suite skips (rather than fails)
   when the binary or fixture is absent, so it never blocks CI.
6. Phase 75 (subagents/background) was not started, per the phase gating rule.
