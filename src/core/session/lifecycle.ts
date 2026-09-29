/**
 * Deterministic session lifecycle.
 *
 * One owner for the invariants that used to be spread across timers and
 * callback timing in the TUI:
 *
 *   1. MAXIMUM ONE foreground provider request per session. A submit that
 *      arrives while a run is in flight is admitted as a steer (durable, FIFO)
 *      — never a second concurrent request.
 *   2. Steer/follow-up inputs are FIFO, delivered exactly once, never lost and
 *      never duplicated (the registry + journal own durability; this driver owns
 *      *when* they become work).
 *   3. The completion boundary is ATOMIC: after a run settles, the next work is
 *      chosen in the same synchronous step — a steer admitted during the settle
 *      window becomes the next run there and then. A continuation carries the
 *      promoted steer text, so there is never an empty synthetic user prompt.
 *   4. IDLE is only reported when every blocker is clear (see `idleBlockers`).
 *   5. FAILED never becomes DONE: the phase is written exactly once per run, by
 *      `settle`.
 *   6. The canonical error is delivered exactly once per settled run.
 *   7. Cancel settles the active work and stops the drain — a late provider/tool
 *      result cannot resurrect the run (settle is guarded by run id).
 *   8. Crash/restart keeps the durable state (registry + journal) and replay
 *      never re-runs a tool (the resume layer owns that; this driver never
 *      retries work on its own).
 *
 * The driver owns no I/O and no timers: callers inject the run executor and the
 * pending-input/queue sources, so it is fully deterministic under test.
 */

/** How the work reached the session. */
export type RunKind = "user" | "continuation";

/** Lifecycle phase of one session (the driver is per session). */
export type SessionPhase = "idle" | "running" | "done" | "failed" | "cancelled";

export interface ForegroundRun {
  /** Monotonic per-driver run id: a late settle for an old run is ignored. */
  runId: number;
  kind: RunKind;
  /**
   * User-visible text that drives this run's task requirements. For a
   * continuation this is the promoted steer text — NEVER an empty string.
   */
  text: string;
  /** Steers promoted for this run, FIFO. One user message each. */
  promoted: string[];
}

export interface RunOutcome {
  success: boolean;
  error?: string;
  /** Set when the run was aborted by the user (or the run reports a cancel). */
  cancelled?: boolean;
}

export interface SettledRun {
  run: ForegroundRun;
  phase: SessionPhase;
  outcome: RunOutcome;
  /** Canonical, user-facing error (undefined when the run succeeded). */
  error?: string;
  /** Work that starts immediately after this settle, if any. */
  next: ForegroundRun | null;
}

export interface IdleGateInputs {
  /** A foreground provider request is in flight (or about to start). */
  foregroundRequest: boolean;
  activeTools: number;
  pendingPermission: number;
  pendingSteer: number;
  queuedMessages: number;
  /** A bound continuation (promoted steer) is scheduled. */
  continuation: boolean;
  compactionPending: boolean;
  foregroundSubtasks: number;
}

/**
 * Every reason the session must NOT be reported idle. Empty array === idle is
 * allowed. This is the canonical mapping of invariant 4.
 */
export function idleBlockers(inputs: IdleGateInputs): string[] {
  const blockers: string[] = [];
  if (inputs.foregroundRequest) blockers.push("foreground-request");
  if (inputs.activeTools > 0) blockers.push("active-tool");
  if (inputs.pendingPermission > 0) blockers.push("pending-permission");
  if (inputs.pendingSteer > 0) blockers.push("pending-steer");
  if (inputs.queuedMessages > 0) blockers.push("queued-message");
  if (inputs.continuation) blockers.push("continuation");
  if (inputs.compactionPending) blockers.push("compaction");
  if (inputs.foregroundSubtasks > 0) blockers.push("foreground-subtask");
  return blockers;
}

export function canSettleIdle(inputs: IdleGateInputs): boolean {
  return idleBlockers(inputs).length === 0;
}

/**
 * The ONE canonical error for a settled run. A failure without a message still
 * produces an actionable string (never an empty status), a cancel is reported as
 * a cancel, and a success has no error.
 */
export function canonicalRunError(outcome: RunOutcome | undefined): string | undefined {
  if (!outcome) return undefined;
  if (outcome.cancelled) return "Cancelled";
  if (outcome.success) return undefined;
  const message = typeof outcome.error === "string" ? outcome.error.trim() : "";
  return message.length > 0 ? message : "Execution failed";
}

export interface SessionRunDriverOptions {
  sessionId: string;
  /** Execute ONE foreground turn. Resolves when the turn AND its tools settled. */
  run(run: ForegroundRun): Promise<RunOutcome>;
  /**
   * Promote this session's pending steers (FIFO, exactly once) and return their
   * content in admission order.
   */
  promoteSteers(): string[];
  /** Next queued user message (FIFO), or null. */
  dequeueMessage(): { id: string; text: string } | null;
  /** Admit text that arrived while a run was in flight — never dropped. */
  admitSteer?(text: string): void;
  /** App-owned blockers (live tools, permissions, compaction, subtasks, …). */
  externalIdleBlockers?(): string[];
  /** Exactly-once terminal notification for a settled run. */
  onSettle?(settled: SettledRun): void;
  /** Reported once the drain ended AND the idle gate is clear. */
  onIdle?(): void;
  /**
   * Reported exactly once when the drain ends, whether the session settled idle
   * or is held out of idle by a blocker. `phase` is the final session phase and
   * `blockers` lists why idle was not reported (empty when it was).
   */
  onDrainEnd?(end: { phase: SessionPhase; blockers: string[] }): void;
  /** Abort hook used by `cancel()` (the caller owns the AbortController). */
  abort?(): void;
}

export interface SubmitResult {
  /** True when this submit started the foreground run. */
  started: boolean;
  /** True when the submit was admitted as a steer because a run was in flight. */
  admittedAsSteer: boolean;
  phase: SessionPhase;
}

interface WorkItem {
  kind: RunKind;
  text: string;
  promoted: string[];
}

export class SessionRunDriver {
  private phase: SessionPhase = "idle";
  private current: ForegroundRun | null = null;
  private runSeq = 0;
  private drainPromise: Promise<SessionPhase> | null = null;
  private cancelRequested = false;
  private readonly settledRunIds = new Set<number>();
  private last: SettledRun | null = null;
  private idleReported = true;

  /** Observability counters (asserted by the race tests). */
  runsStarted = 0;
  steersPromoted = 0;
  busySubmitsAdmitted = 0;
  continuesAfterFailure = 0;

  constructor(private readonly options: SessionRunDriverOptions) {}

  get sessionId(): string {
    return this.options.sessionId;
  }

  getPhase(): SessionPhase {
    return this.phase;
  }

  isBusy(): boolean {
    return this.current !== null;
  }

  getCurrentRun(): ForegroundRun | null {
    return this.current;
  }

  getLastSettled(): SettledRun | null {
    return this.last;
  }

  /** Reasons idle must not be reported right now. */
  idleBlockers(): string[] {
    const external = this.options.externalIdleBlockers?.() ?? [];
    const blockers = [...external];
    if (this.current) blockers.push("foreground-request");
    if (this.phase === "running") blockers.push("foreground-request");
    return blockers;
  }

  /**
   * Submit user text. Returns whether it started a run; a submit while busy is
   * admitted as a steer instead of racing a second provider request.
   */
  submit(text: string): SubmitResult {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed) return { started: false, admittedAsSteer: false, phase: this.phase };

    if (this.isBusy()) {
      this.options.admitSteer?.(trimmed);
      this.busySubmitsAdmitted += 1;
      return { started: false, admittedAsSteer: true, phase: this.phase };
    }

    void this.startDrain({ kind: "user", text: trimmed, promoted: [] });
    return { started: true, admittedAsSteer: false, phase: "running" };
  }

  /**
   * Resume leftover work without new text: promote pending steers and/or drain
   * the queue. Deterministic replacement for `sendMessage("", true)` + timers.
   */
  resumePendingWork(): boolean {
    if (this.isBusy()) return false;
    const work = this.nextWork(false);
    if (!work) return false;
    void this.startDrain(work);
    return true;
  }

  /**
   * Cancel the active run. Settles the in-flight work and STOPS the drain: a
   * late provider/tool result can neither settle the run a second time nor
   * resurrect the session into more work.
   */
  cancel(): boolean {
    if (!this.current) return false;
    this.cancelRequested = true;
    try {
      this.options.abort?.();
    } catch {
      /* an abort hook must never break the settle path */
    }
    return true;
  }

  /** Await the current drain (idle / terminal settle). */
  async whenSettled(): Promise<SessionPhase> {
    if (this.drainPromise) return this.drainPromise;
    return this.phase;
  }

  /**
   * Re-evaluate the idle gate. Call this after an external blocker clears (a
   * background tool finished, a permission was resolved): the driver reports
   * IDLE only once every blocker is gone.
   */
  refreshIdle(): boolean {
    if (this.isBusy()) return false;
    if (this.idleBlockers().length > 0) return false;
    this.phase = "idle";
    if (!this.idleReported) {
      this.idleReported = true;
      this.options.onIdle?.();
    }
    return true;
  }

  // ── internals ───────────────────────────────────────────────────────────

  private startDrain(initial: WorkItem): Promise<SessionPhase> {
    const promise = this.drain(initial);
    this.drainPromise = promise;
    void promise.finally(() => {
      if (this.drainPromise === promise) this.drainPromise = null;
    });
    return promise;
  }

  private async drain(initial: WorkItem): Promise<SessionPhase> {
    let work: WorkItem | null = initial;

    while (work) {
      this.runSeq += 1;
      const run: ForegroundRun = { ...work, runId: this.runSeq };
      this.current = run;
      this.phase = "running";
      this.idleReported = false;
      this.runsStarted += 1;

      let outcome: RunOutcome;
      try {
        outcome = await this.options.run(run);
      } catch (error) {
        outcome = { success: false, error: error instanceof Error ? error.message : String(error) };
      }

      // Settle EXACTLY once per run: anything arriving after this point (a late
      // provider/tool continuation) cannot flip the phase again.
      if (this.settledRunIds.has(run.runId)) {
        work = null;
        continue;
      }
      this.settledRunIds.add(run.runId);
      this.current = null;

      const cancelled = this.cancelRequested || outcome.cancelled === true;
      this.cancelRequested = false;
      const settledOutcome: RunOutcome = { ...outcome, cancelled };
      this.phase = cancelled ? "cancelled" : outcome.success ? "done" : "failed";

      // ── Atomic completion boundary ──────────────────────────────────────
      // Chosen here, in the same synchronous step as the settle: a steer
      // admitted anywhere before this line becomes the next run immediately.
      const next = cancelled ? null : this.nextWork(false);
      if (next && !outcome.success && !cancelled) this.continuesAfterFailure += 1;

      this.last = {
        run,
        phase: this.phase,
        outcome: settledOutcome,
        error: canonicalRunError(settledOutcome),
        next: next
          ? { runId: this.runSeq + 1, kind: next.kind, text: next.text, promoted: [...next.promoted] }
          : null,
      };
      this.options.onSettle?.(this.last);

      // A steer admitted DURING onSettle (the exact-completion race) must still
      // become work: re-check only when the first pass found nothing.
      work = next ?? (cancelled ? null : this.nextWork(false));
    }

    // The drain ended. Idle is reported only when the gate is clear.
    const blocked = this.idleBlockers();
    if (blocked.length === 0) {
      this.phase = "idle";
      this.idleReported = true;
      this.options.onIdle?.();
    }
    this.options.onDrainEnd?.({ phase: this.phase, blockers: [...blocked] });
    return this.phase;
  }

  /**
   * The completion-boundary transition, in priority order:
   *   1. pending steers → ONE continuation carrying their (FIFO) text,
   *   2. queued messages → the next queued run,
   *   3. nothing → settle.
   */
  private nextWork(cancelled: boolean): WorkItem | null {
    if (cancelled) return null;

    const promoted = this.options.promoteSteers();
    if (promoted.length > 0) {
      this.steersPromoted += promoted.length;
      return { kind: "continuation", text: promoted.join("\n\n"), promoted };
    }

    const queued = this.options.dequeueMessage();
    if (queued) return { kind: "user", text: queued.text, promoted: [] };

    return null;
  }
}
