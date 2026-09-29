/**
 * Durable session layer.
 *
 * Public surface: the canonical `SessionStore` (and its process-wide singleton),
 * the resume reconstruction helpers, the workspace identity classifier, and the
 * structured errors. Everything else is an implementation detail of the store.
 */

export * from "./types";
export * from "./errors";
export {
  resolveSessionsDir,
  sessionPathsFor,
  sessionIndexPath,
  lastSessionPointerPath,
  isValidSessionId,
  assertValidSessionId,
  normalizeSessionId,
} from "./paths";
export { SessionStore, sessionStore, type SessionStoreOptions, type SaveSessionOptions } from "./store";
export { replaySession, selectCheckpointHead, type ReplayResult } from "./resume";
// Deterministic session lifecycle (one foreground run, atomic completion
// boundary, FIFO steer promotion, idle gate).
export {
  canSettleIdle,
  canonicalRunError,
  idleBlockers,
  SessionRunDriver,
  type ForegroundRun,
  type IdleGateInputs,
  type RunKind,
  type RunOutcome,
  type SessionPhase,
  type SessionRunDriverOptions,
  type SettledRun,
  type SubmitResult,
} from "./lifecycle";
export {
  normalizeWorkspaceIdentity,
  classifyWorkspace,
  workspaceKeyFor,
  workspaceLabel,
} from "./workspace";
export { readJournal, readCheckpoints, type JournalReadResult, type CheckpointReadResult } from "./journal";
export { readSessionLock, isLockStale, type SessionLockInfo, type SessionLockHandle } from "./lock";
