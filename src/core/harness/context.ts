/**
 * Phase 81 §10 — context policy.
 *
 * A profile chooses how aggressively history is compressed. It does NOT get its
 * own token estimator: the options produced here are handed to the existing
 * ContextEngine (`prepareMessagesForApi`), so there is one accounting path.
 *
 * The load-bearing rule is the retention guarantee. Trimming must never delete
 * a permission DECISION, because a model that "forgets" a DENY will simply
 * issue the same call again — the loop then looks like a stuck model when the
 * real cause was lost context. `ensureDenialsRetained` re-attaches a compact,
 * protected summary whenever the prepared window no longer carries one.
 */

import type { ContextPolicy } from "./types";

/** Marker proving the retained decisions block is present in the transcript. */
export const PERMISSION_DECISIONS_MARKER = "[PERMISSION DECISIONS — RETAINED]";

export interface PermissionDenialRecord {
  toolName: string;
  reason: string;
}

/** Options forwarded verbatim to the ContextEngine. */
export interface PrepareOptions {
  autoPrune: boolean;
  forceCompact: boolean;
}

export function prepareOptionsFor(policy: ContextPolicy): PrepareOptions {
  return { autoPrune: policy.autoPrune, forceCompact: policy.forceCompact };
}

/** Compact, deterministic rendering of the decisions that must survive. */
export function permissionDecisionsBlock(denials: PermissionDenialRecord[]): string {
  const lines = denials.map(
    (denial) => `- ${denial.toolName}: DENIED (${denial.reason}). This decision is final; do not retry it.`,
  );
  return `${PERMISSION_DECISIONS_MARKER}\n${lines.join("\n")}`;
}

interface MessageLike {
  role: string;
  content: string;
}

/** True when the transcript already carries a retained decisions block. */
export function hasRetainedDecisions(messages: MessageLike[]): boolean {
  return messages.some(
    (message) => typeof message.content === "string" && message.content.includes(PERMISSION_DECISIONS_MARKER),
  );
}

/**
 * Guarantee that permission decisions are visible in the outgoing window.
 *
 * `prepared` is only inspected — a denial that survived compaction is left
 * untouched. When it did not survive (or the policy asks for explicit
 * retention and none is present yet) the caller is told to append the block to
 * the durable transcript, which is what makes the guarantee stick across turns.
 */
export function ensureDenialsRetained(
  prepared: MessageLike[],
  denials: PermissionDenialRecord[],
  policy: ContextPolicy,
): { messages: MessageLike[]; appended?: string; retained: boolean } {
  if (!policy.protectPermissionResults) return { messages: prepared, retained: false };
  if (denials.length === 0) return { messages: prepared, retained: false };
  if (hasRetainedDecisions(prepared)) return { messages: prepared, retained: true };

  const block = permissionDecisionsBlock(denials);
  return {
    messages: [...prepared, { role: "user", content: block }],
    appended: block,
    retained: true,
  };
}

/** Human-readable context strategy for `toolnet harness show`. */
export function describeContextPolicy(policy: ContextPolicy): string {
  return `${policy.mode} (autoPrune=${policy.autoPrune}, forceCompact=${policy.forceCompact}, protectPermissionResults=${policy.protectPermissionResults})`;
}
