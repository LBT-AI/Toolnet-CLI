/**
 * Phase 76A.1 — Canonical Background Job Contract
 *
 * ONE job shape for every asynchronous unit of work in ToolNet: a delegated
 * subagent, a long-running tool, or a whole teamwork DAG. Subsystems must not
 * keep their own private job state — they all register here.
 *
 * A job is a *record of intent plus outcome*. It never contains a transcript:
 * the child session owns the transcript, the job owns the lifecycle.
 */

export type BackgroundJobType = "subagent" | "tool" | "teamwork";

/**
 * `queued` is a real state, not an implementation detail: a job that exceeded
 * the concurrency limit is observable as queued rather than looking running.
 */
export type BackgroundJobStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "error"
  | "cancelled";

/** Terminal states — a job in one of these will never change again. */
export const TERMINAL_JOB_STATUSES: readonly BackgroundJobStatus[] = [
  "completed",
  "error",
  "cancelled",
];

export function isTerminalJobStatus(status: BackgroundJobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

/**
 * Coarse failure classification so front-ends and retry policy can react
 * sensibly (a permission denial must never be auto-retried like a timeout).
 */
export type BackgroundJobErrorKind =
  | "permission"
  | "timeout"
  | "provider"
  | "tool"
  | "runtime"
  | "cancelled";

export interface BackgroundJob {
  id: string;
  type: BackgroundJobType;
  title: string;
  status: BackgroundJobStatus;

  parentSessionId: string;
  childSessionId?: string;

  createdAt: number;
  startedAt?: number;
  completedAt?: number;

  result?: unknown;
  error?: string;
  errorKind?: BackgroundJobErrorKind;

  metadata?: Record<string, unknown>;
}

/** Immutable snapshot handed to callers (mutating it never changes the job). */
export interface BackgroundJobSnapshot extends BackgroundJob {}

export interface BackgroundJobStartInput {
  /** Explicit id. Reusing a running job's id joins it instead of forking. */
  id?: string;
  type: BackgroundJobType;
  title?: string;
  parentSessionId?: string;
  childSessionId?: string;
  metadata?: Record<string, unknown>;
  /** The work. Receives the job's abort signal. */
  run: BackgroundJobRun;
  /** Called once the job reaches a terminal state (notification hook). */
  onSettle?: (info: BackgroundJobSnapshot) => void | Promise<void>;
  /** Bypass the concurrency queue (used for plan-level orchestration jobs). */
  immediate?: boolean;
}

/** A unit of work; the signal aborts the job (and everything it spawned). */
export type BackgroundJobRun = (signal: AbortSignal) => Promise<unknown>;

export interface BackgroundJobWaitResult {
  job: BackgroundJobSnapshot;
  /** True when the timeout elapsed before the job settled. */
  timedOut: boolean;
  /** True when the job was promoted to background while waiting. */
  promoted: boolean;
}

// ── Events (76A.5) ───────────────────────────────────────────────────────────

export type BackgroundJobEventType =
  | "background-job-started"
  | "background-job-progress"
  | "background-job-completed"
  | "background-job-error"
  | "background-job-cancelled"
  | "background-job-queued";

export interface BackgroundJobEvent {
  type: BackgroundJobEventType;
  jobId: string;
  parentSessionId: string;
  childSessionId?: string;
  jobType: BackgroundJobType;
  status: BackgroundJobStatus;
  timestamp: number;
  /** Present on progress/completion events. */
  progress?: unknown;
  result?: unknown;
  error?: string;
  errorKind?: BackgroundJobErrorKind;
}

export type BackgroundJobListener = (event: BackgroundJobEvent) => void;

// ── Defaults ─────────────────────────────────────────────────────────────────

/** Bounded parallelism for background work (76A.9). */
export const DEFAULT_MAX_BACKGROUND_JOBS = 4;

/** Default `wait()` timeout — never block a caller indefinitely. */
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
