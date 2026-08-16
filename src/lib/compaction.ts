import type { ContextMessage, Role, CompactionResult as NewCompactionResult } from "./context/types";
import { estimateMessageChars as engineEstimateChars } from "./context/tokenEstimator";
import { compactMessagesAtomically } from "./context/atomicCompactor";

export type { Role };

export interface Msg {
  role: Role;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

export interface CompactionResult {
  compacted: boolean;
  messages: Msg[];
  originalCount: number;
  newCount: number;
  savedChars: number;
  reason?: string;
}

export const DEFAULT_COMPACTION_THRESHOLD_CHARS = 90000;

export function estimateMessageChars(messages: Msg[]): number {
  return engineEstimateChars(messages as ContextMessage[]);
}

export function compactMessages(
  messages: Msg[],
  options?: {
    force?: boolean;
    thresholdChars?: number;
    keepRecentCount?: number;
  }
): CompactionResult {
  const result = compactMessagesAtomically(messages as ContextMessage[], {
    force: options?.force,
    thresholdChars: options?.thresholdChars ?? DEFAULT_COMPACTION_THRESHOLD_CHARS,
    keepRecentCount: options?.keepRecentCount ?? 6,
  });

  return {
    compacted: result.compacted,
    messages: result.messages as Msg[],
    originalCount: result.originalCount,
    newCount: result.newCount,
    savedChars: result.savedChars,
    reason: result.reason,
  };
}

export * from "./context";
