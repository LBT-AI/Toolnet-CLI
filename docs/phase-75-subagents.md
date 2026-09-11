# Phase 75 — Scoped Subagents

Date: 2026-09-11
Status: **DONE**
Reference read first: OpenCode `tool/task.ts`, `agent/agent.ts`,
`agent/subagent-permissions.ts`, `session/session.ts`, `permission/index.ts`,
`test/tool/task.test.ts`, `test/agent/plan-mode-subagent-bypass.test.ts`,
`background/job.ts` (design-only — background work is NOT implemented here).

Phase 73 (Agent Core) and Phase 74 (LSP) were not refactored. Two real defects
were found *by* the new tests and fixed; both are described in §11.

---

## 1. Architecture — one kernel

```
Parent Agent (primary)
  ↓  model emits a `task` tool call
  ↓
ToolRegistry (`task`, risk: execute)
  ↓  permission gate (ToolGateway → SecurityEngine)
  ↓    depth guard for delegation enters here
SubagentManager
  ↓  child session (own transcript) + derived permission + scoped tool set
  ↓
Shared Agent Engine  ──►  AgentHarness.executeLoop  ← THE loop
  ↓
ModelAdapter → Provider          (one normalization path)
ToolRegistry → Permission → Execute → Verify   (one tool pipeline)
  ↓
Child result envelope
  ↓
Parent model
```

There is **no second agent loop**. `src/core/agent/agents/**` contains no
`provider.chat/stream` call, no `ToolGateway.execute`, no `for await`, no
`while` — enforced by a static test (`ARCHITECTURE — subagents share one
kernel`).

## 2. File map

| File | Responsibility |
|---|---|
| `src/core/agent/agents/types.ts` | Contracts: `AgentDefinition`, `ToolPermissionScope`, `decideTool`, `SubagentSession`, `SubagentResult`, depth defaults. |
| `src/core/agent/agents/permissions.ts` | `deriveSubagentPermission`, sandbox→scope bridge, `assertNoEscalation`. |
| `src/core/agent/agents/registry.ts` | The ONE `AgentRegistry`: built-ins + validated custom agents. |
| `src/core/agent/agents/yaml.ts` | Dependency-free YAML subset parser for `.toolnet/agents.yaml`. |
| `src/core/agent/agents/sessions.ts` | `SubagentSessionStore`: child ids, isolation, resume, terminal status. |
| `src/core/agent/agents/prompt.ts` | Child system prompt composition (scope + honesty rules). |
| `src/core/agent/agents/manager.ts` | `SubagentManager`: depth guard, scope derivation, engine invocation, result envelope. |
| `src/core/agent/agents/taskTool.ts` | `task` handler: runtime resolution + result formatting. |
| `src/core/agent/agents/taskToolDefinition.ts` | The registry entry exposed to the model. |

## 3. Agent registry (§75.2, §75.14)

Built-ins — one per *responsibility*, not one per domain:

| id | mode | scope |
|---|---|---|
| `general` | all | inherits the parent scope unchanged |
| `explore` | subagent | read + search + LSP + fetch; never writes, never executes, cannot delegate |
| `coder` | subagent | read, edit, patch, shell, git; **cannot** delegate |
| `tester` | subagent | read + shell + git; **cannot** mutate source |
| `reviewer` | subagent | read + search + LSP + git; strictly read-only |
| `plan` | primary | read-only; `task` remains callable so the *runtime* proves the bypass is blocked |

`resolve()` falls back to `general` for unknown ids, so a hallucinated role name
degrades safely instead of failing the turn — and never gains extra scope.

Custom agents load from `<workspace>/.toolnet/agents.yaml`. Malformed entries
are reported as issues and skipped; a broken config cannot disable the
built-ins, and a custom agent can never replace a built-in.

```yaml
agents:
  security-reviewer:
    description: Review security issues
    mode: subagent
    tools: [read_file, grep, glob, lsp]
    deny: [shell, write_file, edit_file]
```

## 4. Permission derivation (§75.4, §75.19)

```
child = parent ∩ agent ∩ requested        (never wider)
```

Implemented as a per-tool intersection where the **least privileged** verdict
wins. Three rules make it fail-closed:

1. An explicit parent `deny` always wins — nothing (agent config, requested
   scope, or a later user approval for a *different* tool) can unlock it.
2. An agent allowlist survives the intersection. Without this, a tool present in
   neither scope's explicit rules would silently fall back to the parent default
   (this was a real hole — see §11.1).
3. A derived allowlist is filtered against the parent scope, so a list can only
   narrow a default, never override a parent deny.

`assertNoEscalation()` re-checks the invariant at spawn time using the same
production helpers; a violation refuses the spawn instead of proceeding.

## 5. Child sessions (§75.6, §75.9)

- Deterministic, traceable ids: `sub:<parentSessionId>:<agentId>:<sequence>`.
- The child transcript is its **own**; parent tool results never leak in, and
  only the result envelope travels upward.
- Sessions are stored in `SubagentSessionStore` (process lifetime) and remain
  auditable after completion. `delete()` only drops the live entry.
- `task_id` resumes the SAME child: the transcript, the original agent id, and
  the depth are all pinned. A resumed session cannot be re-pointed at a broader
  role.
- An unknown `task_id` starts a new child instead of failing the turn.
- Stored transcripts deliberately exclude the system message; on resume the
  harness regenerates the live system prompt (`buildResumeMessages`), so a
  resumed child keeps its current role contract and permission context.

## 6. Result contract (§75.8)

The parent receives a small envelope, never the child transcript:

```json
{
  "task_id": "sub:main:explore:1",
  "agent": "explore",
  "status": "completed",
  "summary": "Found `authenticate` defined in src/auth.ts (line 1).",
  "tool_calls": 3,
  "duration_ms": 812
}
```

Rendered into the tool result as a human-readable header plus a
`<subagent_output>` block and a `<task_result>` JSON companion, so the parent can
either read the prose or branch on structured status.

## 7. Tool scope enforcement — two independent layers

1. **Schema layer** — the child's tool schemas are filtered by the derived
   scope (`toolRegistry.schemasFiltered`), so out-of-scope tools are not
   advertised. `task` is removed from the schemas once the depth limit is
   reached.
2. **Gate layer** — `AgentHarness.dispatchTool` evaluates the scope *before* the
   security gateway. `deny` is refused unconditionally; `ask` routes into the
   normal approval flow. This is what protects against a model calling a tool it
   was never shown.

The scope gate does **not** replace the SecurityEngine — every child tool call
still goes through the canonical permission → execute → verify pipeline.
Delegation is classified as an execution-class internal tool and the depth limit
is enforced in the engine too, so a nested `task` is a `CRITICAL_DENY` even if a
future front-end forgets to attach a scope.

## 8. Cancellation (§75.10)

One `AbortSignal` flows parent → child engine → model request → tool → shell
process group. A pre-aborted signal yields `status: "cancelled"` (never
success); an in-flight shell is killed through the existing process-tree abort
wiring (`exitCode: 130`, verified promptly). The parent session and the CLI
remain alive — no `process.exit` on a normal cancel.

## 9. Depth limit (§75.11)

Default `subagentMaxDepth = 1`: primary (0) → child (1) is allowed, grandchild
(2) is refused. Enforced in three places: schema filtering, `SubagentManager`
(returns a typed error envelope), and `SecurityEngine` (`CRITICAL_DENY`).

## 10. Tests

| Suite | Tests | Coverage |
|---|---|---|
| `subagentScoping.test.ts` | 38 | registry + modes, YAML grammar, config validation, permission derivation (incl. no-escalation across all sandbox modes), per-role tool scope, sessions, prompt composition, `task` registration, architecture guard |
| `subagentRuntimeE2E.test.ts` | 9 | plan-bypass blocked, explore delegation + isolation, coder self-repair inside a child, resume, depth limit, cancellation (signal + shell kill), scope ASK/DENY |

E2E drives the real engine, real registry and real permission derivation against
a **scripted model** (`globalThis.fetch`), so a failure is always a runtime
defect, never a model-compliance issue.

### Deterministic E2E results

| Scenario | Result |
|---|---|
| A. read-only parent → `task(coder)` → `write_file` | ✅ denied, no file created |
| B. `task(explore)` → grep → report; parent sees one envelope | ✅ |
| C. `task(coder)` → read → test fail → edit → test pass (real `bun test`) | ✅ file changed on disk |
| D. `task_id` resume | ✅ same session, history retained |
| E. grandchild blocked | ✅ |
| F. cancellation | ✅ child cancelled; `sleep 8` killed in ~0.2 s |
| G. scope `ask` | ✅ prompts once; denial = no side effect; approval runs it |
| G2. scope `deny` | ✅ never unlockable by approval |

### Gates

`bun run typecheck` PASS · **1381 pass / 2 skip / 0 fail** (102 files) ·
`bun run build` PASS · `npm pack --dry-run` PASS (`toolnetcli@1.2.4`) ·
Phase 73 regression PASS · Phase 74 regression PASS (87 tests across the core,
LSP and critical-scenario suites).

## 11. Defects found and fixed during this phase

1. **Permission-derivation allowlist hole (CORE_RUNTIME, security).** The
   derived scope lost the agent allowlist for tools listed in neither scope's
   explicit rules, so a read-only `explore` child would have fallen back to the
   parent default and could reach e.g. `create_artifact`. Fixed by intersecting
   parent ∩ agent ∩ requested allowlists and filtering the result against the
   parent scope.
2. **Resume discarded child history (CORE_RUNTIME).** `AgentEngine`'s legacy
   `SUBAGENT` branch triggered whenever an `agentRole` was present, so a resumed
   child silently restarted from a single message and lost its transcript. The
   branch now requires the absence of a supplied transcript.
3. **Subagent role prompts were ignored (CORE_RUNTIME).** `runSubagent` always
   generated its own legacy role prompt and dropped `options.systemPrompt`, so
   every AgentDefinition prompt was discarded. It now honours a supplied system
   prompt and keeps the legacy generator as the fallback.
4. **`grep` never matched anything (CORE_RUNTIME).** `toolGrep` passed
   `--exclude=.*` to GNU grep, which matches *every* filename under fnmatch
   semantics without `FNM_PERIOD` — so every search returned "No matches found".
   Found by the explore-delegation E2E. Replaced with explicit
   `--exclude-dir` names; verified against the repo and a temp fixture.
5. **`task` was classified as an unknown external MCP tool.** The SecurityEngine
   fell through to `MCP_TOOL`, which denies mutating tools in `workspace` mode —
   the default. Delegation is now classified as an execution-class internal tool
   and covered by the delegation depth gate.

Two of these (1 and 5) would have been security/availability defects. All five
are covered by regression tests.

## 12. Known limitations

1. **Child tool activity is not streamed into the parent UI.** The child's
   tool calls are recorded in its own session and the audit log, but the parent
   conversation shows only the `task` tool's start/complete plus the final
   envelope. Wiring the child's events into the parent stream is deliberately
   deferred so Phase 73's rendering path is not disturbed.
2. **`spawn_subagent` remains as a legacy dispatch alias.** It is no longer
   advertised to the model (`aliasOf: "task"`) but still resolves for old
   sessions and the teamwork/turbo paths; those call `harness.runSubagent`
   directly, which is the same kernel.
3. **`maxDepth` is a code/config value, not a per-session user setting.**
   Raising it requires the SecurityEngine gate (which reads
   `context.subagent.maxDepth`) to be given the same value — the default of 1 is
   consistent everywhere today.
4. **Foreground only.** No `background: true`, parallel scheduler, task inbox or
   multi-agent DAG. The session model (statuses, ids, per-child transcripts) is
   shaped so those can be added without a rewrite — this is Phase 76.
5. **Custom agents are still JSON-compatible YAML only.** The parser supports
   the documented grammar; richer YAML features are intentionally out of scope.
6. **Live model delegation was not re-run** (the `alims-intl.llm` gateway was
   timing out during this phase). Core delegation behaviour is proven
   deterministically; real-model compliance remains classified separately as
   MODEL_COMPLIANCE, never CORE_RUNTIME.
