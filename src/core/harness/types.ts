/**
 * Phase 81 §2/§3 — HarnessProfile contract.
 *
 * A HarnessProfile is POLICY for the one AgentHarness, not a second runtime.
 * It owns no provider instance, no model reference, and no execution loop. The
 * pipeline is unchanged:
 *
 *   Task → AgentHarness → HarnessProfile → AgentEngine → ModelRouter
 *        → ModelAdapter → Provider
 *
 * and tool execution stays:
 *
 *   Model output → ToolRegistry → Permission → ToolGateway → Tool
 *
 * Every policy below is deliberately incapable of changing a security verdict:
 * `ToolPolicy` may only choose a SUBSET of already-allowed tools, and
 * `ContextPolicy` may only change how aggressively history is compressed. A
 * profile can never turn DENY into ALLOW (see §7 and the invariant test).
 *
 * `default` is an IDENTITY profile: with it selected, the harness behaves
 * exactly as it did before Phase 81. That is what makes this layer safe to
 * enable incrementally.
 */

/** Instruction-strategy knobs. A policy never bypasses permission or sandbox. */
export interface PromptPolicy {
  /** Include the coding-agent operating policy block. */
  includeCodingPolicy: boolean;
  /** Include the tool-use guidance block. */
  includeToolUseGuidance: boolean;
  /** Include the workspace/project summary block. */
  includeProjectContext: boolean;
  /** Include the live session-memory and tool-rules snippets. */
  includeMemoryAndToolRules: boolean;
  /** Profile-specific instruction block appended after the standard blocks. */
  instructions?: string;
  /** How much of the standard preamble to emit. */
  verbosity: "full" | "balanced" | "minimal";
}

/**
 * Tool EXPOSURE policy — never tool PERMISSION.
 *
 * `allow`/`deny` filter which of the already-registered tools the model is
 * offered. The security gateway still evaluates every call afterwards, so
 * filtering can only ever make the agent less capable, never more privileged.
 */
export interface ToolPolicy {
  /** Explicit allow-list of tool names. `undefined` = every registered tool. */
  allow?: string[];
  /** Tools removed from the offered set. Applied after `allow`. */
  deny?: string[];
  /** Ordering hint — listed tools first, remaining keep registry order. */
  prefer?: string[];
  /** Extra tool-use instruction appended to the prompt. */
  guidance?: string;
}

/** Loop bounds. Bounds are canonical: nothing else may hard-code its own. */
export interface ContinuationPolicy {
  /** Model turns for one run. `undefined` = the caller's existing default. */
  maxTurns?: number;
  /** Consecutive identical (tool, args) invocations tolerated before abort. */
  maxRepeatedToolCalls: number;
  /** Consecutive turns with no observable progress tolerated before abort. */
  maxConsecutiveNoProgressTurns: number;
}

/**
 * Context strategy. Reuses the existing ContextEngine (`prepareMessagesForApi`)
 * rather than introducing a second token estimator.
 */
export interface ContextPolicy {
  mode: "full" | "balanced" | "compact";
  /** Run the engine's priority-based tool-result pruning. */
  autoPrune: boolean;
  /** Force atomic compaction this turn. */
  forceCompact: boolean;
  /**
   * Permission decisions (especially DENY) are protected from pruning so the
   * model can never "forget" a refusal and retry as if it had never happened.
   */
  protectPermissionResults: boolean;
}

/** When a run may be reported as complete, and with what verdict. */
export interface CompletionPolicy {
  /** Run the Phase 73.9 evidence gate before accepting a text-only answer. */
  enforceEvidence: boolean;
  /**
   * A task that required a mutation cannot be SUCCESS when the workspace was
   * never changed — the model saying "Done." is not evidence.
   */
  requireEvidenceForSuccess: boolean;
  /** A claim of passing tests without a recorded test run is not SUCCESS. */
  requireVerificationForSuccess: boolean;
}

export interface HarnessProfile {
  id: string;
  /** Bumped when a profile's behaviour changes; recorded on eval results. */
  version: string;
  displayName: string;
  description: string;
  promptPolicy: PromptPolicy;
  toolPolicy: ToolPolicy;
  continuationPolicy: ContinuationPolicy;
  contextPolicy: ContextPolicy;
  completionPolicy: CompletionPolicy;
  /** Task types this profile is auto-selected for (§17). */
  autoFor?: string[];
}

/** Result of resolving a profile for a run. */
export interface HarnessResolution {
  profile: HarnessProfile;
  /** Whether the caller named the profile explicitly. */
  explicit: boolean;
  reason: string;
}

export interface HarnessResolveRequest {
  /** Explicit id from config, CLI, TUI or an eval case. Wins over auto. */
  profile?: string;
  /**
   * Task type from the canonical TaskClassifier (auto-resolution only).
   * Execution mode is NOT consulted: HEADLESS/TURBO/SUBAGENT/TEAMWORK already
   * own their turn budgets and prompts. See profiles.ts.
   */
  taskType?: string;
}

/**
 * A named policy module, so callers can inspect what a profile will do without
 * reaching into the profile object's internals.
 */
export type HarnessPolicyName =
  | "promptPolicy"
  | "toolPolicy"
  | "continuationPolicy"
  | "contextPolicy"
  | "completionPolicy";

export const HARNESS_POLICY_NAMES: HarnessPolicyName[] = [
  "promptPolicy",
  "toolPolicy",
  "continuationPolicy",
  "contextPolicy",
  "completionPolicy",
];
