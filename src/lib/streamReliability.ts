/**
 * — Stream terminal validation and stall detection.
 *
 * The watchdog needs no pause/resume: a model request's stream is fully
 * consumed before any local tool executes, so "time spent running tools" can
 * never be observed as provider inactivity.
 *
 * Two invariants the agent loop must never violate:
 *
 *   1. A connection that ends without protocol evidence of completion is NOT
 *      a success. A truncated stream (network drop, proxy timeout, server
 *      crash mid-generation) must be classified STREAM_INCOMPLETE so callers
 *      can treat it as a retryable failure instead of shipping half an answer.
 *
 *   2. A live HTTP connection can still be dead. A bounded inactivity timeout
 *      on chunk arrival converts an indefinitely hung read into a retryable
 *      timeout; the detector is paused while local tools execute, because a
 *      paused model stream is not provider inactivity.
 *
 * Both checks observe only — they never change request semantics.
 */

/** Protocol evidence a completed stream must carry. */
export interface StreamObservation {
  /** Any content, reasoning or tool-call delta arrived. */
  sawChunk: boolean;
  /** A terminal finish reason was observed (stop/length/tool_calls/...). */
  sawFinishReason: boolean;
  /** Token usage was reported by the provider. */
  sawUsage: boolean;
}

export type StreamVerdict = "complete" | "incomplete";

export class StreamIncompleteError extends Error {
  /** Retryable: a truncated stream may succeed on a fresh attempt. */
  readonly retryable = true as const;
  /** Failure taxonomy bucket (structured errors, not flat strings). */
  readonly failureKind = "STREAM_INCOMPLETE" as const;
  readonly observation: StreamObservation;

  constructor(observation: StreamObservation) {
    super(
      observation.sawChunk
        ? "Stream ended without a terminal finish condition (truncated stream)."
        : "Stream ended without any chunk and without a terminal finish condition.",
    );
    this.name = new.target.name;
    this.observation = observation;
  }
}

/**
 * Validate how a stream ended. A stream is COMPLETE only when the provider
 * produced a terminal finish reason; usage is strong corroboration but never
 * a substitute. A stream that emitted deltas and then dissolved is the
 * classic silent-EOF defect: incomplete, not success.
 */
export function validateStreamTerminal(observation: StreamObservation): StreamVerdict {
  if (observation.sawFinishReason) return "complete";
  return "incomplete";
}

/**
 * Classify the end of a streaming turn, throwing on silent truncation.
 * Non-streaming responses (single JSON body) are exempt: their transport is
 * complete by construction.
 */
export function requireStreamTerminal(observation: StreamObservation): void {
  if (validateStreamTerminal(observation) === "incomplete") {
    throw new StreamIncompleteError(observation);
  }
}

/**
 * Bounded inactivity watchdog for one streaming request.
 *
 * `start()` arms the timer and every arriving chunk re-arms it. When the
 * deadline elapses the watcher fires exactly once and aborts the underlying
 * request.
 */
export class StreamStallWatch {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fired = false;

  constructor(
    private readonly timeoutMs: number,
    private readonly onStall: () => void,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`StreamStallWatch requires a positive timeout, received ${timeoutMs}`);
    }
  }

  start(): void {
    if (this.timer !== null || this.fired) return;
    this.timer = setTimeout(() => {
      if (this.fired) return;
      this.fired = true;
      this.timer = null;
      try {
        this.onStall();
      } catch {
        // A stall callback must never crash the consuming loop.
      }
    }, this.timeoutMs);
    // Do not hold the process open for a watchdog.
    if (typeof this.timer === "object" && this.timer !== null && "unref" in this.timer) {
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** A chunk arrived: re-arm for a full window. */
  noteChunk(): void {
    if (this.fired) return;
    this.stopTimer();
    this.start();
  }

  /**
   * The stream ended on its own (success or unrelated error): disarm without
   * recording a stall, so `stalled` stays a truthful observation.
   */
  complete(): void {
    this.stopTimer();
  }

  get stalled(): boolean {
    return this.fired;
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** Default provider-stream inactivity window (bounded, not infinite). */
export const STREAM_STALL_TIMEOUT_MS = 120_000;
