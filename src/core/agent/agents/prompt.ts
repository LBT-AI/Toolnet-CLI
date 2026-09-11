/**
 * Phase 75.2 — Child Agent System Prompt
 *
 * The child's prompt is derived from its AgentDefinition plus the constraints
 * the runtime actually enforces. It deliberately states the same rules the
 * Completion Gate enforces, so a compliant model and a non-compliant model
 * both end up honest:
 *
 *   - never claim a side effect that a tool did not verify
 *   - report facts gathered from the workspace, not plausible-sounding ones
 *   - hand the parent a compact result, not a raw transcript
 */

import type { AgentDefinition } from "./types";

export interface ComposeAgentPromptInput {
  agent: AgentDefinition;
  /** Tools actually granted after permission derivation (canonical names). */
  grantedTools: string[];
  /** Workspace root shown to the child for path resolution. */
  workspaceRoot?: string;
  /** Whether this child may itself spawn subagents. */
  canSpawnSubagents: boolean;
  /** Extra caller-supplied guidance appended verbatim. */
  extra?: string;
}

/**
 * Build the role prompt. Kept pure so it can be unit-tested and diffed; the
 * harness separately injects the live runtime permission context, so this
 * function never restates permission claims that could drift from policy.
 */
export function composeAgentPrompt(input: ComposeAgentPromptInput): string {
  const { agent, grantedTools, canSpawnSubagents } = input;

  const lines: string[] = [
    `You are ToolNet subagent "${agent.name}" (id: ${agent.id}).`,
    agent.description,
  ];

  if (agent.systemPrompt?.trim()) {
    lines.push("", agent.systemPrompt.trim());
  }

  if (input.workspaceRoot) {
    lines.push("", `Workspace root: ${input.workspaceRoot}`);
  }

  lines.push(
    "",
    "Your tool scope for this task:",
    grantedTools.length > 0 ? grantedTools.map((t) => `- ${t}`).join("\n") : "- (no tools granted)",
    "",
    "Operational rules:",
    "- Work on the real workspace with the tools you have been granted.",
    "- Read before you edit: inspect the surrounding code and conventions first.",
    "- Never claim that a file was created, modified or deleted, that a command ran, or that tests passed unless the corresponding tool executed successfully and returned a verified result.",
    "- If you only produced code in chat, say that you produced code — do not claim it was written to disk.",
    "- Report facts you actually observed. Never invent file paths, symbols, line numbers or test output.",
    "- Finish with a compact result for the parent: what you found or changed, the exact files involved, and any unresolved problem.",
  );

  lines.push(
    canSpawnSubagents
      ? "- You may delegate to another subagent when a task genuinely needs a different speciality."
      : "- You may not spawn further subagents; complete the task yourself."
  );

  if (input.extra?.trim()) {
    lines.push("", input.extra.trim());
  }

  return lines.join("\n");
}
