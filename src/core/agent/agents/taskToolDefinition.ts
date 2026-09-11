/**
 * Phase 75.7 — `task` tool definition
 *
 * Registry entry for subagent delegation. Kept in its own module so the tool's
 * (long) model-facing description does not bloat the registry file, and so the
 * registry can import it eagerly while the manager stays lazily loaded.
 */

import type { ToolDefinition } from "../../../lib/harness/toolRegistry";
import type { TaskToolInput } from "./types";

const DESCRIPTION = [
  "Delegate a self-contained task to a specialised subagent.",
  "",
  "The subagent runs with its own session and its own tool scope, which can only",
  "ever be narrower than yours: it can never gain a permission you do not hold.",
  "Only its final result comes back to you — not its full transcript.",
  "",
  "Use it to (a) research a codebase without polluting your context, (b) hand an",
  "implementation task to a coding agent, or (c) get an independent verification.",
  "Prefer doing small, single-step work yourself.",
  "",
  "Available agent types:",
  "  explore  — read-only research: search symbols, read files, report findings",
  "  coder    — implement changes: read, edit, run commands, verify",
  "  tester   — verification: run tests/typecheck and report exact evidence",
  "  reviewer — read-only review of changes and risks",
  "  general  — inherits your own tool scope and permissions",
  "",
  "Omit `subagent_type` to use `general`. Pass an existing `task_id` to continue",
  "a previous subagent with its history intact.",
].join("\n");

/**
 * The registry entry. The `execute` hook defers to the shared SubagentManager,
 * so depth limits, scoped tools and permission derivation cannot be bypassed by
 * calling the tool directly.
 */
export const taskToolDefinition: ToolDefinition<TaskToolInput, string> = {
  name: "task",
  description: DESCRIPTION,
  parameters: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "Short label for this delegation (3-6 words).",
      },
      prompt: {
        type: "string",
        description: "Complete, self-contained instruction for the subagent.",
      },
      subagent_type: {
        type: "string",
        enum: ["explore", "coder", "tester", "reviewer", "general"],
        description: "Which specialised agent to run. Defaults to general.",
      },
      task_id: {
        type: "string",
        description: "Resume a previous subagent session by its task id.",
      },
    },
    required: ["prompt"],
  },
  risk: "execute",
  category: "Agent",
  async execute(input, ctx) {
    const { runTaskTool } = await import("./taskTool");
    return runTaskTool(input ?? { prompt: "" }, ctx);
  },
};
