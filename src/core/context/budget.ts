/**
 * Context budgeting.
 *
 * The invariant is that INPUT NEVER CONSUMES THE WHOLE WINDOW. How much of the
 * window is actually available for input comes from the model's OWN metadata
 * (see `resolveUsableInput`) instead of a single hard-coded number:
 *
 *   model declares an input limit → input - reserved
 *   otherwise                    → context - maxOutputTokens
 *
 * The answer's capacity is withheld first (a full window of input cannot be
 * answered), then tool schemas and system instructions are measured. System and
 * tool capacity is reported separately rather than folded into
 * `estimatedInput`, so the two are never double-charged: `estimatedInput` is the
 * transcript alone, and `usedInput` is the whole request.
 *
 * Compaction fires as soon as the request REACHES `usableInput` — that is the
 * per-model trigger, which is why there is no separate headroom fraction here.
 */

import { modelCatalog } from "../models/catalog";
import type { ModelCatalog } from "../models/catalog";
import { tokenEstimator, type EstimatableMessage } from "./estimator";
import { resolveModelLimits, resolveUsableInput } from "./limits";
import type { ContextBudget } from "./types";

export interface BudgetInput {
  messages: EstimatableMessage[];
  model?: string;
  /** Tool definitions whose schemas ride along with every request. */
  tools?: unknown[];
  /** Explicit output allowance for this turn, when the caller knows better. */
  outputBudget?: number;
  /** Extra capacity withheld for attachments carried outside the transcript. */
  attachmentTokens?: number;
  /**
   * Override how much capacity is withheld for the answer. Only consulted for
   * models that declare an input limit, and never applied to the window.
   */
  configuredReserved?: number;
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

  // How much of THIS model's capacity the request may occupy — from the model's
  // declared limits, with the answer's reservation resolved per rule.
  const resolved = resolveUsableInput(
    limits,
    input.configuredReserved !== undefined ? input.configuredReserved : input.outputBudget,
  );

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

  // Attachments ride outside the transcript, so they withhold capacity rather
  // than being added to `usedInput` (which would charge them twice).
  const usableInput = Math.max(0, resolved.usable - attachmentTokens);
  const estimatedInput = tokenEstimator.estimateMessages(transcript, input.model).tokens;
  const usedInput = reservedSystem + reservedTools + estimatedInput;
  const remaining = Math.max(0, usableInput - usedInput);

  return {
    model: input.model ?? "default",
    contextWindow: limits.contextWindow,
    reservedOutput: resolved.reserved,
    reservedSystem,
    reservedTools,
    usableInput,
    usableRule: resolved.rule,
    estimatedInput,
    usedInput,
    remaining,
    // The trigger IS the usable capacity: reaching it means this model has no
    // room left for the turn, so there is no separate frontier to derive.
    threshold: usableInput,
    source: limits.source,
    confidence: "low",
    overThreshold: usedInput >= usableInput,
    overflow: usedInput > usableInput,
  };
}

/**
 * The size a request will actually be, for reporting. This is the number to
 * compare against the window — not `estimatedInput` alone. It is the same figure
 * the trigger compares against `usableInput` (`budget.usedInput`).
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
    `usable input ${budget.usableInput} (${budget.usableRule})`,
    `used ${budget.usedInput} of ${budget.usableInput} (${percent}% of window)`,
    `projected ${projected} (${percent}%)`,
    `remaining ${budget.remaining}`,
    `threshold ${budget.threshold}`,
    `limits from ${budget.source}`,
  ].join(" · ");
}
