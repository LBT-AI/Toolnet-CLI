import type {
  CompactionOptions,
  CompactionResult,
  ContextBudget,
  ContextMessage,
  PruneOptions,
  SessionMemoryData,
} from "./types";
import { calculateContextBudget, getModelContextSpec } from "./modelBudgets";
import { pruneOldToolResults } from "./toolPruner";
import { compactMessagesAtomically } from "./atomicCompactor";
import { sessionMemory } from "./sessionMemory";
import { estimateMessageChars, estimateTotalTokens } from "./tokenEstimator";

export class ContextEngine {
  private defaultModel: string;
  private compactionCount = 0;

  constructor(defaultModel = "default") {
    this.defaultModel = defaultModel;
  }

  /**
   * Prepares a message list for LLM API invocation.
   *
   * Pipeline:
   *  1. Ingest user goals into session memory.
   *  2. Auto-prune bulky older tool results (priority: errors > recent > old).
   *  3. Compress tool outputs if context is growing.
   *  4. Atomic compaction if context exceeds model threshold.
   *  5. Return optimized messages and real-time budget metrics.
   *
   * The model's context spec determines when to start pruning/compressing.
   * We begin compressing at ~70% utilization to avoid hitting the ceiling.
   */
  prepareMessagesForApi(
    messages: ContextMessage[],
    options?: {
      model?: string;
      maxTokens?: number;
      forceCompact?: boolean;
      autoPrune?: boolean;
    }
  ): {
    messages: ContextMessage[];
    budget: ContextBudget;
    compacted: boolean;
    prunedCount: number;
  } {
    const model = options?.model || this.defaultModel;
    const spec = getModelContextSpec(model);
    let workingMessages = [...messages];

    // 1. Ingest user goals into session memory
    for (const msg of workingMessages) {
      if (msg.role === "user" && msg.content) {
        sessionMemory.recordUserGoal(msg.content.split("\n")[0]);
      }
    }

    // 2. Priority-based pruning: start at 70% utilization
    let prunedCount = 0;
    if (options?.autoPrune !== false) {
      const budgetCheck = calculateContextBudget(workingMessages, model);
      const utilization = budgetCheck.utilizationPercent;

      // Aggressive pruning at 70% utilization
      if (utilization >= 70) {
        const pruneResult = pruneOldToolResults(workingMessages, {
          maxToolResultChars: utilization >= 85 ? 400 : 600,
          keepRecentToolsCount: utilization >= 85 ? 2 : 3,
        });
        workingMessages = pruneResult.messages;
        prunedCount = pruneResult.prunedCount;
      }
    }

    // 3. Check if compaction is needed based on model threshold
    const budgetBefore = calculateContextBudget(workingMessages, model);
    let compacted = false;

    if (options?.forceCompact || budgetBefore.needsCompaction) {
      const compResult = compactMessagesAtomically(workingMessages, {
        force: options?.forceCompact || budgetBefore.needsCompaction,
        model,
        thresholdChars: spec.autoCompactThresholdTokens * 3.8,
      });

      if (compResult.compacted) {
        workingMessages = compResult.messages;
        compacted = true;
        this.compactionCount++;
      }
    }

    const finalBudget = calculateContextBudget(workingMessages, model);

    return {
      messages: workingMessages,
      budget: finalBudget,
      compacted,
      prunedCount,
    };
  }

  /**
   * Manually compact messages.
   */
  compact(messages: ContextMessage[], options?: CompactionOptions): CompactionResult {
    return compactMessagesAtomically(messages, options);
  }

  /**
   * Manually prune older tool outputs.
   */
  prune(messages: ContextMessage[], options?: PruneOptions) {
    return pruneOldToolResults(messages, options);
  }

  /**
   * Calculates context budget for a given conversation.
   */
  getBudget(messages: ContextMessage[], model?: string): ContextBudget {
    return calculateContextBudget(messages, model || this.defaultModel);
  }

  /**
   * Records a user goal into persistent session memory.
   */
  recordUserGoal(goal: string) {
    sessionMemory.recordUserGoal(goal);
  }

  /**
   * Records a file access/modification into session memory.
   */
  recordFileAccess(path: string, action: "read" | "write" | "patch") {
    sessionMemory.recordFileAccess(path, action);
  }

  /**
   * Records an insight/finding into session memory.
   */
  recordInsight(insight: string) {
    sessionMemory.recordInsight(insight);
  }

  /**
   * Retrieves active session memory snapshot.
   */
  getSessionMemory(): SessionMemoryData {
    return sessionMemory.getSnapshot();
  }

  /**
   * Formats a system prompt snippet containing active session memory.
   */
  getMemoryPromptSnippet(): string {
    return sessionMemory.generateSystemPromptSnippet();
  }

  /**
   * Tool usage rules for the agent system prompt.
   * Kept short — ~120 tokens, no spam.
   */
  getToolUsageRulesSnippet(): string {
    return [
      "",
      "## Tool Usage Rules",
      "- Prefer native read_file/grep over shell sed/grep.",
      "- Reuse already observed information unless the file changed.",
      "- Prefer one sufficiently large read over repeated adjacent reads.",
      "- Batch independent reads/searches.",
      "- Consult workspace code map before broad exploration.",
    ].join("\n");
  }

  /** Returns how many compactions have occurred this session. */
  getCompactionCount(): number {
    return this.compactionCount;
  }
}

export const contextEngine = new ContextEngine();
