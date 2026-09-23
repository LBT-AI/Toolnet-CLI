/**
 * Canonical durable-session model.
 *
 * A session on disk is a *reconstruction base* plus an append-only journal:
 *
 *   <id>.json             materialized record (atomic, complete snapshot)
 *   <id>.events.jsonl     canonical event journal (append-only)
 *   <id>.checkpoints.jsonl durable reconstruction boundaries (append-only)
 *
 * The materialized record is what a fresh reader loads. The journal is what a
 * crash survivor replays to learn what happened after the last checkpoint.
 * Neither ever contains credentials, live objects, or process handles — only
 * stable identities, so a resumed session cannot carry a stale secret or a
 * dead socket forward.
 */

import type { ExecutionEvidence } from "../harness/evidence";

export const SESSION_SCHEMA_VERSION = 1;

export type SessionStatus =
  | "idle"
  | "running"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export const SESSION_STATUSES: SessionStatus[] = [
  "idle",
  "running",
  "waiting_permission",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

/** Statuses that mean execution was in flight when the process stopped. */
export const ACTIVE_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  "running",
  "waiting_permission",
]);

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && (SESSION_STATUSES as string[]).includes(value);
}

// ── Workspace identity ──────────────────────────────────────────────────────

/**
 * Identifies the project a session belongs to. `path` alone is not enough: a
 * checkout can be moved or copied, and resuming someone else's session into an
 * unrelated repository is exactly the failure this guards against. `key` is the
 * stable project identity (git remote + relative path, else a project marker),
 * so a moved workspace is recognized as *moved* rather than silently accepted.
 */
export interface WorkspaceIdentity {
  path: string;
  root: string;
  gitRoot?: string;
  key: string;
}

export type WorkspaceMatch = "same" | "moved" | "missing" | "mismatch";

// ── Message transcript ──────────────────────────────────────────────────────

export interface SessionMessage {
  role: string;
  content: string;
  /** Stable message identity used by streaming and viewport anchors. */
  id?: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
  [key: string]: any;
}

// ── Event journal ───────────────────────────────────────────────────────────

export type SessionEventType =
  | "session.created"
  | "session.status"
  | "session.completed"
  | "session.failed"
  | "session.cancelled"
  | "user.message"
  | "assistant.message"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "permission.decision"
  | "model.selection"
  | "harness.selection"
  | "auth.pin"
  | "context.compaction"
  | "checkpoint.created";

export const SESSION_EVENT_TYPES: SessionEventType[] = [
  "session.created",
  "session.status",
  "session.completed",
  "session.failed",
  "session.cancelled",
  "user.message",
  "assistant.message",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "permission.decision",
  "model.selection",
  "harness.selection",
  "auth.pin",
  "context.compaction",
  "checkpoint.created",
];

export function isSessionEventType(value: unknown): value is SessionEventType {
  return typeof value === "string" && (SESSION_EVENT_TYPES as string[]).includes(value);
}

export interface SessionEvent {
  /** Strictly increasing per session; the replay order is the sequence order. */
  seq: number;
  at: number;
  type: SessionEventType;
  data?: Record<string, unknown>;
}

// ── Evidence summary ────────────────────────────────────────────────────────

/**
 * Compact projection of the harness evidence model. Storing the whole
 * `ExecutionEvidence` would be fine, but the checkpoint only needs the counters
 * a resume must not lose: what changed, what ran, what was denied.
 */
export interface ExecutionEvidenceSummary {
  toolCalls: number;
  failedToolCalls: number;
  filesChanged: string[];
  filesReadCount: number;
  commandsRun: number;
  testsRun: number;
  permissionDenials: number;
  verificationResults: number;
  turns: number;
}

export function summarizeEvidence(evidence: ExecutionEvidence | null | undefined): ExecutionEvidenceSummary {
  return {
    toolCalls: evidence?.toolCalls ?? 0,
    failedToolCalls: evidence?.failedToolCalls ?? 0,
    filesChanged: [...(evidence?.filesChanged ?? [])].slice(-100),
    filesReadCount: evidence?.filesRead?.length ?? 0,
    commandsRun: evidence?.commandsRun ?? 0,
    testsRun: evidence?.testsRun ?? 0,
    permissionDenials: evidence?.permissionDenials ?? 0,
    verificationResults: evidence?.verificationResults ?? 0,
    turns: evidence?.turns ?? 0,
  };
}

export function emptyEvidenceSummary(): ExecutionEvidenceSummary {
  return summarizeEvidence(null);
}

// ── Checkpoints ─────────────────────────────────────────────────────────────

/**
 * A durable reconstruction boundary. It is NOT a git commit and it is NOT a
 * pointer into a separate store: the checkpoint line itself is the boundary, and
 * `eventSequence` records how many journal events it already covers. Because the
 * line is written after those events are durable, a checkpoint can never
 * reference state that does not exist — and a truncated tail can always be
 * replayed from the newest *valid* checkpoint.
 */
export interface SessionCheckpoint {
  checkpointId: string;
  sessionId: string;
  eventSequence: number;
  at: number;
  messageCount: number;
  workspaceKey: string;
  status: SessionStatus;
  reason: string;
  model?: string;
  provider?: string;
  harness?: string;
  authProfileId?: string;
  verdict?: string;
  evidence?: ExecutionEvidenceSummary;
}

export const CHECKPOINT_REASONS = [
  "session-created",
  "turn-complete",
  "manual",
  "pre-fork",
  "shutdown",
  "migration",
] as const;

export type CheckpointReason = string;

// ── Durable record ──────────────────────────────────────────────────────────

export interface SessionRecord {
  version: number;
  id: string;
  title?: string;
  workspace: WorkspaceIdentity;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  parentSessionId?: string;
  forkedFromCheckpointId?: string;
  /** Stable identities only — never a credential, token or header. */
  model?: string;
  provider?: string;
  harness?: string;
  authProfileId?: string;
  messages: SessionMessage[];
  metadata: Record<string, unknown>;
  checkpointHead?: string;
  context?: unknown;
}

// ── Index ───────────────────────────────────────────────────────────────────

/**
 * Cheap list metadata. The picker and `continue` read this instead of loading
 * every transcript, which keeps listing O(index) rather than O(transcripts).
 */
/**
 * Where a session's `title` came from. `manual` (the user renamed it) always
 * beats `auto` (generated in the background from the first real task).
 */
export type SessionTitleSource = "auto" | "manual";

export interface SessionIndexEntry {
  id: string;
  title?: string;
  /**
   * First substantive user message, for sessions that are still untitled. Kept
   * in the index so the picker can label a session without loading every
   * transcript (listing stays O(index)).
   */
  preview?: string;
  workspacePath: string;
  workspaceKey: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  model?: string;
  provider?: string;
  harness?: string;
  messageCount: number;
  parentSessionId?: string;
}

export interface SessionIndex {
  version: number;
  updatedAt: string;
  sessions: Record<string, SessionIndexEntry>;
}

// ── Resume ──────────────────────────────────────────────────────────────────

export interface InterruptedTool {
  callId: string;
  name: string;
  startedAt: number;
  reason: "started_without_completion";
}

export interface ResumeIdentity {
  model?: string;
  provider?: string;
  harness?: string;
  authProfileId?: string;
}

export interface ResumedSession {
  id: string;
  record: SessionRecord;
  transcript: SessionMessage[];
  status: SessionStatus;
  checkpointHead?: SessionCheckpoint;
  workspaceMatch: WorkspaceMatch;
  identity: ResumeIdentity;
  evidence: ExecutionEvidenceSummary;
  /** Tool calls durably seen as started but never as completed. */
  interruptedTools: InterruptedTool[];
  replayedEvents: number;
  warnings: string[];
}

export interface SessionDoctorReport {
  sessionsDir: string;
  /** False on a fresh store — absence is not damage. */
  indexPresent: boolean;
  indexOk: boolean;
  indexRepaired: boolean;
  totalSessions: number;
  issues: SessionDoctorIssue[];
}

export interface SessionDoctorIssue {
  kind:
    | "corrupt-record"
    | "corrupt-journal"
    | "missing-checkpoint"
    | "orphan-directory"
    | "stale-lock"
    | "index-desync"
    | "invalid-id"
    | "missing-auth-profile"
    | "missing-workspace"
    | "unsupported-version";
  sessionId: string;
  detail: string;
}
