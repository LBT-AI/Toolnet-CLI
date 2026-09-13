/**
 * Context planning.
 *
 * Produces an explanation of what would be sent, what would be dropped and why,
 * without calling a model. The plan is the contract that keeps pruning honest:
 *
 *   - a permission DECISION is protected, because a model that loses a DENY
 *     re-issues the same call and the run then looks like a stuck model instead
 *     of a context bug;
 *   - the current task, an unresolved error and the evidence behind "the file
 *     changed" are protected for the same reason — dropping them lets the model
 *     confidently claim progress that did not happen;
 *   - a tool result that is byte-identical to a NEWER one is redundant and is
 *     marked prunable rather than counted twice.
 *
 * Planning never deletes durable history; it only describes the model-visible
 * window for this turn.
 */

import { PERMISSION_DECISIONS_MARKER } from "../harness/context";
import { tokenEstimator, type EstimatableMessage } from "./estimator";
import type { ContextBudget, ContextCategory, ContextItem, ContextPlan } from "./types";

/** Tool results newer than this count stay in full fidelity. */
export const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 3;

export interface PlannerInput {
  messages: EstimatableMessage[];
  budget: ContextBudget;
  keepRecentToolResults?: number;
}

interface Analyzed {
  index: number;
  message: EstimatableMessage;
  category: ContextCategory;
  tokens: number;
  protected: boolean;
  ref?: string;
  reason: string;
}

function contentOf(message: EstimatableMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

/** A tool result that reports a permission refusal, in any of the shapes tools use. */
export function carriesPermissionDecision(message: EstimatableMessage): boolean {
  const content = contentOf(message);
  if (content.includes(PERMISSION_DECISIONS_MARKER)) return true;
  if (!content) return false;
  if (/"decision"\s*:\s*"DENY"/i.test(content)) return true;
  if (/permission denied|not permitted|forbidden|denied by policy|approval/im.test(content)) return true;
  return false;
}

function carriesFailure(message: EstimatableMessage): boolean {
  if (message.role !== "tool") return false;
  const content = contentOf(message);
  if (!content) return false;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      if (parsed.ok === false || parsed.success === false) return true;
      if (typeof parsed.exitCode === "number" && parsed.exitCode !== 0) return true;
    }
  } catch {
    if (/^error\b|\bfailed\b/i.test(content.trim())) return true;
  }
  return false;
}

/** Stable identity for de-duplication: identical content is the same payload. */
function fingerprint(message: EstimatableMessage): string | null {
  const content = contentOf(message);
  if (!content || content.length < 40) return null;
  // Cheap rolling hash — this only decides redundancy, never correctness.
  let hash = 2166136261;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${message.role}:${(hash >>> 0).toString(36)}:${content.length}`;
}

function fileRef(message: EstimatableMessage): string | undefined {
  if (message.role !== "tool" || !message.name) return undefined;
  const content = contentOf(message);
  try {
    const parsed = JSON.parse(content);
    const target = parsed?.path ?? parsed?.file ?? parsed?.filePath;
    if (typeof target === "string" && target) return target;
  } catch {
    /* fall through */
  }
  return undefined;
}

export function planContext(input: PlannerInput): ContextPlan {
  const { messages, budget } = input;
  const keepRecent = Math.max(0, input.keepRecentToolResults ?? DEFAULT_KEEP_RECENT_TOOL_RESULTS);

  // Index tool results once so "recent" is decided from the tail, cheaply.
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") toolIndices.push(i);
  }
  const recentToolIndices = new Set(toolIndices.slice(Math.max(0, toolIndices.length - keepRecent)));

  // Newest-failure and newest-permission-decision are kept, not the oldest.
  let lastUserIndex = -1;
  let lastFailureIndex = -1;
  let lastPermissionIndex = -1;
  const newestFingerprintIndex = new Map<string, number>();

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "user" && !contentOf(message).includes(PERMISSION_DECISIONS_MARKER)) lastUserIndex = i;
    if (carriesFailure(message)) lastFailureIndex = i;
    if (carriesPermissionDecision(message)) lastPermissionIndex = i;
    const print = fingerprint(message);
    if (print) newestFingerprintIndex.set(print, i);
  }

  const analyzed: Analyzed[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const tokens = tokenEstimator.estimateMessage(message, budget.model).tokens;
    const ref = fileRef(message);
    const print = fingerprint(message);

    if (message.role === "system") {
      analyzed.push({ index: i, message, category: "system_instructions", tokens, protected: true, reason: "system instructions always accompany the request" });
      continue;
    }

    if (carriesPermissionDecision(message)) {
      const isNewest = i === lastPermissionIndex;
      analyzed.push({
        index: i,
        message,
        category: "permission_decisions",
        tokens,
        protected: true,
        reason: isNewest
          ? "permission decision: a dropped DENY would be retried as if it never happened"
          : "earlier permission decision retained for continuity",
      });
      continue;
    }

    if (i === lastUserIndex) {
      analyzed.push({ index: i, message, category: "current_task", tokens, protected: true, reason: "the task currently being worked on" });
      continue;
    }

    if (i === lastFailureIndex) {
      const isUnresolved = lastFailureIndex > lastUserIndex;
      analyzed.push({
        index: i,
        message,
        category: "active_error",
        tokens,
        protected: isUnresolved,
        reason: isUnresolved
          ? "unresolved failure: dropping it hides that the fix is unverified"
          : "most recent failure, retained as verification evidence",
      });
      continue;
    }

    if (message.role === "tool") {
      if (recentToolIndices.has(i)) {
        analyzed.push({ index: i, message, category: "recent_tool_results", tokens, protected: true, reason: "recent tool result kept in full" });
        continue;
      }
      const newestWithSameContent = print ? newestFingerprintIndex.get(print) : undefined;
      if (newestWithSameContent !== undefined && newestWithSameContent !== i) {
        analyzed.push({
          index: i,
          message,
          category: "older_tool_results",
          tokens,
          protected: false,
          ...(ref ? { ref } : {}),
          reason: "identical to a newer tool result — redundant payload",
        });
        continue;
      }
      analyzed.push({
        index: i,
        message,
        category: "older_tool_results",
        tokens,
        protected: false,
        ...(ref ? { ref } : {}),
        reason: "older tool result, prunable when the budget is tight",
      });
      continue;
    }

    analyzed.push({
      index: i,
      message,
      category: "conversation",
      tokens,
      protected: false,
      reason: "older conversation turn",
    });
  }

  const included: ContextItem[] = [];
  const excluded: ContextItem[] = [];
  let protectedTokens = 0;
  let prunableTokens = 0;

  for (const entry of analyzed) {
    const item: ContextItem = {
      category: entry.category,
      role: entry.message.role ?? "unknown",
      tokens: entry.tokens,
      index: entry.index,
      protected: entry.protected,
      ...(entry.ref ? { ref: entry.ref } : {}),
      reason: entry.reason,
    };
    included.push(item);
    if (entry.protected) {
      protectedTokens += entry.tokens;
    } else {
      prunableTokens += entry.tokens;
      excluded.push(item);
    }
  }

  const reasons: string[] = [];
  if (budget.overThreshold) {
    reasons.push(
      `estimated input ${budget.estimatedInput} has reached the compaction threshold ${budget.threshold} of usable input ${budget.usableInput}`,
    );
  } else {
    reasons.push(`estimated input ${budget.estimatedInput} is within the threshold ${budget.threshold}`);
  }
  if (budget.overflow) reasons.push("estimated input has reached usable capacity — the request would overflow");
  if (prunableTokens > 0) reasons.push(`${prunableTokens} token(s) are prunable without losing protected state`);

  return {
    budget,
    included,
    excluded,
    protectedTokens,
    prunableTokens,
    estimatedTokens: budget.reservedSystem + budget.reservedTools + budget.estimatedInput,
    compactionNeeded: budget.overThreshold,
    reasons,
  };
}

/** Largest contributors first — for `toolnet context explain`. */
export function largestContributors(plan: ContextPlan, limit = 8): ContextItem[] {
  return [...plan.included].sort((a, b) => b.tokens - a.tokens).slice(0, limit);
}
