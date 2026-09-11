/**
 * Phase 77.12 — canonical wired-hook inventory.
 *
 * This file is the machine-readable counterpart of the "Where hooks actually
 * fire" table in docs/phase-77-plugins-mcp-hooks.md. Every hook name exported
 * by the public contract (`types.ts`) MUST appear here with its real call
 * site; `hookInventory.test.ts` fails the build if the two drift apart, which
 * is the static guard that keeps "declared-but-unfired" hooks out of the
 * contract permanently.
 *
 * Rule: a hook may be added to `HookName` only together with its entry here
 * AND the runtime edge that fires it. Removing a hook requires removing both.
 */

import type { HookName } from "./types";

export interface WiredHookInfo {
  /** Module + function holding the only `hookRegistry.run(name, …)` edge. */
  callSite: string;
  /** Human statement of when the edge fires (part of the public contract). */
  semantics: string;
  /** Cardinality per contract edge. */
  cardinality: string;
  /** True when the edge passes a mutable payload hooks may rewrite. */
  canTransform: boolean;
  /** True when a block-class deny is honoured at this edge. */
  canVeto: boolean;
}

/**
 * Every production hook edge. Order matches the contract table in the docs.
 * `session.start` is wired in `AgentHarness.fireSessionStart`; `shell.after`
 * was removed in 77.12 as redundant with `tool.after` (see docs §1).
 */
export const WIRED_HOOKS: Record<HookName, WiredHookInfo> = {
  "agent.start": {
    callSite: "src/lib/harness/agentHarness.ts → AgentHarness.executeLoop",
    semantics: "One agent turn begins, whatever the front-end (TUI, headless, REPL, subagent, teamwork node).",
    cardinality: "exactly once per executeLoop entry",
    canTransform: false,
    canVeto: false,
  },
  "agent.end": {
    callSite: "src/lib/harness/agentHarness.ts → AgentHarness.executeLoop (success + throw path)",
    semantics: "The turn is over; carries success flag and error message when it failed.",
    cardinality: "exactly once per executeLoop exit (success or throw)",
    canTransform: false,
    canVeto: false,
  },
  "model.before": {
    callSite: "src/lib/harness/modelAdapter.ts → ModelAdapter.prepareRequest",
    semantics: "A provider request is about to be assembled; may rewrite temperature, reasoning effort and appended system text.",
    cardinality: "exactly once per model call",
    canTransform: true,
    canVeto: false,
  },
  "model.after": {
    callSite: "src/lib/harness/modelAdapter.ts → ModelAdapter.complete / .stream (finally)",
    semantics: "A model call returned (or threw); carries outcome: completed | error.",
    cardinality: "exactly once per model call, success and error",
    canTransform: false,
    canVeto: false,
  },
  "tool.before": {
    callSite: "src/lib/security/toolGateway.ts → ToolGateway.execute",
    semantics: "A tool call was requested; runs BEFORE the permission decision so a veto means no process, no file.",
    cardinality: "once per gateway execution",
    canTransform: true,
    canVeto: true,
  },
  "shell.before": {
    callSite: "src/lib/security/toolGateway.ts → ToolGateway.execute (shell-class tools)",
    semantics: "A shell-class tool passed tool.before and permission is next; the dedicated shell veto point.",
    cardinality: "once per shell-class execution",
    canTransform: true,
    canVeto: true,
  },
  "tool.after": {
    callSite: "src/lib/security/toolGateway.ts → ToolGateway.execute (success and cache hits)",
    semantics: "A tool succeeded; receives the normalized result envelope (also covers shell tools — shell.after was removed as redundant).",
    cardinality: "once per successful execution",
    canTransform: true,
    canVeto: false,
  },
  "tool.error": {
    callSite: "src/lib/security/toolGateway.ts → ToolGateway.execute (non-zero exit or executor throw)",
    semantics: "A tool failed; exactly one of tool.after / tool.error fires per execution.",
    cardinality: "once per failed execution",
    canTransform: false,
    canVeto: false,
  },
  "file.beforeWrite": {
    callSite: "src/lib/security/toolGateway.ts → ToolGateway.execute (after permission, before mutation)",
    semantics: "Bytes are about to be written; a veto means no mutation, no file.afterWrite, no tool.after.",
    cardinality: "once per file-write execution",
    canTransform: true,
    canVeto: true,
  },
  "file.afterWrite": {
    callSite: "src/lib/security/toolGateway.ts → ToolGateway.execute (after a verified write)",
    semantics: "The write landed; the specific post edge completes before the generic tool.after edge.",
    cardinality: "once per verified write",
    canTransform: true,
    canVeto: false,
  },
  "session.start": {
    callSite: "src/lib/harness/agentHarness.ts → AgentHarness.fireSessionStart (called from executeLoop)",
    semantics: "Session activation: the first turn in this runtime that runs under a sessionId — fresh, resumed, or child session alike.",
    cardinality: "exactly once per sessionId per process lifetime",
    canTransform: false,
    canVeto: false,
  },
  "session.end": {
    callSite: "src/tui/app.ts → shutdownAndExit (bounded teardown)",
    semantics: "The CLI is shutting down and the current session will not run more turns.",
    cardinality: "once per CLI process shutdown",
    canTransform: false,
    canVeto: false,
  },
  "background.started": {
    callSite: "src/core/background/service.ts → BackgroundJobService.launch",
    semantics: "A background job started running; fired detached so a plugin can never delay startup.",
    cardinality: "once per job start (and per restart)",
    canTransform: false,
    canVeto: false,
  },
  "background.completed": {
    callSite: "src/core/background/service.ts → BackgroundJobService.settle",
    semantics: "A background job settled with a status; fired detached, never affects settlement.",
    cardinality: "once per job settlement",
    canTransform: false,
    canVeto: false,
  },
  "teamwork.node.before": {
    callSite: "src/core/teamwork/engine.ts → TeamworkEngine.runNode",
    semantics: "A DAG node is about to spawn its child; a veto means no child, no tools, no process.",
    cardinality: "once per node attempt",
    canTransform: true,
    canVeto: true,
  },
  "teamwork.node.after": {
    callSite: "src/core/teamwork/engine.ts → TeamworkEngine.runNode (normalized result)",
    semantics: "A node attempt finished; receives the same normalized result the plan aggregates.",
    cardinality: "once per executed node attempt",
    canTransform: false,
    canVeto: false,
  },
} as const;

/** Every hook the runtime fires. Derived from the registry table itself. */
export const WIRED_HOOK_NAMES: readonly HookName[] = Object.keys(WIRED_HOOKS) as HookName[];

/**
 * True when `name` is part of the public contract AND has a real call site.
 * This is the predicate the inventory guard tests.
 */
export function isHookWired(name: HookName): boolean {
  return Object.prototype.hasOwnProperty.call(WIRED_HOOKS, name);
}
