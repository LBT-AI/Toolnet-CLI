import type { ContextBudget, ContextMessage, ModelContextSpec } from "./types";
import { resolveModelLimits } from "../../core/context/limits";
import { estimateMessageChars, estimateMessageTokens, estimateTotalTokens } from "./tokenEstimator";

/**
 * Capacity comes from the canonical limit resolver: the model catalog first,
 * then a compatibility table for the long-standing model names, then a
 * conservative default that is deliberately small. Guessing high is the
 * dangerous direction — an over-estimated window fills past what the provider
 * accepts — so an unknown model is treated as narrow and reported as such.
 *
 * The compaction trigger is expressed as a fraction of the window instead of a
 * per-model number, so a model this layer has never heard of still compacts
 * before it overflows. Capacity is reserved for the answer separately, so a
 * trigger at three quarters of the window cannot consume the whole of it.
 */
const COMPACTION_THRESHOLD_RATIO = 0.75;

function thresholdFor(contextWindow: number, established?: number): number {
  // An identity that already had a trigger keeps it; only a model this layer
  // has never budgeted gets the derived one.
  if (established !== undefined && established > 0) return Math.max(1, established);
  return Math.max(1, Math.floor(contextWindow * COMPACTION_THRESHOLD_RATIO));
}

/**
 * Resolves the context specification for a model identifier.
 */
export function getModelContextSpec(modelName?: string): ModelContextSpec {
  const limits = resolveModelLimits(modelName);
  return {
    modelName: modelName && modelName.trim() ? modelName : "default",
    maxContextTokens: limits.contextWindow,
    maxOutputTokens: limits.maxOutputTokens,
    autoCompactThresholdTokens: thresholdFor(limits.contextWindow, limits.compactionThreshold),
    charsPerTokenEstimate: 3.8,
  };
}

/**
 * Current consumption and budget breakdown for a message list.
 *
 * The category split is a reporting concern — it says where the estimate went,
 * not what to drop. Deciding what may be dropped belongs to the context planner,
 * which protects permission decisions and verification evidence by category
 * rather than by position.
 */
export function calculateContextBudget(messages: ContextMessage[], modelName?: string): ContextBudget {
  const spec = getModelContextSpec(modelName);
  const totalTokens = estimateTotalTokens(messages);
  const totalChars = estimateMessageChars(messages);

  let systemTokens = 0;
  let memoryTokens = 0;
  let conversationTokens = 0;
  let activeToolTokens = 0;

  const recentIdx = Math.max(0, messages.length - 4);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const t = estimateMessageTokens(msg);

    if (msg.role === "system") {
      if (msg.content.includes("[Session Memory]") || msg.content.includes("Context Compaction Summary")) {
        memoryTokens += t;
      } else {
        systemTokens += t;
      }
    } else if (msg.role === "tool" && i >= recentIdx) {
      activeToolTokens += t;
    } else {
      conversationTokens += t;
    }
  }

  const availableTokens = Math.max(0, spec.maxContextTokens - totalTokens - spec.maxOutputTokens);
  const utilizationPercent = Math.min(100, Math.round((totalTokens / spec.maxContextTokens) * 100));
  const needsCompaction = totalTokens >= spec.autoCompactThresholdTokens;

  return {
    modelName: spec.modelName,
    maxContextTokens: spec.maxContextTokens,
    currentEstimatedTokens: totalTokens,
    currentEstimatedChars: totalChars,
    utilizationPercent,
    systemTokens,
    memoryTokens,
    conversationTokens,
    activeToolTokens,
    availableTokens,
    needsCompaction,
  };
}
