import type { ContextBudget, ContextMessage, ModelContextSpec } from "./types";
import { estimateMessageChars, estimateMessageTokens, estimateTotalTokens } from "./tokenEstimator";

const DEFAULT_SPECS: Record<string, ModelContextSpec> = {
  "openai/gpt-4o": {
    modelName: "openai/gpt-4o",
    maxContextTokens: 128000,
    maxOutputTokens: 4096,
    autoCompactThresholdTokens: 96000,
    charsPerTokenEstimate: 3.8,
  },
  "openai/gpt-4o-mini": {
    modelName: "openai/gpt-4o-mini",
    maxContextTokens: 128000,
    maxOutputTokens: 4096,
    autoCompactThresholdTokens: 96000,
    charsPerTokenEstimate: 3.8,
  },
  "anthropic/claude-3-5-sonnet": {
    modelName: "anthropic/claude-3-5-sonnet",
    maxContextTokens: 200000,
    maxOutputTokens: 8192,
    autoCompactThresholdTokens: 150000,
    charsPerTokenEstimate: 3.8,
  },
  "anthropic/claude-3-haiku": {
    modelName: "anthropic/claude-3-haiku",
    maxContextTokens: 200000,
    maxOutputTokens: 4096,
    autoCompactThresholdTokens: 150000,
    charsPerTokenEstimate: 3.8,
  },
  "google/gemini-2.0-flash": {
    modelName: "google/gemini-2.0-flash",
    maxContextTokens: 1048576,
    maxOutputTokens: 8192,
    autoCompactThresholdTokens: 500000,
    charsPerTokenEstimate: 3.8,
  },
  "google/gemini-1.5-pro": {
    modelName: "google/gemini-1.5-pro",
    maxContextTokens: 2097152,
    maxOutputTokens: 8192,
    autoCompactThresholdTokens: 800000,
    charsPerTokenEstimate: 3.8,
  },
  "deepseek/deepseek-chat": {
    modelName: "deepseek/deepseek-chat",
    maxContextTokens: 64000,
    maxOutputTokens: 4096,
    autoCompactThresholdTokens: 48000,
    charsPerTokenEstimate: 3.8,
  },
  "deepseek/deepseek-coder": {
    modelName: "deepseek/deepseek-coder",
    maxContextTokens: 64000,
    maxOutputTokens: 4096,
    autoCompactThresholdTokens: 48000,
    charsPerTokenEstimate: 3.8,
  },
  "default": {
    modelName: "default",
    maxContextTokens: 32000,
    maxOutputTokens: 4096,
    autoCompactThresholdTokens: 8000,
    charsPerTokenEstimate: 3.8,
  },
};

/**
 * Resolves context specification for a given model identifier.
 */
export function getModelContextSpec(modelName?: string): ModelContextSpec {
  if (!modelName) return DEFAULT_SPECS["default"];
  const lower = modelName.toLowerCase();

  for (const [key, spec] of Object.entries(DEFAULT_SPECS)) {
    if (lower === key || lower.includes(key.replace(/^[^/]+\//, ""))) {
      return spec;
    }
  }

  if (lower.includes("sonnet") || lower.includes("claude")) {
    return DEFAULT_SPECS["anthropic/claude-3-5-sonnet"];
  }
  if (lower.includes("gpt-4") || lower.includes("o1") || lower.includes("o3")) {
    return DEFAULT_SPECS["openai/gpt-4o"];
  }
  if (lower.includes("gemini")) {
    return DEFAULT_SPECS["google/gemini-2.0-flash"];
  }
  if (lower.includes("deepseek")) {
    return DEFAULT_SPECS["deepseek/deepseek-chat"];
  }

  return {
    modelName,
    maxContextTokens: 32000,
    maxOutputTokens: 4096,
    autoCompactThresholdTokens: 24000,
    charsPerTokenEstimate: 3.8,
  };
}

/**
 * Calculates current token consumption and budget breakdown for a message list.
 */
export function calculateContextBudget(messages: ContextMessage[], modelName?: string): ContextBudget {
  const spec = getModelContextSpec(modelName);
  const totalTokens = estimateTotalTokens(messages);
  const totalChars = estimateMessageChars(messages);

  let systemTokens = 0;
  let memoryTokens = 0;
  let conversationTokens = 0;
  let activeToolTokens = 0;

  // Split messages into budget categories
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
