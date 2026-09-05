/**
 * Layer 4 — Phase 4: Tool-call pair validator.
 *
 * Walks a message list and reports:
 *   - `valid`:              true if every assistant tool_call is matched
 *                           by a tool result and there are no orphan
 *                           tool results.
 *   - `orphanTools`:        tool results whose tool_call_id does not
 *                           appear in any prior assistant.tool_calls.
 *   - `missingResults`:     assistant tool_call ids that have no tool
 *                           result following them.
 *   - `nonAtomicBoundaries`: indices where a tool_call or tool result
 *                            violates the "no orphan / no missing" rule.
 *
 * The validator is pure (no side effects, no caching). It is intended to
 * be invoked before provider submission in dev/test and as a fail-safe
 * repair source in production when legacy data is encountered.
 */

import type { ContextMessage } from "./types";

export interface ToolCallValidation {
  valid: boolean;
  orphanTools: Array<{ index: number; toolCallId?: string; name?: string }>;
  missingResults: Array<{ index: number; toolCallIds: string[] }>;
  /** Index of the first boundary where the invariant was broken. */
  firstBadIndex: number;
}

export function validateToolCallPairs(messages: ContextMessage[]): ToolCallValidation {
  const orphanTools: ToolCallValidation["orphanTools"] = [];
  const missingResults: ToolCallValidation["missingResults"] = [];

  let firstBadIndex = -1;

  // Forward pass: collect every tool_call id declared by assistants.
  const declared = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      if (tc?.id) declared.add(tc.id);
    }
  }

  // Reverse pass: a tool result must have a tool_call_id that was
  // declared earlier in the conversation.
  const fulfilled = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool" && m.tool_call_id) {
      if (!declared.has(m.tool_call_id)) {
        orphanTools.push({ index: i, toolCallId: m.tool_call_id, name: m.name });
        if (firstBadIndex < 0) firstBadIndex = i;
      } else {
        fulfilled.add(m.tool_call_id);
      }
    }
  }

  // Forward pass: every assistant.tool_call must be followed by its
  // result in the conversation. Look ahead only until the next non-tool
  // message (the result MUST come immediately after the call).
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;
    const expected = new Set<string>();
    for (const tc of m.tool_calls) if (tc?.id) expected.add(tc.id);

    // Scan forward until the next user/assistant/system boundary.
    for (let j = i + 1; j < messages.length; j++) {
      const n = messages[j];
      if (n.role === "tool" && n.tool_call_id && expected.has(n.tool_call_id)) {
        expected.delete(n.tool_call_id);
      } else if (n.role !== "tool") {
        break;
      }
    }

    if (expected.size > 0) {
      missingResults.push({ index: i, toolCallIds: Array.from(expected) });
      if (firstBadIndex < 0) firstBadIndex = i;
    }
  }

  // fulfilled/declared bookkeeping kept for future diagnostics.
  void fulfilled;

  return {
    valid: orphanTools.length === 0 && missingResults.length === 0,
    orphanTools,
    missingResults,
    firstBadIndex,
  };
}

/**
 * Fail-safe repair: drops orphan tool results and appends a synthetic
 * tool result for any assistant tool_call that has no matching result.
 * The synthetic result uses a deterministic tool_call_id marker so the
 * provider does not reject the message.
 */
export function repairToolCallPairs(
  messages: ContextMessage[],
  syntheticToolName = "tool"
): ContextMessage[] {
  const validation = validateToolCallPairs(messages);
  if (validation.valid) return messages;

  const orphanIds = new Set(validation.orphanTools.map((o) => o.toolCallId).filter((x): x is string => !!x));
  const result: ContextMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool" && m.tool_call_id && orphanIds.has(m.tool_call_id)) continue;
    result.push(m);
  }

  // Append synthetic results for missing tool calls.
  for (const miss of validation.missingResults) {
    const assistant = messages[miss.index];
    if (!assistant || assistant.role !== "assistant" || !Array.isArray(assistant.tool_calls)) continue;
    for (const id of miss.toolCallIds) {
      result.push({
        role: "tool",
        tool_call_id: id,
        name: syntheticToolName,
        content: "[tool_call_repaired: original result unavailable]",
      });
    }
  }

  return result;
}
