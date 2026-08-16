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

  constructor(defaultModel = "default") {
    this.defaultModel = defaultModel;
  }

  /**
   * Prepares a message list for LLM API invocation:
   * 1. Injects active SessionMemory into the system prompt if missing.
   * 2. Prunes bulky older tool results.
   * 3. Performs atomic compaction if context size exceeds model threshold.
   * 4. Returns optimized messages and real-time budget metrics.
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

    // 2. Auto-prune bulky older tool outputs
    let prunedCount = 0;
    if (options?.autoPrune !== false) {
      const pruneResult = pruneOldToolResults(workingMessages);
      workingMessages = pruneResult.messages;
      prunedCount = pruneResult.prunedCount;
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
}

export const contextEngine = new ContextEngine();
