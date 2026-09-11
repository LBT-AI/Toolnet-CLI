/**
 * Phase 76A.2 — Background Job Service
 *
 * THE single job registry. Everything asynchronous in ToolNet registers here:
 * background subagents (`task` with `background: true`) and teamwork plans.
 * There is deliberately no `taskBackgroundManager` / `subagentBackgroundStore`
 * split — one service, one source of truth.
 *
 * Design notes:
 *   - Bounded concurrency: jobs above the limit wait in `queued`.
 *   - Dedupe by id: starting a job whose id is already active joins it.
 *   - Generation guard: a superseded run can never settle a newer job (this is
 *     what makes cancel-then-restart safe).
 *   - `extend()` chains more work onto a live job; `promote()` hands a running
 *     job off to the background without interrupting it.
 *   - No polling API surface for the model: completion is a notification.
 */

import {
  DEFAULT_MAX_BACKGROUND_JOBS,
  DEFAULT_WAIT_TIMEOUT_MS,
  isTerminalJobStatus,
  type BackgroundJob,
  type BackgroundJobErrorKind,
  type BackgroundJobEvent,
  type BackgroundJobEventType,
  type BackgroundJobListener,
  type BackgroundJobRun,
  type BackgroundJobSnapshot,
  type BackgroundJobStartInput,
  type BackgroundJobStatus,
  type BackgroundJobWaitResult,
} from "./types";
import {
  loadPersistedJobs,
  savePersistedJobs,
  getBackgroundJobsPath,
} from "./persistence";

interface JobRecord {
  info: BackgroundJob;
  controller: AbortController;
  /** Incremented on every restart/cancel so stale settlements are ignored. */
  generation: number;
  /** Chained work: the current run plus anything added via `extend`. */
  runs: BackgroundJobRun[];
  running: boolean;
  settled: boolean;
  onSettle?: (info: BackgroundJobSnapshot) => void | Promise<void>;
  waiters: Array<() => void>;
  promotionWaiters: Array<() => void>;
  /** The active run's promise, so shutdown can await in-flight work. */
  promise?: Promise<void>;
}

export interface BackgroundJobServiceOptions {
  /** Maximum simultaneously running jobs. */
  maxConcurrency?: number;
  /** Where the snapshot file lives. `null` disables persistence. */
  persistPath?: string | null;
  /** Load and recover jobs from the previous process. */
  recoverOnInit?: boolean;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export class BackgroundJobService {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly listeners = new Set<BackgroundJobListener>();
  private readonly queue: string[] = [];

  private readonly maxConcurrency: number;
  private readonly persistPath: string | null;
  private readonly now: () => number;

  private runningCount = 0;
  private sequence = 0;

  constructor(options: BackgroundJobServiceOptions = {}) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_MAX_BACKGROUND_JOBS);
    this.persistPath = options.persistPath === undefined ? getBackgroundJobsPath() : options.persistPath;
    this.now = options.now ?? (() => Date.now());

    if (options.recoverOnInit !== false) this.recoverFromDisk();
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  get(id: string): BackgroundJobSnapshot | undefined {
    const record = this.jobs.get(id);
    return record ? snapshot(record.info) : undefined;
  }

  list(filter: { status?: BackgroundJobStatus; parentSessionId?: string; type?: BackgroundJob["type"] } = {}): BackgroundJobSnapshot[] {
    return [...this.jobs.values()]
      .map((r) => r.info)
      .filter((job) => (filter.status ? job.status === filter.status : true))
      .filter((job) => (filter.parentSessionId ? job.parentSessionId === filter.parentSessionId : true))
      .filter((job) => (filter.type ? job.type === filter.type : true))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(snapshot);
  }

  /** Snapshot of the service health, handy for UI/tests. */
  stats(): { jobs: number; queued: number; running: number; maxConcurrency: number } {
    return {
      jobs: this.jobs.size,
      queued: this.queue.length,
      running: this.runningCount,
      maxConcurrency: this.maxConcurrency,
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Start (or join) a job. Returns immediately — the caller decides whether to
   * `wait()` for it or leave it running in the background.
   */
  start(input: BackgroundJobStartInput): BackgroundJobSnapshot {
    const id = input.id?.trim() || this.nextId(input.type);

    const existing = this.jobs.get(id);
    if (existing && !isTerminalJobStatus(existing.info.status)) {
      // Dedupe: joining a live job is what makes repeated `task` calls with the
      // same task_id safe instead of forking duplicate work.
      return snapshot(existing.info);
    }

    const record: JobRecord = {
      info: {
        id,
        type: input.type,
        title: input.title || id,
        status: "pending",
        parentSessionId: input.parentSessionId || "session",
        createdAt: this.now(),
        metadata: { ...(input.metadata ?? {}) },
        ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
      },
      controller: new AbortController(),
      generation: (existing?.generation ?? 0) + 1,
      runs: [input.run],
      running: false,
      settled: false,
      waiters: [],
      promotionWaiters: [],
    };
    if (input.onSettle) record.onSettle = input.onSettle;

    this.jobs.set(id, record);

    if (input.immediate) {
      this.launch(record);
    } else {
      record.info.status = "queued";
      this.queue.push(id);
      this.emit(record, "background-job-queued");
      this.pump();
    }

    this.persist();
    return snapshot(record.info);
  }

  /**
   * Attach more work to a live job. Returns false once the job has settled —
   * extensions are never silently accepted on a finished job.
   */
  extend(id: string, run: BackgroundJobRun): boolean {
    const record = this.jobs.get(id);
    if (!record || isTerminalJobStatus(record.info.status)) return false;

    record.runs.push(run);
    // A job that was already claimed by the scheduler needs its worker loop to
    // re-check the queue; the loop yields after each run so a push lands before
    // the loop decides to settle.
    if (record.info.status === "pending") {
      this.queue.push(id);
      record.info.status = "queued";
    }
    this.pump();
    return true;
  }

  /**
   * Hand a running job off to the background without interrupting it: any
   * foreground `wait()` returns immediately with the running snapshot.
   */
  promote(id: string): BackgroundJobSnapshot | undefined {
    const record = this.jobs.get(id);
    if (!record) return undefined;

    record.info.metadata = { ...(record.info.metadata ?? {}), background: true };
    this.drain(record.promotionWaiters);
    this.emit(record, "background-job-progress", { progress: { promoted: true } });
    this.persist();
    return snapshot(record.info);
  }

  /** True while the job is still allowed to be promoted (i.e. not settled). */
  isPromoted(id: string): boolean {
    return this.jobs.get(id)?.info.metadata?.background === true;
  }

  /** Resolve when a job is promoted, or when it settles (whichever is first). */
  async waitForPromotion(id: string): Promise<BackgroundJobSnapshot | undefined> {
    const record = this.jobs.get(id);
    if (!record) return undefined;
    if (this.isPromoted(id) || isTerminalJobStatus(record.info.status)) {
      return snapshot(record.info);
    }

    await new Promise<void>((resolve) => {
      record.promotionWaiters.push(resolve);
    });
    return snapshot(record.info);
  }

  /**
   * Wait for a job to settle. Returns a snapshot + `timedOut` flag; it never
   * throws for a failed job (the failure lives on the snapshot).
   */
  async wait(id: string, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<BackgroundJobWaitResult | undefined> {
    const record = this.jobs.get(id);
    if (!record) return undefined;

    if (!isTerminalJobStatus(record.info.status)) {
      // Promotion ends the foreground wait early — the caller keeps its turn.
      const settled = await this.raceWait(record, timeoutMs);
      if (!settled) {
        return { job: snapshot(record.info), timedOut: true, promoted: false };
      }
    }

    const final = this.jobs.get(id);
    if (!final) return undefined;
    return {
      job: snapshot(final.info),
      timedOut: false,
      promoted: final.info.metadata?.background === true && !isTerminalJobStatus(final.info.status),
    };
  }

  /** Record progress without changing the lifecycle. */
  progress(id: string, progress: unknown): void {
    const record = this.jobs.get(id);
    if (!record || isTerminalJobStatus(record.info.status)) return;
    record.info.metadata = { ...(record.info.metadata ?? {}), progress };
    this.emit(record, "background-job-progress", { progress });
  }

  /**
   * Cancel a job: abort its signal (which kills provider requests and process
   * trees through the existing wiring) and mark it cancelled.
   */
  cancel(id: string, reason = "Cancelled by request"): BackgroundJobSnapshot | undefined {
    const record = this.jobs.get(id);
    if (!record) return undefined;
    if (isTerminalJobStatus(record.info.status)) return snapshot(record.info);

    this.settle(record, "cancelled", { error: reason, errorKind: "cancelled" });
    return snapshot(record.info);
  }

  /** Cancel every live job belonging to a parent session (session close policy). */
  cancelBySession(parentSessionId: string): string[] {
    const cancelled: string[] = [];
    for (const record of this.jobs.values()) {
      if (record.info.parentSessionId !== parentSessionId) continue;
      if (isTerminalJobStatus(record.info.status)) continue;
      this.cancel(record.info.id, "Cancelled: parent session closed");
      cancelled.push(record.info.id);
    }
    return cancelled;
  }

  complete(id: string, result: unknown): BackgroundJobSnapshot | undefined {
    const record = this.jobs.get(id);
    if (!record) return undefined;
    if (isTerminalJobStatus(record.info.status)) return snapshot(record.info);
    this.settle(record, "completed", { result });
    return snapshot(record.info);
  }

  fail(
    id: string,
    error: string,
    errorKind: BackgroundJobErrorKind = "runtime"
  ): BackgroundJobSnapshot | undefined {
    const record = this.jobs.get(id);
    if (!record) return undefined;
    if (isTerminalJobStatus(record.info.status)) return snapshot(record.info);
    this.settle(record, "error", { error, errorKind });
    return snapshot(record.info);
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  subscribe(listener: BackgroundJobListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Test / lifecycle helpers ───────────────────────────────────────────────

  /**
   * Drop every live job (aborting running work first). Tests and shutdown.
   * Bounded: a run that ignores its abort signal must not hang the CLI.
   */
  async shutdown(timeoutMs = 2_000): Promise<void> {
    const live = [...this.jobs.values()].filter((r) => !isTerminalJobStatus(r.info.status));
    for (const record of live) this.cancel(record.info.id, "Service shutdown");

    const pending = Promise.allSettled(live.map((r) => r.promise ?? Promise.resolve()));
    await Promise.race([pending, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);

    this.jobs.clear();
    this.queue.length = 0;
    this.runningCount = 0;
  }

  clear(): void {
    this.jobs.clear();
    this.queue.length = 0;
    this.runningCount = 0;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private nextId(type: BackgroundJob["type"]): string {
    this.sequence++;
    // Readable, greppable, collision-free: job_<type>_<time36>_<seq>.
    return `job_${type}_${this.now().toString(36)}_${this.sequence}`;
  }

  /** Claim queued jobs while capacity remains. */
  private pump(): void {
    while (this.runningCount < this.maxConcurrency && this.queue.length > 0) {
      const id = this.queue.shift() as string;
      const record = this.jobs.get(id);
      if (!record) continue;
      if (isTerminalJobStatus(record.info.status)) continue;

      // A job can be queued twice (start + extend); only launch once.
      if (record.running || record.info.status === "running") continue;
      this.launch(record);
    }
  }

  private launch(record: JobRecord): void {
    record.running = true;
    record.info.status = "running";
    record.info.startedAt = record.info.startedAt ?? this.now();
    this.runningCount++;
    this.emit(record, "background-job-started");
    this.persist();

    record.promise = this.drive(record);
  }

  /**
   * Run the job's work chain, then settle exactly once. The generation captured
   * here is what makes a superseded run harmless: if the job was cancelled or
   * restarted meanwhile, the settlement is discarded.
   */
  private async drive(record: JobRecord): Promise<void> {
    const generation = record.generation;
    const signal = record.controller.signal;

    try {
      let value: unknown;
      // Drain the chain; `extend()` can append while we run.
      for (;;) {
        const next = record.runs.shift();
        if (!next) {
          // Yield so an `extend()` from the current microtask is observed
          // before deciding the job is finished.
          await Promise.resolve();
          if (record.runs.length === 0) break;
          continue;
        }
        value = await next(signal);

        // A cancelled job must not report a completed result.
        if (signal.aborted) {
          this.finishRun(record, generation);
          return;
        }
      }
      this.finishRun(record, generation, { result: value });
    } catch (err: unknown) {
      const aborted = signal.aborted;
      this.finishRun(record, generation, {
        error: aborted ? "Cancelled" : describeError(err),
        errorKind: aborted ? "cancelled" : classifyError(err),
      });
    }
  }

  private finishRun(
    record: JobRecord,
    generation: number,
    outcome?: { result?: unknown; error?: string; errorKind?: BackgroundJobErrorKind }
  ): void {
    this.runningCount = Math.max(0, this.runningCount - 1);
    record.running = false;

    // Stale settlement: the job was cancelled or restarted while this run was
    // in flight. Drop it — never let an old run overwrite newer state.
    if (record.generation !== generation) {
      this.pump();
      return;
    }

    if (outcome?.error) {
      this.settle(record, outcome.errorKind === "cancelled" ? "cancelled" : "error", outcome);
    } else {
      this.settle(record, "completed", { result: outcome?.result });
    }

    this.pump();
  }

  /** Move a job to a terminal state and notify exactly once. */
  private settle(
    record: JobRecord,
    status: BackgroundJobStatus,
    payload: { result?: unknown; error?: string; errorKind?: BackgroundJobErrorKind } = {}
  ): void {
    if (record.settled || isTerminalJobStatus(record.info.status)) return;

    record.settled = true;
    record.info.status = status;
    record.info.completedAt = this.now();
    if (payload.result !== undefined) record.info.result = payload.result;
    if (payload.error !== undefined) record.info.error = payload.error;
    if (payload.errorKind !== undefined) record.info.errorKind = payload.errorKind;

    // Guard against stale settlements from a superseded run.
    record.generation++;
    if (record.running) record.controller.abort();

    this.drain(record.waiters);
    this.drain(record.promotionWaiters);

    const eventType: BackgroundJobEventType =
      status === "completed"
        ? "background-job-completed"
        : status === "cancelled"
          ? "background-job-cancelled"
          : "background-job-error";

    this.emit(record, eventType);
    this.persist();

    // The notification hook runs detached: a slow/throwy listener must never
    // affect job settlement.
    if (record.onSettle) {
      const info = snapshot(record.info);
      void Promise.resolve()
        .then(() => record.onSettle?.(info))
        .catch(() => {});
    }
  }

  /** Wait for settlement, a promotion, or the timeout. */
  private async raceWait(record: JobRecord, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const done = new Promise<boolean>((resolve) => {
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };

      record.waiters.push(() => finish(true));
      record.promotionWaiters.push(() => finish(true));

      timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      // Never keep the process alive just for a wait.
      if (typeof (timer as any)?.unref === "function") (timer as any).unref();
    });

    const result = await done;
    if (!result) return false;

    const current = this.jobs.get(record.info.id);
    if (!current) return false;
    // A promotion is not a settlement: the caller must keep the turn.
    if (!isTerminalJobStatus(current.info.status) && !this.isPromoted(record.info.id)) return false;
    return true;
  }

  private drain(waiters: Array<() => void>): void {
    const pending = [...waiters];
    waiters.length = 0;
    for (const resolve of pending) {
      try {
        resolve();
      } catch {}
    }
  }

  private emit(
    record: JobRecord,
    type: BackgroundJobEventType,
    extra: { progress?: unknown; result?: unknown } = {}
  ): void {
    if (this.listeners.size === 0) return;

    const event: BackgroundJobEvent = {
      type,
      jobId: record.info.id,
      parentSessionId: record.info.parentSessionId,
      jobType: record.info.type,
      status: record.info.status,
      timestamp: this.now(),
      ...(record.info.childSessionId ? { childSessionId: record.info.childSessionId } : {}),
      ...(extra.progress !== undefined ? { progress: extra.progress } : {}),
      ...(extra.result !== undefined || record.info.result !== undefined
        ? { result: extra.result ?? record.info.result }
        : {}),
      ...(record.info.error !== undefined ? { error: record.info.error } : {}),
      ...(record.info.errorKind !== undefined ? { errorKind: record.info.errorKind } : {}),
    };

    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {}
    }
  }

  private persist(): void {
    if (!this.persistPath) return;
    savePersistedJobs([...this.jobs.values()].map((r) => snapshot(r.info)), this.persistPath);
  }

  /** Load the previous process's jobs, marking non-terminal ones interrupted. */
  private recoverFromDisk(): void {
    if (!this.persistPath) return;
    const { jobs } = loadPersistedJobs(this.persistPath);
    for (const job of jobs) {
      this.jobs.set(job.id, {
        info: job,
        controller: new AbortController(),
        generation: 1,
        runs: [],
        running: false,
        settled: isTerminalJobStatus(job.status),
        waiters: [],
        promotionWaiters: [],
      });
    }
  }
}

function snapshot(info: BackgroundJob): BackgroundJobSnapshot {
  return {
    ...info,
    metadata: info.metadata ? { ...info.metadata } : undefined,
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Background job failed";
}

/**
 * Coarse classification drives retry policy: a permission denial or timeout is
 * never retried blindly, whereas a provider blip may be.
 */
function classifyError(err: unknown): BackgroundJobErrorKind {
  const message = describeError(err).toLowerCase();
  if (message.includes("permission denied") || message.includes("not permitted")) return "permission";
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("network") || message.includes("gateway") || message.includes("econn")) return "provider";
  return "runtime";
}

/** Process-wide service. Front-ends and tests may construct isolated ones. */
export const backgroundJobs = new BackgroundJobService();
