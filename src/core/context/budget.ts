/**
 * Context budgeting.
 *
 * The invariant is that INPUT NEVER CONSUMES THE WHOLE WINDOW. Capacity is
 * withheld, in this order, before any transcript is admitted:
 *
 *   reservedOutput  room for the answer (a full window of input cannot be answered)
 *   reservedTools   tool schemas, which are paid on every request
 *   reservedSystem  instructions that must always be present
 *
 * System and tool capacity is withheld rather than counted inside
 * `estimatedInput`, so the two are never double-charged. `estimatedInput` is
 * therefore the transcript alone, and the effective request size is
 * `reservedSystem + reservedTools + estimatedInput`.
 *
 * The compaction threshold sits strictly below `usableInput`: compaction should
 * happen before a provider rejects the request, not after.
 */

import { modelCatalog } from "../models/catalog";
import type { ModelCatalog } from "../models/catalog";
import { tokenEstimator, type EstimatableMessage } from "./estimator";
import { OUTPUT_RESERVE_CAP, resolveModelLimits } from "./limits";
import type { ContextBudget } from "./types";

/** Fraction of usable input kept free so compaction can happen before overflow. */
export const DEFAULT_HEADROOM_RATIO = 0.15;

export interface BudgetInput {
  messages: EstimatableMessage[];
  model?: string;
  /** Tool definitions whose schemas ride along with every request. */
  tools?: unknown[];
  /** Explicit output allowance for this turn, when the caller knows better. */
  outputBudget?: number;
  /** Extra capacity withheld for attachments carried outside the transcript. */
  attachmentTokens?: number;
  headroomRatio?: number;
  catalog?: ModelCatalog;
}

function isSystemMessage(message: EstimatableMessage): boolean {
  return message.role === "system";
}

/**
 * Tool schemas are JSON-ish and repeated on every request, so they are estimated
 * rather than counted as zero. A schema that cannot be serialized is charged a
 * small fixed amount instead of being ignored.
 */
export function estimateToolOverhead(tools: unknown[] | undefined, model?: string): number {
  if (!tools || tools.length === 0) return 0;
  let tokens = 0;
  for (const tool of tools) {
    try {
      tokens += tokenEstimator.estimateText(JSON.stringify(tool), model).tokens;
    } catch {
      tokens += 24;
    }
  }
  return tokens;
}

export function computeContextBudget(input: BudgetInput): ContextBudget {
  const limits = resolveModelLimits(input.model, input.catalog);

  // Output capacity: honour an explicit allowance, otherwise reserve the
  // model's output size capped so it never withholds more than it needs to.
  const requestedOutput = input.outputBudget ?? limits.maxOutputTokens;
  const reservedOutput = Math.max(1, Math.min(OUTPUT_RESERVE_CAP, requestedOutput));

  const reservedTools = estimateToolOverhead(input.tools, input.model);
  const attachmentTokens = Math.max(0, input.attachmentTokens ?? 0);

  let reservedSystem = 0;
  const transcript: EstimatableMessage[] = [];
  for (const message of input.messages) {
    if (isSystemMessage(message)) {
      reservedSystem += tokenEstimator.estimateMessage(message, input.model).tokens;
    } else {
      transcript.push(message);
    }
  }

  const usableInput = Math.max(
    0,
    limits.contextWindow - reservedOutput - reservedTools - reservedSystem - attachmentTokens,
  );
  const estimatedInput = tokenEstimator.estimateMessages(transcript, input.model).tokens;
  const remaining = Math.max(0, usableInput - estimatedInput);

  const headroom = clampRatio(input.headroomRatio ?? DEFAULT_HEADROOM_RATIO);
  const threshold = Math.max(1, Math.floor(usableInput * (1 - headroom)));

  return {
    model: input.model ?? "default",
    contextWindow: limits.contextWindow,
    reservedOutput,
    reservedSystem,
    reservedTools,
    usableInput,
    estimatedInput,
    remaining,
    threshold,
    source: limits.source,
    confidence: "low",
    overThreshold: estimatedInput >= threshold,
    overflow: estimatedInput >= usableInput,
  };
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HEADROOM_RATIO;
  return Math.min(0.9, Math.max(0, value));
}

/**
 * The size a request will actually be, for reporting. This is the number to
 * compare against the window — not `estimatedInput` alone.
 */
export function projectedRequestTokens(budget: ContextBudget): number {
  return budget.reservedSystem + budget.reservedTools + budget.estimatedInput;
}

export function describeBudget(budget: ContextBudget): string {
  const projected = projectedRequestTokens(budget);
  const percent = budget.contextWindow > 0 ? Math.round((projected / budget.contextWindow) * 100) : 0;
  return [
    `model ${budget.model}`,
    `window ${budget.contextWindow}`,
    `reserved output ${budget.reservedOutput}`,
    `reserved tools ${budget.reservedTools}`,
    `reserved system ${budget.reservedSystem}`,
    `usable input ${budget.usableInput}`,
    `projected ${projected} (${percent}%)`,
    `remaining ${budget.remaining}`,
    `threshold ${budget.threshold}`,
    `limits from ${budget.source}`,
  ].join(" · ");
}
