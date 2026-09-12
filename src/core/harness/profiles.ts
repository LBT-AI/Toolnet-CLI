/**
 * Phase 81 §4 — built-in harness profiles.
 *
 * All five profiles are POLICY ONLY. None of them names a model, constructs a
 * provider, or changes a security rule. `default` is an identity profile: with
 * it selected the harness does exactly what it did before Phase 81, which is
 * what makes this layer safe to adopt profile by profile.
 *
 * Auto-resolution mappings live here and ONLY here (§17) so no CLI/TUI/harness
 * branch has to know which profile suits which task.
 */

import type { HarnessProfile } from "./types";

/**
 * §8 — canonical loop bounds. Nothing else in the codebase may invent its own
 * repeat/progress limits; a profile either uses one of these or disables the
 * bound explicitly.
 */
export const CANONICAL_MAX_REPEATED_TOOL_CALLS = 3;
export const CANONICAL_MAX_DUPLICATE_SENSITIVE_TOOL_CALLS = 2;
export const CANONICAL_MAX_CONSECUTIVE_NO_PROGRESS_TURNS = 3;

/** `0` disables a bound. Only the identity profile uses this. */
export const NO_PROGRESS_BOUND_DISABLED = 0;

export const DEFAULT_HARNESS_PROFILE_ID = "default";

/** Prompt policy that reproduces the pre-Phase-81 prompt exactly. */
const FULL_PROMPT = {
  includeCodingPolicy: true,
  includeToolUseGuidance: true,
  includeProjectContext: true,
  includeMemoryAndToolRules: true,
  verbosity: "full",
} as const;

/** Context policy that reproduces the pre-Phase-81 context pipeline exactly. */
const FULL_CONTEXT = {
  mode: "full",
  autoPrune: true,
  forceCompact: false,
  protectPermissionResults: true,
} as const;

const STRICT_COMPLETION = {
  enforceEvidence: true,
  requireEvidenceForSuccess: true,
  requireVerificationForSuccess: true,
} as const;

export const defaultProfile: HarnessProfile = {
  id: "default",
  version: "1.0.0",
  displayName: "Default",
  description:
    "Identity profile. Full prompt, every registered tool, pre-Phase-81 loop bounds.",
  promptPolicy: { ...FULL_PROMPT },
  // No allow/deny/prefer and no guidance: every registered tool is exposed
  // exactly as before Phase 81.
  toolPolicy: {},
  continuationPolicy: {
    // No turn override: the caller's existing default (10 / 5 / 8) still wins.
    maxRepeatedToolCalls: CANONICAL_MAX_REPEATED_TOOL_CALLS,
    maxConsecutiveNoProgressTurns: NO_PROGRESS_BOUND_DISABLED,
  },
  contextPolicy: { ...FULL_CONTEXT },
  completionPolicy: { ...STRICT_COMPLETION },
  autoFor: [
    "general",
    "search",
    "review",
    "vision",
    "long_context",
    "fast",
    "background",
  ],
};

export const minimalProfile: HarnessProfile = {
  id: "minimal",
  version: "1.0.0",
  displayName: "Minimal",
  description:
    "Smallest instruction surface. No tools or security rules are removed — only prompt guidance.",
  promptPolicy: {
    includeCodingPolicy: false,
    includeToolUseGuidance: false,
    includeProjectContext: true,
    includeMemoryAndToolRules: false,
    verbosity: "minimal",
  },
  // Deliberately identical to `default`: a smaller prompt must never mean a
  // different permission surface.
  toolPolicy: {},
  continuationPolicy: {
    maxTurns: 6,
    maxRepeatedToolCalls: CANONICAL_MAX_REPEATED_TOOL_CALLS,
    maxConsecutiveNoProgressTurns: CANONICAL_MAX_CONSECUTIVE_NO_PROGRESS_TURNS,
  },
  contextPolicy: { ...FULL_CONTEXT },
  completionPolicy: { ...STRICT_COMPLETION },
};

export const codingProfile: HarnessProfile = {
  id: "coding",
  version: "1.0.0",
  displayName: "Coding",
  description:
    "Inspect → edit → verify. Completion requires evidence, so a narrated fix with no change is not success.",
  promptPolicy: {
    ...FULL_PROMPT,
    instructions:
      "Work in three explicit phases: INSPECT the relevant files before changing them, EDIT the smallest correct change, then VERIFY it with the project's own test/typecheck/build command.\n" +
      "Do NOT claim a file was modified unless a write/edit tool actually ran, and do NOT claim tests pass unless you ran them and saw the result. If verification has not been performed for a task that requires it, say so plainly instead of reporting success.",
  },
  toolPolicy: {
    prefer: ["read_file", "list_files", "grep", "glob", "shell", "write_file", "edit_file"],
  },
  continuationPolicy: {
    maxRepeatedToolCalls: CANONICAL_MAX_REPEATED_TOOL_CALLS,
    maxConsecutiveNoProgressTurns: CANONICAL_MAX_CONSECUTIVE_NO_PROGRESS_TURNS,
  },
  contextPolicy: { ...FULL_CONTEXT },
  completionPolicy: { ...STRICT_COMPLETION },
  autoFor: ["coding", "debugging"],
};

export const toolHeavyProfile: HarnessProfile = {
  id: "tool-heavy",
  version: "1.0.0",
  displayName: "Tool heavy",
  description:
    "Encourages real tool use and rejects duplicate or unnecessary calls. Tighter repeat bound than default.",
  promptPolicy: {
    ...FULL_PROMPT,
    instructions:
      "Prefer acting over describing: when the task needs information or a change, call the tool instead of speculating about the answer.\n" +
      "Never repeat an identical tool call with identical arguments — if a call already returned, use its result. Batch independent lookups instead of issuing them one at a time.",
  },
  toolPolicy: {
    guidance:
      "Use the fewest tool calls that fully answer the request; do not re-run an identical call.",
  },
  continuationPolicy: {
    maxRepeatedToolCalls: CANONICAL_MAX_DUPLICATE_SENSITIVE_TOOL_CALLS,
    maxConsecutiveNoProgressTurns: CANONICAL_MAX_CONSECUTIVE_NO_PROGRESS_TURNS,
  },
  contextPolicy: { ...FULL_CONTEXT },
  completionPolicy: { ...STRICT_COMPLETION },
  autoFor: ["tool_heavy"],
};

export const reasoningProfile: HarnessProfile = {
  id: "reasoning",
  version: "1.0.0",
  displayName: "Reasoning",
  description:
    "More turns for planning and analysis, with a harder no-progress bound. Conclusions only — no chain-of-thought exposure.",
  promptPolicy: {
    ...FULL_PROMPT,
    instructions:
      "Take the time to plan before acting, and state your plan briefly before executing it.\n" +
      "Report conclusions and the evidence behind them. Do NOT expose internal step-by-step chain-of-thought, and do not pad the answer with restated reasoning.",
  },
  toolPolicy: {},
  continuationPolicy: {
    maxTurns: 16,
    maxRepeatedToolCalls: CANONICAL_MAX_REPEATED_TOOL_CALLS,
    maxConsecutiveNoProgressTurns: CANONICAL_MAX_CONSECUTIVE_NO_PROGRESS_TURNS,
  },
  contextPolicy: { ...FULL_CONTEXT },
  completionPolicy: { ...STRICT_COMPLETION },
  autoFor: ["reasoning", "planning"],
};

/** Registration order is also the deterministic `list()` order. */
export const BUILTIN_HARNESS_PROFILES: HarnessProfile[] = [
  defaultProfile,
  minimalProfile,
  codingProfile,
  toolHeavyProfile,
  reasoningProfile,
];

/**
 * §17 — the ONE auto-resolution table.
 *
 * Deterministic and total: every task type maps to a profile, unknown types map
 * to `default`. Nothing here may reference a model or provider id.
 */
export const AUTO_HARNESS_BY_TASK: Record<string, string> = {
  coding: "coding",
  debugging: "coding",
  tool_heavy: "tool-heavy",
  reasoning: "reasoning",
  planning: "reasoning",
};

/**
 * Auto-resolution is task-type driven ONLY.
 *
 * There is deliberately no execution-mode table: HEADLESS/TURBO/SUBAGENT/
 * TEAMWORK already carry their own turn budgets and prompts, and silently
 * swapping in a different profile for them would change existing execution
 * modes that existing configurations rely on.
 */

export function isBuiltinProfileId(id: string): boolean {
  return BUILTIN_HARNESS_PROFILES.some((profile) => profile.id === id);
}
