# Phase 76 — Background Tasks + Teamwork DAG

Phase 73 (Agent Core), 74 (LSP) and 75 (Scoped Subagents) were already green.
Phase 76 adds **asynchronous execution** and **dependency scheduling** without
introducing a second runtime: one job service, one agent engine, one tool
registry, one model adapter.

```
task(background) / teamwork
        │
        ▼
  BackgroundJobService        ← the ONLY job registry
        │
        ▼
  SubagentManager             ← child session + scoped tools + derived permission
        │
        ▼
  Agent Engine (AgentHarness) ← the ONE loop
        │
        ▼
  ModelAdapter → Provider
        │
        ▼
  ToolRegistry → Permission → Execute → Verify → ToolResult
```

## 1. Background Job Service (`src/core/background`)

`types.ts` — canonical `BackgroundJob`:

```ts
interface BackgroundJob {
  id; type: "subagent" | "tool" | "teamwork"; title;
  status: "pending" | "queued" | "running" | "completed" | "error" | "cancelled";
  parentSessionId; childSessionId?;
  createdAt; startedAt?; completedAt?;
  result?; error?; errorKind?;
  metadata?;
}
```

`service.ts` — `BackgroundJobService` with one API surface:
`start · get · list · wait · cancel · complete · fail · extend · promote ·
subscribe · cancelBySession · stats · shutdown`.

Design guarantees:

| Concern | Behaviour |
|---|---|
| Bounded concurrency | jobs above `maxConcurrency` (default 4) wait in `queued`; `pump()` claims capacity |
| Dedupe | `start()` with a live id **joins** it instead of forking duplicate work |
| Stale settlement guard | every job carries a `generation`; a superseded run can never settle a newer job |
| `extend()` | chains more work onto a live job; refused once the job has settled |
| `promote()` | hands a running job to the background without interrupting it |
| Failure classification | `permission · timeout · provider · tool · runtime · cancelled` — drives retry policy |
| `onSettle` hook | runs detached, so a slow/throwy listener can never affect settlement |

`persistence.ts` — one snapshot file. On load, anything that was
`pending/queued/running` in a **previous process** is marked interrupted; a
restarted process never reports a stale `running` job. A corrupt file degrades
to empty instead of crashing the CLI.

`inbox.ts` — `SessionInbox`, the notification channel that replaces polling.
When work settles it pushes a synthetic message into the owning session; the
agent loop drains it before its next model turn:

```xml
<task id="sub:…" state="completed">
  <summary>…</summary>
  <subagent_output>…</subagent_output>
</task>
```

## 2. Background `task` mode (`src/core/agent/agents/taskTool.ts`)

```json
{ "prompt": "…", "subagent_type": "explore", "background": true }
```

The tool returns **immediately** with a `<job>` placeholder and an explicit
instruction: *do not sleep, poll, ask for status, or duplicate the work*. The
job owns the abort signal (the parent turn may be long over), and on settlement
the result is injected into the parent session. Cancelling the job aborts the
child engine → provider request → running shell/process tree.

No model polling is required or encouraged; the runtime delivers the result.

## 3. Teamwork DAG (`src/core/teamwork`)

`TeamworkPlan` is **data**, not a runtime. Each node becomes a `BackgroundJob`
whose work is a scoped subagent run on the shared engine:

```
TeamNode → BackgroundJob → SubagentManager → Agent Engine → result
```

* `validation.ts` — pure validation runs **before any node executes**: unique
  ids, dependencies exist, no self-dependency, no cycles (Kahn), agent exists
  and is subagent-capable, non-empty prompt, bounded attempts/timeouts, known
  conditions. Invalid plan → `status: "error"`, `issues: [...]`, zero nodes run.
* `engine.ts` — a dependency scheduler only:
  * independent nodes run in parallel, bounded by the **same** job queue;
  * dependent nodes receive only their declared dependency outputs (truncated,
    wrapped in `<dependency_outputs>`) — never another node's transcript;
  * `condition`: `on_success` (default) · `on_failure` · `always`; failure
    propagates as `skipped` unless a recovery node opts in;
  * retries are bounded (`MAX_NODE_ATTEMPTS = 5`), never blind — permission
    denials and cancellations are not retried;
  * per-node `timeoutMs` aborts the child **and its process tree**;
  * cancelling the plan cancels every live node; remaining nodes are marked
    `cancelled`/`skipped` deterministically;
  * plan status: `cancelled` if aborted, else `error` if any node failed and no
    recovery node declared it handled, else `completed`.
* `tool.ts` — the canonical `teamwork` tool only **submits** a plan; it adds no
  execution path. `background: true` runs the whole plan as one job whose nodes
  are still the unit of execution.

## 4. Verified side effects — no fake success

A subagent never throws; it reports failure in its **result envelope**. A
generic background job therefore stays `completed` even when its child failed.
Phase 76 closes both paths where that leaked into a success claim:

1. `TeamworkEngine.toNodeResult` now reads the child envelope's own `status`
   before projecting a node outcome.
2. `taskTool.notifyParent` derives the notification status from the child's
   verdict, so a failed background child is reported as `error`, not
   `completed`.

## 5. Security

* A node/child inherits `parent permission ∩ agent permission`; delegation
  cannot widen a scope (Phase 75 derivation, unchanged).
* `teamwork` is classified as an internal execution entry point
  (`SHELL_EXECUTE`, delegation depth gate) exactly like `task`, so it is not
  mistaken for an unknown external MCP tool.
* Depth guard still applies: a plan cannot exceed `subagentMaxDepth`.
* Plan-mode parent that denies writes cannot create a file via a `coder` node.

## 6. Tests

| Suite | Tests | What it proves |
|---|---|---|
| `backgroundJobs.test.ts` | 25 | lifecycle, classification, events, wait/timeout, bounded concurrency, dedupe/extend/promote, persistence + recovery, shutdown, inbox |
| `backgroundTaskE2E.test.ts` | 3 | returns immediately + non-blocking; completion injected once (no polling); cancel kills a real `sleep 30` shell; resume by `task_id` reuses the same child session |
| `teamworkDag.test.ts` | 18 | validation (ids/deps/cycles/agents/bounds), dependency ordering + output forwarding, real parallel overlap, failure → skip, `always`/`on_failure`, bounded retry, timeout, cancellation, invalid plan never executes |
| `teamworkE2E.test.ts` | 3 | `teamwork` tool → explore → coder → tester with a **real file mutation** on disk and dependency outputs observed downstream; plan-mode denial leaves no file; cancelling a plan kills the running shell |

E2E suites drive the **real** engine, manager, registry and job service against
a scripted model, so a failure there is always a CORE_RUNTIME defect.

## 7. GATES

```
bun run typecheck      PASS
bun test               PASS  1430 pass / 2 skip / 0 fail  (106 files)
bun run build          PASS
npm pack --dry-run     PASS  toolnetcli@1.2.4
Phase 73 regression    PASS  (core deterministic E2E, harness core, critical scenarios)
Phase 74 regression    PASS  (LSP core / integration / golden E2E)
Phase 75 regression    PASS  (subagent scoping + runtime E2E)
```

## 8. Known limitations

1. **Foreground-first UX.** Background results arrive on the parent's *next*
   turn; there is no push notification while the parent is idle at a prompt.
2. **No DAG node overlaps across plans.** Concurrency is global
   (`maxBackgroundJobs`); a plan cannot reserve capacity.
3. **Recovery is honest, not magic.** A job interrupted by a crashed process is
   marked interrupted — a child agent turn cannot be replayed from a lifecycle
   record, so it is never pretended to have resumed.
4. **Cancellation is cooperative for non-shell tools.** Shell process trees are
   killed; a provider that ignores `AbortSignal` is bounded by request timeout.
5. **Planner is model-driven.** `teamwork` accepts whatever valid DAG the model
   proposes; there is no automatic planner (deliberately — data, not a runtime).

## 9. Definition of Done

* [x] one `BackgroundJobService`, bounded queue, dedupe, persistence + recovery
* [x] background `task` returns immediately; completion injected; no polling
* [x] cancellation kills the process tree; parent CLI survives
* [x] DAG validation before execution (cycles, deps, agents, bounds)
* [x] parallel independent nodes; structured dependency outputs
* [x] conditions, bounded retry, timeout, deterministic failure propagation
* [x] scoped permissions; plan-mode bypass blocked
* [x] same Agent Engine · same AgentRegistry · same ToolRegistry · same ModelAdapter
* [x] all regression gates PASS; docs complete
