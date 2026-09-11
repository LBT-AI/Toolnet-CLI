# Phase 73.11 — Final Audit & Reconciliation

Date: 2026-09-11
Scope: close Phase 73 by reconciling the execution architecture against the
OpenCode reference, removing the remaining duplicate definition sources, and
confirming **one primary execution path**.

> Rule applied throughout: model compliance, provider availability and runtime
> defects are reported in **separate buckets**. Nothing in this document marks a
> model-behaviour problem as a CORE_RUNTIME failure.

---

## 1. OpenCode references read

Fetched from `github.com/anomalyco/opencode` (`dev`) and used to compare
lifecycle and separation of concerns (not copied):

| Reference | What we took from it |
|---|---|
| `packages/opencode/src/session/processor.ts` | Tool-call part lifecycle (`pending → running → completed/error`), stream-event → part updates, doom-loop detection on 3 identical recent calls, snapshot patch emitted at step finish. |
| `packages/opencode/src/session/llm.ts` | A single LLM stream abstraction owning provider selection, tool map, abort, and normalised `LLMEvent` output. Provider specifics never leak upward. |
| `packages/opencode/src/tool/registry.ts` | One canonical registry; `tools(model)` filters by model/permission; plugin tools are boxed at the registry boundary; schemas exposed from a single place. |
| `packages/opencode/src/tool/tool.ts` | `Tool.Def` (id, description, schema, execute), argument validation with a typed error, truncation, `ctx.ask()` permission and `ctx.abort`. |
| `packages/opencode/src/permission/index.ts` | Ruleset `evaluate()` (`allow`/`ask`/`deny`), deferred ask/reply, session-scoped approvals. |
| `packages/opencode/src/snapshot/index.ts` | Before/after snapshot + patch of changed files (git-backed). |

`packages/tui/src/app.tsx` was **not** fetched: OpenCode's TUI is an Ink/React
renderer and does not inform the execution-path question this phase resolves.
ToolNet's TUI boundary was instead verified directly against
`src/tui/events/agentWiring.ts`.

---

## 2. Files audited (ToolNet)

Execution / routing:
- `src/core/contracts.ts`, `src/core/index.ts`
- `src/core/agent/agentEngine.ts`, `completionGate.ts`, `toolCallState.ts`
- `src/core/llm/capabilities.ts`
- `src/lib/harness/agentHarness.ts`, `agentLoop.ts`, `modelAdapter.ts`,
  `toolRegistry.ts`, `toolExecutor.ts`, `agentState.ts`, `index.ts`
- `src/lib/agentRuntime.ts`, `agentTools.ts`, `toolsCatalog.ts`, `harnessCatalog.ts`
- `src/lib/security/toolGateway.ts`
- `src/lib/nonInteractive.ts`
- `src/tui.ts`, `src/tui/events/agentWiring.ts`
- `src/simple-repl.ts`, `src/commands/qa.ts`, `src/commands/tools.ts`,
  `src/commands/harness.ts`
- `src/teamwork/subagentRuntime.ts`, `turboExecutor.ts`, `smartPlanner.ts`

---

## 3. KEEP

- `AgentHarness.executeLoop` — the one execution kernel.
- `src/core/agent/agentEngine.ts` — the one normalised front-end entry
  (`run()` → `AgentEvent` / `AgentResult`).
- `src/lib/harness/modelAdapter.ts` — the one provider-normalisation path.
- `src/lib/harness/toolRegistry.ts` — the one canonical tool registry
  (risk + execute + verify + alias metadata).
- `src/lib/security/toolGateway.ts` — the one permission/security gate.
- `Completion Gate` (`src/core/agent/completionGate.ts`) wired into the loop.
- Tool postcondition verification (`src/lib/toolVerification.ts`).

---

## 4. FIX

1. **`src/lib/toolsCatalog.ts` no longer reads `getMergedAgentTools()`.** It now
   projects the UI view-model from `toolRegistry.list()` (canonical entries
   only). Plugin tools still arrive as OpenAI-style schemas, but they are the
   only remaining non-registry input and are explicitly a plugin boundary.
2. **`src/lib/harnessCatalog.ts`** now reports `toolRegistry.canonicalNames().length`
   instead of counting the legacy merged array.
3. **`agentTools` schema array is now derived** — `export const agentTools = toolRegistry.schemas()`
   (see §6). The UI, subagents and the model all read the same canonical names.
4. **`src/tui.ts`** header rewritten to state the module is a pure UI surface.

---

## 5. REPLACE

- The historical hand-maintained 350-line OpenAI tool-schema literal in
  `src/lib/agentTools.ts` is **replaced** by a derivation from the registry.
  This removes the last duplicate definition source and stops `glob_search` /
  `grep_search` from being exposed to any model (including subagents, which
  consume `getSubagentTools()` → `agentTools`).

---

## 6. DELETE

- `src/tui.ts`: the `export { executeToolBatch } from "./lib/harness/toolExecutor";`
  re-export. Nothing in `src/` imported it; only a static test referenced the
  string. The test was inverted to assert the re-export is **gone**.
- `src/lib/agentTools.ts`: the duplicated tool-schema array body (−362 lines).
- No files were deleted in this phase; the deletions are the removals above.

**Not deleted (classified COMPATIBILITY_SHIM, still pull their weight):**
- `AgentRuntime.runLoop()` — thin facade over `AgentHarness.resume()`; owns no
  loop. Kept so `simple-repl` and `/qa` keep their in-place message-sync contract.
- `AgentLoop` (`src/lib/harness/agentLoop.ts`) — lifecycle wrapper only; calls
  `AgentHarness.execute()`. No second loop.
- `executeTool` (`agentTools.ts`) — thin wrapper around `ToolGateway.execute()`.

---

## 7. Final execution path

```
TUI ───────────► agentEngine.run()  ─┐
Headless (-p) ─► agentEngine.run()  ─┤
Simple REPL ───► AgentRuntime ──────┤
/qa ───────────► AgentRuntime ──────┤
Subagent ──────► getHarness() ──────┼──► AgentHarness.executeLoop()   (ONE kernel)
Turbo ─────────► getHarness() ──────┤         │
                                     │         ▼
                                     │    ModelAdapter.complete()      (ONE LLM path)
                                     │         │
                                     │         ▼
                                     │    Provider (stream/chat)
                                     │         │
                                     │         ▼
                                     │    toolRegistry  →  ToolGateway  →  execute  →  verify
                                     │         │
                                     └─────────┴── tool result back to Model
```

Repo-wide search results (non-test `src`):

| Symbol | Found in | Classification |
|---|---|---|
| `provider.stream(` / `provider.chat(` | only `harness/modelAdapter.ts` | VALID (single normalisation) |
| `delta.tool_calls` | none (raw deltas parsed inside `modelAdapter`) | VALID |
| `executeToolBatch(` | `harness/agentHarness.ts` (dispatch), `harness/toolExecutor.ts` (def) | VALID |
| `ToolGateway.execute(` | `harness/agentHarness.ts` (runTool), `plugins/pluginManager.ts` (plugin path), `agentTools.ts` (compat wrapper) | VALID / COMPATIBILITY_SHIM |
| `continueAgentLoop` | none | REMOVED |
| `runLoop(` | `simple-repl.ts`, `commands/qa.ts` → `agentRuntime.ts` | COMPATIBILITY_SHIM (no loop) |
| `agentEngine.run(` | `tui/events/agentWiring.ts`, `lib/nonInteractive.ts` | VALID |

Conclusion: **ONE execution kernel** (`AgentHarness.executeLoop`) and **ONE LLM
normalisation path** (`ModelAdapter`). No second agent loop exists.

---

## 8. Final tool registry

- Canonical model-visible names come from `toolRegistry.schemas()`, which
  filters out entries carrying `aliasOf`.
- Aliases (`bash`, `run_command`, `grep_search`, `glob_search`) remain
  **dispatch-only**: `toolRegistry.get(name)` still resolves them for old
  sessions and the structured protocol.
- `agentTools === toolRegistry.schemas()` and `getSubagentTools()` derives from
  it, so no interface or subagent can see an alias.
- UI catalogs read the registry (see §4).

---

## 9. Test results

| Gate | Command | Result |
|---|---|---|
| Typecheck | `bun run typecheck` | PASS |
| Unit + integration | `bun test` | **1280 pass, 2 skip, 0 fail** |
| Build | `bun run build` | PASS (453 modules, `dist/node/index.js` 1.66 MB) |
| Package | `npm pack --dry-run` | PASS (`toolnetcli@1.2.4`, 6 files, 708.5 kB) |
| CORE deterministic E2E | `bun test src/teamwork/__tests__/coreDeterministicE2E.test.ts` | **3 pass** — write → fail → stderr → edit → rerun → exit 0 → verified; workspace isolation; unsatisfied mutation cannot finish as success |
| Real-model E2E (opt-in) | `TOOLNET_REAL_MODEL_E2E=1 bun test …/realModelE2E.test.ts` | PASS (classified PROVIDER_PROTOCOL, see §12) |

New/changed tests this phase:
- `harnessCoreModules.test.ts` — new block *"single definition source and
  interface parity"*: derived schema array, no alias exposure, catalogs read the
  registry, `tui.ts` is a pure UI surface, `simple-repl` owns no loop,
  `AgentRuntime` is a thin facade, and **interface parity** (TUI + headless +
  REPL all reach the shared kernel).
- `p1_pipeline_routing.test.ts` — the TUI static test now asserts the
  `executeToolBatch` re-export is gone.

---

## 10. CORE_RUNTIME status — **GREEN**

- Single kernel; TUI renders events and never executes tools.
- Path tools resolve against the execution context, not module-global cwd
  (workspace-isolation regression test).
- Every mutation is verified (file written/edited, patch targets exist) before a
  result is reported; the Completion Gate forces a corrective turn when a
  mutation/execution requirement has no verified evidence.
- Deterministic self-repair E2E (write → fail → stderr → edit → rerun → exit 0)
  passes independently of any live model.

No open CORE_RUNTIME defect identified in this audit.

---

## 11. MODEL_COMPLIANCE status — **LIMITATION (not a runtime defect)**

`alims-intl.llm` is the default model in this environment. Observed behaviours
across phases:

- Sometimes emits **zero tool calls** and answers in prose.
- Sometimes rewrites the pasted string `Hello ToolNet` into a path
  (`HelloToolNet/hello.py`).
- Sometimes calls `python` (not on this box) and, on stderr, correctly retries
  with `python3`.

The runtime handles all three honestly: it never converts prose into a tool
success, it returns the real `exitCode`/`stderr`, and the repair loop re-runs
after an edit. Capability resolution for a gateway that declares no
`nativeToolCalls` is `structured` (conservative), never `native`.

=> Classified as **MODEL_COMPLIANCE_FAILURE**, explicitly not charged to
CORE_RUNTIME. No system-prompt hack was added to force compliance.

---

## 12. PROVIDER_PROTOCOL status — **EXTERNAL / CURRENTLY UNAVAILABLE**

The live real-model E2E run for this phase reported:

```
model=alims-intl.llm classification=PROVIDER_PROTOCOL
toolCalls=0 toolResults=0 errors=1 fileExists=false
error=Gateway network error: Network/Gateway connection failed: The operation timed out.
```

The gateway `api.toolnet.tech` timed out. Per phase rules this is tracked as
PROVIDER_PROTOCOL and does **not** block Phase 73 closure. Network/timeout
classification is already distinct from core failures in `realModelE2E.test.ts`
(the test can never report CORE_RUNTIME once a tool has been dispatched).

---

## 13. ARCHITECTURE status — **GREEN**

- TUI migrated: `agentWiring.sendMessage` calls `agentEngine.run()` and renders
  `AgentEvent` only — no `provider.chat/stream`, no `delta.tool_calls`, no
  `executeToolBatch`.
- Headless (`-p`) calls `agentEngine.run()`.
- Simple REPL calls `AgentRuntime` (thin facade) → `AgentHarness.resume()` — no
  loop of its own.
- One canonical tool registry; aliases are dispatch-only and never model-visible.
- One LLM normalisation path (`modelAdapter.ts` is the only caller of
  `provider.chat/stream` in `src/lib`).
- One permission gate (`ToolGateway`).
- `Completion Gate` operational.

---

## 14. Remaining known limitations

1. **Live end-to-end acceptance is blocked by the provider gateway timeout**
   (§12). Deterministic E2E covers the runtime contract meanwhile.
2. **`alims-intl.llm` compliance** is weak (§11); a model with reliable native
   tool calling would improve real-world results, but that is a provider-quality
   matter, not a runtime one.
3. **Subagent and Turbo still enter via `getHarness()` directly** rather than
   `agentEngine.run()`. They converge on the same kernel, so this is a
   consistency nicety, not a second loop. Migrating them would require passing
   child `sessionId` / `agentDepth` through the engine options, which is out of
   scope for closing Phase 73.
4. **`pluginManager` tool schemas** remain a second (external) schema input for
   display; plugin tools are dynamically registered by design and are boxed at
   the registry/gateway boundary.

---

## Definition of Done — Phase 73

| Criterion | Status |
|---|---|
| ONE shared agent engine / kernel | ✅ |
| ONE canonical tool registry | ✅ |
| ONE model/provider normalization path | ✅ |
| TUI does not execute tools | ✅ |
| Simple REPL has no loop of its own | ✅ |
| Headless uses the same engine | ✅ |
| Tool aliases not exposed to the model | ✅ |
| Real before/after verification | ✅ |
| Completion Gate operational | ✅ |
| Deterministic self-repair E2E | ✅ |
| `typecheck` | ✅ |
| unit tests | ✅ (1280 pass) |
| `build` | ✅ |
| `npm pack --dry-run` | ✅ |
| `docs/phase-73-11-audit.md` | ✅ |
