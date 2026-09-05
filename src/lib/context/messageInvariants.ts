import type { ContextMessage } from "./types";

/**
 * System-message invariant for all provider adapters:
 * there is at most one primary system instruction and, when present, it is
 * the first message. Status notices and compaction summaries are not system
 * messages and therefore cannot accidentally become provider instructions.
 */
export function normalizePrimarySystemMessage(messages: ContextMessage[]): ContextMessage[] {
  const primary = messages.find((message) => message.role === "system");
  const withoutSystem = messages.filter((message) => message.role !== "system");
  return primary ? [primary, ...withoutSystem] : withoutSystem;
}

export function assertPrimarySystemMessageInvariant(messages: ContextMessage[]): void {
  const systems = messages.filter((message) => message.role === "system");
  if (systems.length > 1) {
    throw new Error(`Message invariant violated: expected at most one primary system message, found ${systems.length}`);
  }
  if (systems.length === 1 && messages[0] !== systems[0]) {
    throw new Error("Message invariant violated: primary system message must be at index 0");
  }
}
