/**
 * Phase 81 §6 — prompt policy.
 *
 * Prompt assembly is separated from AgentHarness so instruction strategy is
 * data, not a branch buried in the loop. This module receives the already
 * gathered blocks (task summary, agent role, available tools, environment
 * context, permission context) and the profile, and returns the canonical
 * system prompt.
 *
 * Two rules make a profile safe here:
 *
 *   1. The runtime permission context is ALWAYS emitted. A profile may drop
 *      orchestration guidance; it may never drop the paragraph that tells the
 *      model what it is allowed to do.
 *   2. A caller-supplied prompt (turbo prompt, subagent role prompt, explicit
 *      `systemPrompt`) keeps its existing precedence and is used verbatim.
 *      Profiles shape the generated prompt, they do not override a caller's
 *      explicit contract.
 *
 * This module performs no I/O and holds no provider, model or tool reference.
 */

import type { HarnessProfile, PromptPolicy } from "./types";

export interface PromptBlocks {
  codingPolicy: string;
  toolUseGuidance: string;
  /** Project summary followed by the active-task block (already concatenated). */
  projectContext: string;
  memoryAndToolRules: string;
  permissionContext: string;
  languageDirective: string;
}

export interface PromptBuildInput {
  profile: HarnessProfile;
  blocks: PromptBlocks;
  /** Caller-supplied prompt. When present it wins, per existing semantics. */
  callerOverride?: string;
  /** Extra tool-use guidance contributed by the profile's ToolPolicy. */
  toolPolicyGuidance?: string;
  /** Tool names this profile exposes — mentioned so the model knows its surface. */
  availableTools?: string[];
}

/**
 * The permission paragraph is not optional. Kept as a named constant so the
 * invariant is greppable and testable.
 */
export const PERMISSION_LIMIT_NOTE =
  "Your access is strictly limited to the policy described in [RUNTIME PERMISSION CONTEXT] above.";

function separatorFor(verbosity: PromptPolicy["verbosity"]): string {
  return verbosity === "full" ? "\n\n" : "\n";
}

function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Assemble the generated prompt. Ordered guard clauses; nothing throws when a
 * block is missing — an absent block simply contributes nothing.
 */
export function assemblePromptBase(input: PromptBuildInput): string {
  const { profile, blocks } = input;
  const policy = profile.promptPolicy;
  const parts: string[] = [];

  if (policy.includeCodingPolicy && blocks.codingPolicy) parts.push(blocks.codingPolicy);
  if (policy.includeToolUseGuidance && blocks.toolUseGuidance) {
    parts.push(blocks.toolUseGuidance);
  }
  if (policy.includeProjectContext && blocks.projectContext) {
    parts.push(blocks.projectContext);
  }

  // Security boundary — always present, whatever the profile says.
  if (blocks.permissionContext) parts.push(blocks.permissionContext);
  parts.push(PERMISSION_LIMIT_NOTE);

  if (policy.includeMemoryAndToolRules && blocks.memoryAndToolRules) {
    parts.push(blocks.memoryAndToolRules);
  }
  if (blocks.languageDirective) parts.push(blocks.languageDirective);

  const guidance = input.toolPolicyGuidance?.trim();
  if (guidance) parts.push(guidance);

  const instructions = policy.instructions?.trim();
  if (instructions) parts.push(instructions);

  // The exposed tool surface, so a narrowed profile can explain itself. Only
  // emitted when a profile actually narrows the set.
  const tools = input.availableTools;
  if (tools && profile.toolPolicy.allow !== undefined) {
    parts.push(`[AVAILABLE TOOLS]\n${tools.join(", ")}`);
  }

  const joined = parts.filter(Boolean).join(separatorFor(policy.verbosity));
  return policy.verbosity === "minimal" ? collapseBlankLines(joined) : joined;
}

/**
 * Canonical prompt for a run: caller override wins verbatim, else the profile's
 * assembly. Kept as a plain truthiness check so a caller-supplied prompt is
 * used byte-for-byte, exactly as it was before Phase 81.
 */
export function composeSystemPrompt(input: PromptBuildInput): string {
  if (input.callerOverride) return input.callerOverride;
  return assemblePromptBase(input);
}

/** True when the profile changes prompt assembly at all. */
export function isPassthroughPromptPolicy(policy: PromptPolicy): boolean {
  return (
    policy.verbosity === "full" &&
    policy.includeCodingPolicy &&
    policy.includeToolUseGuidance &&
    policy.includeProjectContext &&
    policy.includeMemoryAndToolRules &&
    !policy.instructions?.trim()
  );
}
