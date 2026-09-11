/**
 * Phase 77.6 — Canonical Hook Contract
 *
 * A hook is a deterministic observation/decision point in the agent lifecycle.
 * Plugins register hooks through the PluginContext; the runtime fires them from
 * exactly one place per lifecycle edge, so no integration can bypass ordering.
 *
 * Three hook classes exist because they carry different safety weight:
 *   observe   — pure telemetry; failure is cosmetic, never affects execution.
 *   transform — may rewrite the payload (e.g. tool args) but cannot block.
 *   block     — may veto the operation (e.g. `tool.before` -> deny).
 *
 * The class is declared by the registry table, not by the plugin, so a plugin
 * cannot downgrade a security hook into an advisory one.
 */

/** Lifecycle edges the runtime actually fires (see `wired.ts` for the map). */
export type HookName =
  | "agent.start"
  | "agent.end"
  | "model.before"
  | "model.after"
  | "tool.before"
  | "tool.after"
  | "tool.error"
  | "file.beforeWrite"
  | "file.afterWrite"
  | "shell.before"
  | "session.start"
  | "session.end"
  | "background.started"
  | "background.completed"
  | "teamwork.node.before"
  | "teamwork.node.after";

export type HookClass = "observe" | "transform" | "block";

/**
 * How a hook responded to the lifecycle event.
 *
 * `continue` and `undefined` are equivalent (a hook that only observes).
 * `deny` is only honoured for `block`-class hooks.
 * `transform` is only honoured for `transform`/`block`-class hooks.
 */
export type HookDecision =
  | { action: "continue" }
  | { action: "deny"; reason: string }
  | { action: "transform"; args: Record<string, unknown> };

/**
 * What happens when the hook itself throws.
 *
 * - `ignore` — swallow, log at debug.
 * - `warn`   — swallow, record a warning in the run report. Default for observe.
 * - `block`  — fail closed: the operation is denied. Default for `block`-class
 *              hooks, because a security hook that cannot run must not silently
 *              become a no-op.
 */
export type HookFailurePolicy = "ignore" | "warn" | "block";

/** Default failure policy per hook name (overridable per registration). */
export const DEFAULT_FAILURE_POLICY: Record<HookName, HookFailurePolicy> = {
  "agent.start": "warn",
  "agent.end": "warn",
  "model.before": "warn",
  "model.after": "warn",
  "tool.before": "block",
  "tool.after": "warn",
  "tool.error": "warn",
  "file.beforeWrite": "block",
  "file.afterWrite": "warn",
  "shell.before": "block",
  "session.start": "warn",
  "session.end": "warn",
  "background.started": "warn",
  "background.completed": "warn",
  "teamwork.node.before": "warn",
  "teamwork.node.after": "warn",
};

/**
 * Hook class per name. `tool.before`, `file.beforeWrite` and `shell.before`
 * are pre-execution veto points; everything else observes or transforms.
 */
export const HOOK_CLASS: Record<HookName, HookClass> = {
  "agent.start": "observe",
  "agent.end": "observe",
  "model.before": "transform",
  "model.after": "observe",
  "tool.before": "block",
  "tool.after": "transform",
  "tool.error": "observe",
  "file.beforeWrite": "block",
  "file.afterWrite": "transform",
  "shell.before": "block",
  "session.start": "observe",
  "session.end": "observe",
  "background.started": "observe",
  "background.completed": "observe",
  "teamwork.node.before": "block",
  "teamwork.node.after": "observe",
};

export const HOOK_NAMES = Object.keys(HOOK_CLASS) as HookName[];

export function isHookName(value: string): value is HookName {
  return Object.prototype.hasOwnProperty.call(HOOK_CLASS, value);
}

/**
 * Payload handed to every hook. `output` is the mutable payload for transform
 * hooks; observe hooks get a frozen copy.
 */
export interface HookInvocation<Input = unknown, Output = unknown> {
  name: HookName;
  input: Input;
  output: Output;
  /** Monotonic sequence for this lifecycle event (1-based). */
  sequence: number;
  sessionId?: string;
  /** Which plugin/runtime registered the hook — diagnostics only. */
  owner: string;
}

export type HookHandler<Input = any, Output = any> = (
  invocation: HookInvocation<Input, Output>,
) => Promise<HookDecision | void> | HookDecision | void;

export interface HookRegistration {
  name: HookName;
  handler: HookHandler;
  /** Registration source, e.g. "plugin:my-plugin" or "builtin". */
  owner: string;
  /** Overrides DEFAULT_FAILURE_POLICY for this registration. */
  failurePolicy?: HookFailurePolicy;
  /** Per-hook timeout. Defaults to HOOK_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Lower runs first; ties broken by registration order (stable). */
  priority?: number;
}

export interface HookRunReport {
  name: HookName;
  /** Number of hooks considered (before skipping non-matching names). */
  invoked: number;
  /** Owners whose hooks completed successfully, in execution order. */
  completed: string[];
  /** Owners whose hooks failed, with the policy that was applied. */
  failures: Array<{ owner: string; policy: HookFailurePolicy; error: string }>;
  /** Owners whose hooks skipped (returned `continue`). */
  skipped: string[];
  /** Set when a hook vetoed the operation. */
  deniedBy?: { owner: string; reason: string };
  /** Final payload after transform hooks ran. */
  output: unknown;
}

export const HOOK_TIMEOUT_MS = 5_000;
