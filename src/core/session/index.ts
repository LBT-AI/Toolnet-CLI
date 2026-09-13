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
export {
  normalizeWorkspaceIdentity,
  classifyWorkspace,
  workspaceKeyFor,
  workspaceLabel,
} from "./workspace";
export { readJournal, readCheckpoints, type JournalReadResult, type CheckpointReadResult } from "./journal";
export { readSessionLock, isLockStale, type SessionLockInfo, type SessionLockHandle } from "./lock";
