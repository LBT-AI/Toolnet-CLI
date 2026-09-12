/**
 * Phase 81 §9 — deterministic progress detection.
 *
 * No LLM judge. Progress is a comparison of OBSERVABLE counters between two
 * turns: a new tool call, a new mutation, a new command result, a new
 * diagnostic/test state, a different model response, or reaching a final
 * answer. If none of those moved, the turn made no progress.
 *
 * The counters are cumulative, so a "turn" that merely restates the previous
 * answer while calling the same tool with the same arguments cannot register as
 * progress — which is exactly the stuck-loop shape the bounds exist to stop.
 */

/** Stable fingerprint of a model response, so repetition is detectable. */
export function fingerprintResponse(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  // djb2 — a cheap deterministic hash. Not security-sensitive, and avoids
  // pulling a crypto dependency into the routing/loop hot path.
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) | 0;
  }
  return `${normalized.length}:${(hash >>> 0).toString(36)}`;
}

export interface ProgressSignals {
  /** Fingerprint of this turn's assistant text. */
  responseFingerprint: string;
  /** Cumulative tool executions observed. */
  toolCalls: number;
  /** Cumulative successful workspace mutations. */
  mutations: number;
  /** Cumulative command executions. */
  commands: number;
  /** Cumulative diagnostic/verification/test observations. */
  diagnostics: number;
  /** The model produced a final answer this turn. */
  finalResponse: boolean;
  /** Files newly touched since the previous turn. */
  newFiles: number;
}

export function emptySignals(): ProgressSignals {
  return {
    responseFingerprint: "",
    toolCalls: 0,
    mutations: 0,
    commands: 0,
    diagnostics: 0,
    finalResponse: false,
    newFiles: 0,
  };
}

export interface ProgressVerdict {
  progressed: boolean;
  reasons: string[];
}

/**
 * Pure comparison. Ordered checks with early exits — no nested branching.
 */
export function detectProgress(
  previous: ProgressSignals | null,
  next: ProgressSignals,
): ProgressVerdict {
  if (previous === null) return { progressed: true, reasons: ["first turn"] };

  if (next.finalResponse) return { progressed: true, reasons: ["final response"] };
  if (next.toolCalls > previous.toolCalls) return { progressed: true, reasons: ["new tool call"] };
  if (next.mutations > previous.mutations) return { progressed: true, reasons: ["new file mutation"] };
  if (next.commands > previous.commands) return { progressed: true, reasons: ["new command result"] };
  if (next.diagnostics > previous.diagnostics) return { progressed: true, reasons: ["new diagnostic/test state"] };
  if (next.newFiles > previous.newFiles) return { progressed: true, reasons: ["new file touched"] };
  if (next.responseFingerprint !== previous.responseFingerprint) {
    return { progressed: true, reasons: ["different model response"] };
  }

  return { progressed: false, reasons: ["no tool, mutation, command, diagnostic or response change"] };
}

export interface ProgressObservation {
  progressed: boolean;
  noProgressTurns: number;
  reasons: string[];
}

/**
 * Stateful tracker for one run. `maxConsecutiveNoProgressTurns <= 0` disables
 * the bound (the identity profile's behaviour).
 */
export class ProgressTracker {
  private previous: ProgressSignals | null = null;
  private streak = 0;
  private readonly maxConsecutive: number;

  constructor(maxConsecutiveNoProgressTurns: number) {
    this.maxConsecutive = maxConsecutiveNoProgressTurns;
  }

  observe(signals: ProgressSignals): ProgressObservation {
    const verdict = detectProgress(this.previous, signals);
    this.previous = signals;
    if (verdict.progressed) {
      this.streak = 0;
      return { ...verdict, noProgressTurns: 0 };
    }
    this.streak += 1;
    return { ...verdict, noProgressTurns: this.streak };
  }

  /** True when the configured bound has been reached (disabled → always false). */
  exceeded(): boolean {
    if (this.maxConsecutive <= 0) return false;
    return this.streak >= this.maxConsecutive;
  }

  get noProgressTurns(): number {
    return this.streak;
  }

  get enabled(): boolean {
    return this.maxConsecutive > 0;
  }

  reset(): void {
    this.previous = null;
    this.streak = 0;
  }
}
