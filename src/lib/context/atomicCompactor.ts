import type { CompactionOptions, CompactionResult, ContextMessage } from "./types";
import { estimateMessageChars, estimateMessageTokens, estimateTotalTokens } from "./tokenEstimator";
import { getModelContextSpec } from "./modelBudgets";
import { COMPACTION_KEEP_RECENT_TOKENS } from "../../core/context/limits";
import { SessionMemoryStore } from "./sessionMemory";
import { getSessionContext, getSessionContext as ensureContext } from "./contextRegistry";
import { redactSecrets } from "../security/secretGuard";
import {
  buildSummaryPrompt,
  CHECKPOINT_SUMMARY_MARKER,
  serializeHeadTranscript,
  SUMMARY_MAX_TOKENS,
  SUMMARY_TOOL_RESULT_CHAR_CAP,
} from "./checkpointSummary";
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
 *
 * A turn starts at a USER message and at a model step that USES tools. Tool
 * results — and the assistant text that closes the step — stay with the step
 * that produced them, which is what keeps `assistant(tool_calls)` next to its
 * `tool(tool_call_id)` in every slice.
 *
 * Splitting only on user messages would collapse an entire agent run (one
 * prompt, many tool-calling steps) into a single turn, which cannot be compacted
 * at all — so the long runs that actually need compaction would never get one.
 *
 * The system message is excluded by the caller's flag; it is kept separately at
 * index 0.
 */
function startsNewTurn(message: ContextMessage): boolean {
  if (message.role === "user") return true;
  return message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

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

    if (startsNewTurn(msg) && currentTurn) {
      turns.push(currentTurn);
      currentTurn = null;
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
 * Layer 4 — : compactMessagesAtomically
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
export async function compactMessagesAtomically(
  messages: ContextMessage[],
  options?: CompactionOptions & { memory?: SessionMemoryStore; sessionId?: string; summaryRole?: "user" | "system" | "assistant" }
): Promise<CompactionResult> {
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

  // Determine the split: HEAD (summarized) vs RECENT (kept verbatim).
  //
  // Retention is a TOKEN budget by default (`keep.tokens`), not a turn count: a
  // couple of turns can be enormous and defeat the purpose, while a long run of
  // small turns is still worth keeping. An explicit `keepRecentCount` still
  // wins when a caller asked for it.
  let splitIdx: number;
  if (options?.keepRecentCount !== undefined) {
    let keepTurns = options.keepRecentCount;
    if (keepTurns > 3 && keepTurns >= turns.length) {
      keepTurns = Math.max(1, Math.floor(turns.length / 2));
    }
    splitIdx = Math.max(1, turns.length - keepTurns);
    if (splitIdx >= turns.length) {
      splitIdx = Math.max(1, turns.length - 1);
    }
  } else {
    const keepRecentTokens = options?.keepRecentTokens ?? COMPACTION_KEEP_RECENT_TOKENS;
    // The newest turn is always kept, and at least one turn is always summarized.
    splitIdx = turns.length - 1;
    let kept = turns[splitIdx].totalTokens;
    for (let i = turns.length - 2; i >= 1; i--) {
      const next = kept + turns[i].totalTokens;
      if (next > keepRecentTokens) break;
      kept = next;
      splitIdx = i;
    }

    // The newest USER instruction is not negotiable: it is the task the agent is
    // working on. A single enormous paste can blow the whole keep budget, and
    // summarizing away the request itself would leave the model with a summary
    // of work it can no longer be asked to continue.
    let lastUserTurn = -1;
    for (let i = turns.length - 1; i >= 1; i--) {
      if (turns[i].messages.some((message) => message.role === "user")) {
        lastUserTurn = i;
        break;
      }
    }
    if (lastUserTurn > 0 && lastUserTurn < splitIdx) splitIdx = lastUserTurn;
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
  const summaryHeader = options?.customSummaryPrefix || CHECKPOINT_SUMMARY_MARKER;

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

  const deterministicSummary = summaryLines.join("\n");

  // The checkpoint being replaced is an INPUT to this one, not something to
  // re-derive from raw history: it is handed over as `<prior-summary>` and the
  // summarizer is told it will be discarded afterwards.
  const priorSummary = resolvePriorSummary(options);

  const headMessages = turnsToCompact.flatMap((turn) => turn.messages);
  let modelSummary: string | null = null;
  if (options?.summarizeWithModel) {
    try {
      const prompt = buildSummaryPrompt({
        headTranscript: serializeHeadTranscript(headMessages, {
          ...(priorSummary ? { priorSummary } : {}),
          maxToolResultChars: SUMMARY_TOOL_RESULT_CHAR_CAP,
        }),
        ...(priorSummary ? { priorSummary } : {}),
      });
      const answer = await options.summarizeWithModel({ prompt, maxTokens: SUMMARY_MAX_TOKENS });
      const cleaned = typeof answer === "string" ? answer.trim() : "";
      if (cleaned.length > 0) modelSummary = cleaned;
    } catch {
      // A failed summary must not lose the compaction: the deterministic
      // summary below still produces a valid, smaller checkpoint.
      modelSummary = null;
    }
  }

  const rawSummary = modelSummary
    ? `${summaryHeader}\n${modelSummary}`
    : deterministicSummary;
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
    summarySource: modelSummary ? "model" : "deterministic",
    chainedFromPriorSummary: priorSummary !== undefined,
  };
}

/**
 * The checkpoint this compaction replaces, if any. Session state is the
 * authority; an explicit option exists for callers that own the checkpoint
 * themselves (tests, subagent isolation).
 */
function resolvePriorSummary(
  options: (CompactionOptions & { sessionId?: string }) | undefined,
): string | undefined {
  if (options?.priorSummary && options.priorSummary.trim()) return options.priorSummary.trim();
  if (!options?.sessionId) return undefined;
  try {
    const existing = getSessionContext(options.sessionId).summary;
    return existing && existing.trim() ? existing.trim() : undefined;
  } catch {
    return undefined;
  }
}
