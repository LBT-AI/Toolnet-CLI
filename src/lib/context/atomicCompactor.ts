import type { CompactionOptions, CompactionResult, ContextMessage } from "./types";
import { estimateMessageChars, estimateMessageTokens, estimateTotalTokens } from "./tokenEstimator";
import { getModelContextSpec } from "./modelBudgets";
import { sessionMemory } from "./sessionMemory";

interface AtomicTurn {
  userMessage?: ContextMessage;
  assistantMessages: ContextMessage[];
  toolMessages: ContextMessage[];
  otherMessages: ContextMessage[];
  totalChars: number;
  totalTokens: number;
}

/**
 * Groups raw messages into atomic conversation turns to guarantee tool_call_id integrity.
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
      // Keep initial system instructions
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
        userMessage: msg,
        assistantMessages: [],
        toolMessages: [],
        otherMessages: [],
        totalChars: (msg.content || "").length,
        totalTokens: estimateMessageTokens(msg),
      };
      continue;
    }

    if (!currentTurn) {
      currentTurn = {
        assistantMessages: [],
        toolMessages: [],
        otherMessages: [],
        totalChars: 0,
        totalTokens: 0,
      };
    }

    currentTurn.totalChars += (msg.content || "").length;
    currentTurn.totalTokens += estimateMessageTokens(msg);

    if (msg.role === "assistant") {
      currentTurn.assistantMessages.push(msg);
    } else if (msg.role === "tool") {
      currentTurn.toolMessages.push(msg);
    } else {
      currentTurn.otherMessages.push(msg);
    }
  }

  if (currentTurn) {
    turns.push(currentTurn);
  }

  return { systemMessages, turns };
}

/**
 * Compacts conversation history while strictly preserving tool-call pairing and context memory.
 */
export function compactMessagesAtomically(
  messages: ContextMessage[],
  options?: CompactionOptions
): CompactionResult {
  const force = options?.force ?? false;
  const spec = getModelContextSpec(options?.model);
  const thresholdChars = options?.thresholdChars ?? (spec.autoCompactThresholdTokens * 3.8);

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

  const { systemMessages, turns } = groupIntoAtomicTurns(messages);

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
  // If keepRecentCount was provided as raw messages count (e.g. 6 raw msgs), convert to turns
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

  // Extract structured intelligence from compacted turns
  const userGoals: string[] = [];
  const toolsUsed = new Set<string>();
  const filesTouched = new Set<string>();
  const modifiedFiles = new Set<string>();
  const errorsEncountered: string[] = [];

  for (const turn of turnsToCompact) {
    if (turn.userMessage?.content) {
      const firstLine = turn.userMessage.content.split("\n")[0].slice(0, 120);
      userGoals.push(firstLine);
      sessionMemory.recordUserGoal(firstLine);
    }

    for (const am of turn.assistantMessages) {
      if (am.tool_calls) {
        for (const tc of am.tool_calls) {
          const name = tc.function?.name;
          if (name) {
            toolsUsed.add(name);
            try {
              const args = JSON.parse(tc.function.arguments || "{}");
              if (args.path) {
                filesTouched.add(args.path);
                sessionMemory.recordFileAccess(args.path, name.includes("write") || name.includes("edit") ? "write" : "read");
              }
              if (name === "write_file" || name === "edit_file" || name === "apply_patch") {
                if (args.path) modifiedFiles.add(args.path);
              }
            } catch {}
          }
        }
      }
    }

    for (const toolMsg of turn.toolMessages) {
      if (toolMsg.name) {
        toolsUsed.add(toolMsg.name);
      }
      if (toolMsg.content) {
        try {
          const parsed = JSON.parse(toolMsg.content);
          if (parsed.exitCode && parsed.exitCode !== 0 && parsed.stderr) {
            const errSummary = `${toolMsg.name || "tool"} error: ${parsed.stderr.slice(0, 150)}`;
            errorsEncountered.push(errSummary);
          }
        } catch {}
      }
    }
  }

  const memorySnapshot = sessionMemory.getSnapshot();
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

  const summaryMessage: ContextMessage = {
    role: "system",
    content: summaryLines.join("\n"),
  };

  // Reconstruct flattened messages: system -> summary -> recent turns in correct chronological order
  const reconstructedMessages: ContextMessage[] = [...systemMessages, summaryMessage];

  for (const turn of recentTurns) {
    if (turn.userMessage) reconstructedMessages.push(turn.userMessage);
    for (const am of turn.assistantMessages) reconstructedMessages.push(am);
    for (const tm of turn.toolMessages) reconstructedMessages.push(tm);
    for (const om of turn.otherMessages) reconstructedMessages.push(om);
  }

  const newChars = estimateMessageChars(reconstructedMessages);
  const newTokens = estimateTotalTokens(reconstructedMessages);
  const savedChars = Math.max(0, totalChars - newChars);
  const savedTokens = Math.max(0, totalTokens - newTokens);

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
