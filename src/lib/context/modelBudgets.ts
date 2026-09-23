import type { ContextBudget, ContextMessage, ModelContextSpec } from "./types";
import { resolveModelLimits, resolveUsableInput } from "../../core/context/limits";
import { estimateMessageChars, estimateMessageTokens, estimateTotalTokens } from "./tokenEstimator";

/**
 * Capacity comes from the canonical limit resolver: the model catalog first,
 * then a compatibility table for the long-standing model names, then a
 * conservative default that is deliberately small. Guessing high is the
 * dangerous direction — an over-estimated window fills past what the provider
 * accepts — so an unknown model is treated as narrow and reported as such.
 *
 * The auto-compaction trigger is NOT a fraction and NOT a global constant: it is
 * the same per-model `usable` capacity the canonical budget computes
 * (`resolveUsableInput`), so the compatibility layer and the canonical layer
 * cannot disagree about when a model is full.
 */

/**
 * Resolves the context specification for a model identifier.
 */
export function getModelContextSpec(modelName?: string): ModelContextSpec {
  const limits = resolveModelLimits(modelName);
  const usable = resolveUsableInput(limits);
  return {
    modelName: modelName && modelName.trim() ? modelName : "default",
    maxContextTokens: limits.contextWindow,
    maxOutputTokens: limits.maxOutputTokens,
    autoCompactThresholdTokens: usable.usable,
    usableRule: usable.rule,
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
  // Space left for input is measured against the SAME per-model usable capacity
  // the trigger uses, so "how full" and "when to compact" cannot drift apart.
  const usable = spec.autoCompactThresholdTokens;

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

  const availableTokens = Math.max(0, usable - totalTokens);
  const utilizationPercent = Math.min(100, Math.round((totalTokens / spec.maxContextTokens) * 100));
  const needsCompaction = totalTokens >= usable;

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
    usableTokens: usable,
    usableRule: spec.usableRule,
  };
}
