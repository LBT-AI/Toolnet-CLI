import type { ContextMessage } from "./types";
import { tokenEstimator as canonicalEstimator } from "../../core/context/estimator";

/**
 * Legacy names for the canonical estimator.
 *
 * Every number a caller gets here comes from the one estimator in
 * `core/context/estimator`, so budgeting and compaction can never disagree about
 * how large a transcript is. These wrappers exist only to keep the historical
 * call sites working; new code should use the estimator directly.
 */

export function estimateTokens(text: string | null | undefined): number {
  return canonicalEstimator.estimateText(text).tokens;
}

export function estimateMessageTokens(msg: ContextMessage): number {
  return canonicalEstimator.estimateMessage(msg).tokens;
}

export function estimateTotalTokens(messages: ContextMessage[]): number {
  return canonicalEstimator.estimateMessages(messages).tokens;
}

/**
 * Character count, not tokens. Retained because compaction thresholds and
 * reporting are expressed in characters in some call sites.
 */
export function estimateMessageChars(messages: ContextMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += (m.content || "").length;
    if (m.name) total += m.name.length;
    if (m.tool_calls) {
      try {
        total += JSON.stringify(m.tool_calls).length;
      } catch {
        total += 50;
      }
    }
  }
  return total;
}
