/**
 * Compaction orchestration with a progress guarantee.
 *
 * The failure this exists to prevent is a loop that compacts, saves nothing, and
 * compacts again — burning model calls until something else breaks. So a
 * compaction run is defined by measurement, not by the intent of its steps:
 *
 *   - every pass is measured before and after;
 *   - a pass that does not strictly reduce the estimate terminates the run;
 *   - the whole run must clear a minimum saving to count as success;
 *   - the number of passes is bounded, and each strategy runs at most once
 *     before the next one is tried.
 *
 * Deterministic pruning is attempted first. Spending a model call is only worth
 * it once structural cleanup has been exhausted, which is also why the caller
 * injects the summarizer rather than this module reaching for a provider — this
 * layer must not know how to invoke a model.
 */

import { computeContextBudget } from "./budget";
import { estimateMessages, tokenEstimator, type EstimatableMessage } from "./estimator";
import type { CompactionFailure, CompactionOutcome, CompactionRecord, CompactionStrategy } from "./types";

export const DEFAULT_MAX_PASSES = 3;
export const DEFAULT_MIN_SAVINGS_TOKENS = 2_000;
export const DEFAULT_MIN_SAVINGS_RATIO = 0.05;

export interface PruneStepResult {
  messages: EstimatableMessage[];
  prunedCount: number;
}

export interface SummaryStepResult {
  compacted: boolean;
  messages: EstimatableMessage[];
  reason?: string;
  /** Opaque reference to the durable summary, when one was produced. */
  summaryRef?: string;
}

export interface CompactionRunInput {
  messages: EstimatableMessage[];
  model?: string;
  tools?: unknown[];
  sessionId?: string;
  /** Compact even when the estimate is below the threshold. */
  force?: boolean;
  maxPasses?: number;
  minSavingsTokens?: number;
  minSavingsRatio?: number;
  keepRecentToolResults?: number;
  outputBudget?: number;
  signal?: AbortSignal;
  /** Deterministic cleanup step (no model call). */
  prune?: (messages: EstimatableMessage[]) => PruneStepResult;
  /**
   * Model-assisted step. Injected so this layer never calls a provider, and
   * async-capable because the summary is written by a model.
   */
  summarize?: (messages: EstimatableMessage[]) => SummaryStepResult | Promise<SummaryStepResult>;
  /** Set when the request already failed with a verified overflow. */
  overflowObserved?: boolean;
}

type StepKind = "prune" | "summary";

function nextStepKind(previous: CompactionStrategy | null): StepKind | null {
  if (previous === null) return "prune";
  if (previous === "prune") return "summary";
  return null;
}

function makeRecordId(): string {
  return `cmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function runBoundedCompaction(input: CompactionRunInput): Promise<CompactionOutcome> {
  const model = input.model;
  const beforeTokens = estimateMessages(input.messages, model);
  const maxPasses = Math.max(1, Math.floor(input.maxPasses ?? DEFAULT_MAX_PASSES));
  const minSavingsTokens = Math.max(0, input.minSavingsTokens ?? DEFAULT_MIN_SAVINGS_TOKENS);
  const minSavingsRatio = Math.max(0, input.minSavingsRatio ?? DEFAULT_MIN_SAVINGS_RATIO);

  const budget = computeContextBudget({
    messages: input.messages,
    model,
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.outputBudget !== undefined ? { outputBudget: input.outputBudget } : {}),
  });

  if (input.signal?.aborted) {
    return fail(input.messages, beforeTokens, "cancelled", "compaction was cancelled before it started");
  }

  const needed = input.force === true || input.overflowObserved === true || budget.overThreshold;
  if (!needed) {
    return {
      compacted: false,
      messages: input.messages,
      passes: 0,
      beforeTokens,
      afterTokens: beforeTokens,
      savedTokens: 0,
      failure: "nothing_to_compact",
      reason: `context is within budget (estimated ${budget.estimatedInput} of usable ${budget.usableInput})`,
    };
  }

  let working: EstimatableMessage[] = input.messages;
  let currentTokens = beforeTokens;
  let passes = 0;
  // The cursor says which step kind to try next; `applied` says what actually
  // reduced the estimate. They are kept apart because a step that is merely
  // unavailable must not be recorded as a strategy that ran.
  let cursor: CompactionStrategy | null = null;
  const applied = new Set<StepKind>();
  let summaryRef: string | undefined;
  let lastFailure: CompactionFailure | undefined;
  let lastReason = "";

  while (passes < maxPasses) {
    if (input.signal?.aborted) {
      return fail(working, beforeTokens, "cancelled", "compaction was cancelled", currentTokens);
    }

    const step = nextStepKind(cursor);
    if (step === null) break;

    const outcome =
      step === "prune"
        ? runPruneStep(input.prune, working, currentTokens)
        : await runSummaryStep(input.summarize, working, currentTokens);

    if (!outcome) {
      // The strategy is unavailable; move on to the next one rather than
      // counting a pass that did nothing.
      cursor = step === "prune" ? "prune" : "combined";
      continue;
    }

    passes += 1;
    const { result, afterTokens, failure, reason } = outcome;
    if (failure) {
      lastFailure = failure;
      lastReason = reason;
      // A refused summary is terminal: trying it again cannot help.
      if (failure === "refused_integrity") break;
      cursor = step === "prune" ? "prune" : "combined";
      continue;
    }

    if (afterTokens >= currentTokens) {
      lastFailure = afterTokens > currentTokens ? "increased" : "no_reduction";
      lastReason =
        afterTokens > currentTokens
          ? `a ${step} pass increased the estimate (${currentTokens} → ${afterTokens})`
          : `a ${step} pass produced no measurable reduction (${currentTokens} tokens)`;
      break;
    }

    working = result;
    currentTokens = afterTokens;
    applied.add(step);
    cursor = step === "prune" ? "prune" : "combined";
    if ("summaryRef" in (outcome as { summaryRef?: string }) && (outcome as { summaryRef?: string }).summaryRef) {
      summaryRef = (outcome as { summaryRef?: string }).summaryRef;
    }

    // Stop as soon as the request is comfortable again; compaction is not a
    // goal in itself.
    const now = computeContextBudget({ messages: working, model, ...(input.tools ? { tools: input.tools } : {}) });
    if (!now.overThreshold && !input.force && !input.overflowObserved) break;
  }

  const savedTokens = Math.max(0, beforeTokens - currentTokens);
  // Progress is measured proportionally, then capped. A flat floor would demand
  // more savings than a small context can possibly produce, so a legitimately
  // successful compaction on a narrow window would be reported as a failure and
  // the caller would keep retrying something that cannot be improved.
  const requiredSavings = Math.max(1, Math.min(minSavingsTokens, Math.floor(beforeTokens * minSavingsRatio)));

  if (passes === 0) {
    return fail(working, beforeTokens, lastFailure ?? "nothing_to_compact", lastReason || "no compaction strategy was available", currentTokens);
  }

  if (savedTokens < requiredSavings) {
    const failure: CompactionFailure = lastFailure ?? "insufficient_reduction";
    return fail(
      working,
      beforeTokens,
      failure,
      lastReason ||
        `compaction saved ${savedTokens} token(s), below the required ${requiredSavings} — refusing to loop`,
      currentTokens,
      passes,
    );
  }

  // Reaching this point means at least one step reduced the estimate.
  const strategy: CompactionStrategy =
    applied.has("prune") && applied.has("summary") ? "combined" : applied.has("prune") ? "prune" : "structured_summary";

  const record: CompactionRecord = {
    id: makeRecordId(),
    createdAt: Date.now(),
    strategy,
    estimatedTokensBefore: beforeTokens,
    estimatedTokensAfter: currentTokens,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(summaryRef ? { summaryRef } : {}),
  };

  return {
    compacted: true,
    messages: working,
    passes,
    beforeTokens,
    afterTokens: currentTokens,
    savedTokens,
    record,
    reason: `compacted in ${passes} pass(es): ${beforeTokens} → ${currentTokens} tokens (${record.strategy})`,
  };
}

interface StepOutcome {
  result: EstimatableMessage[];
  afterTokens: number;
  failure?: CompactionFailure;
  reason: string;
  summaryRef?: string;
}

function runPruneStep(
  prune: CompactionRunInput["prune"],
  messages: EstimatableMessage[],
  currentTokens: number,
): (StepOutcome & { result: EstimatableMessage[] }) | null {
  if (!prune) return null;
  const pruned = prune(messages);
  const afterTokens = estimateMessages(pruned.messages);
  if (pruned.prunedCount === 0) {
    return {
      result: messages,
      afterTokens: currentTokens,
      failure: "no_reduction",
      reason: "no tool result was eligible for pruning",
    };
  }
  return { result: pruned.messages, afterTokens, reason: `pruned ${pruned.prunedCount} tool result(s)` };
}

async function runSummaryStep(
  summarize: CompactionRunInput["summarize"],
  messages: EstimatableMessage[],
  currentTokens: number,
): Promise<(StepOutcome & { result: EstimatableMessage[] }) | null> {
  if (!summarize) return null;
  const summary = await summarize(messages);
  if (!summary.compacted) {
    return {
      result: messages,
      afterTokens: currentTokens,
      failure: "refused_integrity",
      reason: summary.reason ?? "summarizer refused to compact",
    };
  }
  const afterTokens = estimateMessages(summary.messages);
  return {
    result: summary.messages,
    afterTokens,
    reason: summary.reason ?? "summarized older history",
    ...(summary.summaryRef ? { summaryRef: summary.summaryRef } : {}),
  };
}

function fail(
  messages: EstimatableMessage[],
  beforeTokens: number,
  failure: CompactionFailure,
  reason: string,
  afterTokens = beforeTokens,
  passes = 0,
): CompactionOutcome {
  return {
    compacted: false,
    messages,
    passes,
    beforeTokens,
    afterTokens,
    savedTokens: Math.max(0, beforeTokens - afterTokens),
    failure,
    reason,
  };
}

/**
 * Serialize compaction per session. Two competing summaries for the same context
 * head would waste model calls and could persist whichever finished last rather
 * than whichever is correct, so callers within a process queue behind each other.
 *
 * The map value is a SETTLED guard promise (never rejects) — callers queue on
 * it, but it is only ever used as an identity token for the tail of the queue.
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Stable per-session lock key. A missing session id shares one anonymous slot:
 * serializing unrelated callers is safe, whereas two concurrent compactions for
 * the SAME session would be a correctness bug.
 */
export function compactionLockKey(sessionId?: string): string {
  return sessionId ? `session:${sessionId}` : "session:__anonymous__";
}

export function withCompactionLock<T>(key: string, run: () => Promise<T> | T): Promise<T> {
  const previous = inFlight.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);

  // The cleanup guard must be IDENTITY-based. A queued successor B overwrites
  // the slot before A settles; a blind `delete` would then drop B's lock and
  // let a third caller run concurrently with B. So we install the exact guard
  // this call owns and delete only while it is still the current holder.
  const guard = next.then(
    () => undefined,
    () => undefined,
  );
  inFlight.set(key, guard);

  const release = () => {
    if (inFlight.get(key) === guard) inFlight.delete(key);
  };
  // `.then(release, release)` so the derived promise never rejects — `void`ing
  // a rejecting `.finally(...)` would surface as an unhandled rejection.
  void next.then(release, release);
  return next as Promise<T>;
}

export function isCompactionInFlight(key: string): boolean {
  return inFlight.has(key);
}

/** Reflect usage back into the estimator once a request completes. */
export function observeCompletedRequest(input: {
  model?: string;
  estimatedInputTokens: number;
  actualPromptTokens: number;
}): void {
  tokenEstimator.observeProviderUsage(input);
}
