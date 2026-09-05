import type { CompactionOptions, CompactionResult, ContextMessage } from "./types";
import { estimateMessageChars, estimateMessageTokens, estimateTotalTokens } from "./tokenEstimator";
import { getModelContextSpec } from "./modelBudgets";
import { SessionMemoryStore } from "./sessionMemory";
import { getSessionContext, getSessionContext as ensureContext } from "./contextRegistry";
import { redactSecrets } from "../security/secretGuard";
import { validateToolCallPairs } from "./toolCallValidator";
import { assertPrimarySystemMessageInvariant, normalizePrimarySystemMessage } from "./messageInvariants";

interface AtomicTurn {
  /** Messages in original order: [user, assistant, tool, assistant, ...] */
  messages: ContextMessage[];
  totalChars: number;
  totalTokens: number;
}

/**
 * Groups raw messages into atomic conversation turns to guarantee tool_call_id integrity.
 * Each turn preserves the ORIGINAL message order so the relative position of
 * `assistant(tool_calls)` and the matching `tool(tool_call_id)` is never broken.
 */
function groupIntoAtomicTurns(messages: ContextMessage[]): {
  systemMessages: ContextMessage[];
  turns: AtomicTurn[];
} {
  const systemMessages: ContextMessage[] = [];
  const turns: AtomicTurn[] = [];

  let currentTurn: AtomicTurn | null = null;

  for (const msg of messages) {
    if (msg.role === "system") {
      // Keep initial system instructions (one allowed at the head).
      if (turns.length === 0 && !currentTurn) {
        systemMessages.push(msg);
        continue;
      }
    }

    if (msg.role === "user") {
      if (currentTurn) {
        turns.push(currentTurn);
      }
      currentTurn = {
        messages: [msg],
        totalChars: (msg.content || "").length,
        totalTokens: estimateMessageTokens(msg),
      };
      continue;
    }

    if (!currentTurn) {
      currentTurn = { messages: [], totalChars: 0, totalTokens: 0 };
    }

    currentTurn.messages.push(msg);
    currentTurn.totalChars += (msg.content || "").length;
    currentTurn.totalTokens += estimateMessageTokens(msg);
  }

  if (currentTurn) {
    turns.push(currentTurn);
  }

  return { systemMessages, turns };
}

/**
 * Layer 4 — Phase 4: compactMessagesAtomically
 *
 * Atomicity contract:
 *   - Every assistant tool_call in the input MUST be followed by its tool
 *     result in the OUTPUT. We preserve complete turns.
 *   - We never produce an assistant tool_calls entry without the matching
 *     tool result message.
 *   - If the input is malformed, we fall back to validateToolCallPairs to
 *     identify the broken boundary and stop short of producing an
 *     invariant-violating result.
 *
 * Provider-compatibility contract:
 *   - The system instruction (if any) is preserved at index 0. Only one
 *     primary system message is kept.
 *   - The compaction summary is emitted with role "user" by default
 *     (configurable: `summaryRole: "user" | "system" | "assistant"`).
 *     This avoids putting a secondary system message mid-conversation,
 *     which some providers reject (Anthropic, Gemini strict mode, etc.).
 *   - The summary is redacted of secrets before persistence.
 */
export function compactMessagesAtomically(
  messages: ContextMessage[],
  options?: CompactionOptions & { memory?: SessionMemoryStore; sessionId?: string; summaryRole?: "user" | "system" | "assistant" }
): CompactionResult {
  const force = options?.force ?? false;
  const spec = getModelContextSpec(options?.model);
  const thresholdChars = options?.thresholdChars ?? (spec.autoCompactThresholdTokens * 3.8);

  // Atomic-turn validator: refuse to compact if any assistant tool_call
  // has no matching result OR any orphan tool result exists. This is the
  // fail-safe repair boundary from the validator.
  const validation = validateToolCallPairs(messages);
  if (!validation.valid && !force) {
    return {
      compacted: false,
      messages: [...messages],
      originalCount: messages.length,
      newCount: messages.length,
      savedChars: 0,
      reason: `Refused to compact: tool-call pair integrity broken (orphanTools=${validation.orphanTools.length}, missingResults=${validation.missingResults.length}).`,
    };
  }

  const totalChars = estimateMessageChars(messages);
  const totalTokens = estimateTotalTokens(messages);

  if (!force && totalChars < thresholdChars) {
    return {
      compacted: false,
      messages: [...messages],
      originalCount: messages.length,
      newCount: messages.length,
      savedChars: 0,
      originalTokens: totalTokens,
      newTokens: totalTokens,
      savedTokens: 0,
      reason: `Context (${totalChars} chars / ~${totalTokens} tokens) is within budget threshold (${Math.round(thresholdChars)} chars).`,
    };
  }

  const normalizedMessages = normalizePrimarySystemMessage(messages);
  assertPrimarySystemMessageInvariant(normalizedMessages);
  const { systemMessages, turns } = groupIntoAtomicTurns(normalizedMessages);

  if (turns.length < 2) {
    return {
      compacted: false,
      messages: [...messages],
      originalCount: messages.length,
      newCount: messages.length,
      savedChars: 0,
      originalTokens: totalTokens,
      newTokens: totalTokens,
      savedTokens: 0,
      reason: `Not enough turns to compact (${turns.length} turns).`,
    };
  }

  // Determine split index: keep recent turns while compacting older history
  let keepTurns = options?.keepRecentCount ?? 2;
  if (keepTurns > 3 && keepTurns >= turns.length) {
    keepTurns = Math.max(1, Math.floor(turns.length / 2));
  }

  let splitIdx = Math.max(1, turns.length - keepTurns);
  if (splitIdx >= turns.length) {
    splitIdx = Math.max(1, turns.length - 1);
  }

  const turnsToCompact = turns.slice(0, splitIdx);
  const recentTurns = turns.slice(splitIdx);

  if (turnsToCompact.length === 0) {
    return {
      compacted: false,
      messages: [...messages],
      originalCount: messages.length,
      newCount: messages.length,
      savedChars: 0,
      originalTokens: totalTokens,
      newTokens: totalTokens,
      savedTokens: 0,
      reason: `No turns selected for compaction.`,
    };
  }

  // Resolve the memory store to use (bound to sessionId if provided).
  const memory: SessionMemoryStore =
    options?.memory ||
    (options?.sessionId ? ensureContext(options.sessionId).memory : new SessionMemoryStore("ephemeral-compaction"));

  // Extract structured intelligence from compacted turns
  const userGoals: string[] = [];
  const toolsUsed = new Set<string>();
  const filesTouched = new Set<string>();
  const modifiedFiles = new Set<string>();
  const errorsEncountered: string[] = [];

  for (const turn of turnsToCompact) {
    for (const m of turn.messages) {
      if (m.role === "user" && m.content) {
        const firstLine = m.content.split("\n")[0].slice(0, 120);
        userGoals.push(firstLine);
        memory.recordUserGoal(firstLine);
      } else if (m.role === "assistant" && m.tool_calls) {
        for (const tc of m.tool_calls) {
          const name = tc.function?.name;
          if (name) {
            toolsUsed.add(name);
            try {
              const args = JSON.parse(tc.function.arguments || "{}");
              if (args.path) {
                filesTouched.add(args.path);
                memory.recordFileAccess(args.path, name.includes("write") || name.includes("edit") ? "write" : "read");
              }
              if (name === "write_file" || name === "edit_file" || name === "apply_patch") {
                if (args.path) modifiedFiles.add(args.path);
              }
            } catch {}
          }
        }
      } else if (m.role === "tool") {
        if (m.name) {
          toolsUsed.add(m.name);
        }
        if (m.content) {
          try {
            const parsed = JSON.parse(m.content);
            if (parsed.exitCode && parsed.exitCode !== 0 && parsed.stderr) {
              const errSummary = `${m.name || "tool"} error: ${parsed.stderr.slice(0, 150)}`;
              errorsEncountered.push(errSummary);
            }
          } catch {}
        }
      }
    }
  }

  const memorySnapshot = memory.getSnapshot();
  const summaryHeader = options?.customSummaryPrefix || "[Context Compaction Summary]";

  const summaryLines = [
    summaryHeader,
    `Prior history (${turnsToCompact.length} turns) has been compacted to preserve token budget.`,
    ``,
    `Key User Goals:`,
    userGoals.length > 0 ? userGoals.map((g) => `• ${g}`).slice(-6).join("\n") : "• (general task execution)",
    ``,
    `Tools Executed: ${Array.from(toolsUsed).join(", ") || "none"}`,
    `Files Read/Referenced: ${Array.from(filesTouched).slice(-10).join(", ") || "none"}`,
    `Files Modified: ${Array.from(modifiedFiles).join(", ") || "none"}`,
  ];

  if (errorsEncountered.length > 0) {
    summaryLines.push(``, `Prior Issues Handled:`, ...errorsEncountered.slice(-3).map((e) => `• ${e}`));
  }

  summaryLines.push(
    ``,
    `Workspace Memory: ${memorySnapshot.workspaceRoot} (${memorySnapshot.framework || "generic"})`,
    `Note: All recent turns below are active. Continue directly with current objectives.`
  );

  const rawSummary = summaryLines.join("\n");
  // Secret redaction BEFORE persisting/summary: keys, bearer tokens, blocks.
  const redactedSummary = redactSecrets(rawSummary);

  // Provider-compatible summary role: default to "user" so the system
  // message stays at index 0 (Anthropic / Gemini-friendly).
  const summaryRole = options?.summaryRole ?? "user";
  const summaryMessage: ContextMessage = {
    role: summaryRole,
    content: redactedSummary,
  };

  // Preserve at most ONE primary system message at index 0.
  const primarySystem = systemMessages.slice(0, 1);
  const reconstructedMessages: ContextMessage[] = [...primarySystem, summaryMessage];

  for (const turn of recentTurns) {
    for (const m of turn.messages) {
      reconstructedMessages.push(m);
    }
  }

  // Final invariant check on the output.
  const outValidation = validateToolCallPairs(reconstructedMessages);
  try {
    assertPrimarySystemMessageInvariant(reconstructedMessages);
  } catch {
    return {
      compacted: false,
      messages: [...messages],
      originalCount: messages.length,
      newCount: messages.length,
      savedChars: 0,
      originalTokens: totalTokens,
      newTokens: totalTokens,
      savedTokens: 0,
      reason: `Refused to compact: rebuilt history would contain an invalid system-message placement.`,
    };
  }
  if (!outValidation.valid) {
    return {
      compacted: false,
      messages: [...messages],
      originalCount: messages.length,
      newCount: messages.length,
      savedChars: 0,
      originalTokens: totalTokens,
      newTokens: totalTokens,
      savedTokens: 0,
      reason: `Refused to compact: rebuilt history would violate tool-call pair invariant.`,
    };
  }

  const newChars = estimateMessageChars(reconstructedMessages);
  const newTokens = estimateTotalTokens(reconstructedMessages);
  const savedChars = Math.max(0, totalChars - newChars);
  const savedTokens = Math.max(0, totalTokens - newTokens);

  // Persist summary + recent files into the session context.
  if (options?.sessionId) {
    const ctx = getSessionContext(options.sessionId);
    ctx.summary = redactedSummary;
    if (errorsEncountered.length > 0) {
      for (const e of errorsEncountered.slice(-3)) {
        if (!ctx.errors.includes(e)) ctx.errors.push(e);
        if (ctx.errors.length > 20) ctx.errors.shift();
      }
    }
    for (const g of userGoals.slice(-6)) {
      if (!ctx.goals.includes(g)) ctx.goals.push(g);
      if (ctx.goals.length > 20) ctx.goals.shift();
    }
    for (const f of Array.from(filesTouched).slice(-10)) {
      if (!ctx.fileAccess.read.includes(f)) ctx.fileAccess.read.push(f);
      if (ctx.fileAccess.read.length > 50) ctx.fileAccess.read.shift();
    }
    for (const f of Array.from(modifiedFiles)) {
      if (!ctx.fileAccess.write.includes(f)) ctx.fileAccess.write.push(f);
      if (ctx.fileAccess.write.length > 50) ctx.fileAccess.write.shift();
    }
    ctx.generation++;
  }

  return {
    compacted: true,
    messages: reconstructedMessages,
    originalCount: messages.length,
    newCount: reconstructedMessages.length,
    savedChars,
    originalTokens: totalTokens,
    newTokens,
    savedTokens,
  };
}
