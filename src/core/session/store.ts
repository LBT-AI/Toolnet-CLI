/**
 * THE SessionStore.
 *
 * One owner for everything durable about a session: the materialized record, the
 * event journal, the checkpoint log, the list index and the lock. Callers
 * (harness, TUI, CLI, legacy persistence facade) go through this object rather
 * than touching session files, so there is exactly one place that knows the
 * write ordering that makes crash recovery deterministic:
 *
 *   append journal events            (durable before anything references them)
 *   write the record atomically      (the reconstruction base)
 *   append the checkpoint line       (references an already-durable sequence)
 *   update the list index            (derived, self-healing if lost)
 *
 * The store never persists a credential, a live object, a socket or a process
 * handle — only stable ids and status. It never replays a session; that is the
 * resume path, which is pure.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, fileExists, quarantineFile, readFileSafe, writeFileAtomic } from "./atomic";
import {
  SessionCorruptError,
  SessionError,
  SessionHasChildrenError,
  SessionNotFoundError,
  SessionStoreIoError,
  SessionUnsupportedVersionError,
  type SessionErrorCode,
} from "./errors";
import { appendCheckpoint, appendEvent, readCheckpoints, readJournal } from "./journal";
import { acquireSessionLock, isLockStale, readSessionLock, releaseSessionLock, type SessionLockHandle } from "./lock";
import {
  lastSessionPointerPath,
  normalizeSessionId,
  resolveSessionsDir,
  sessionIndexPath,
  sessionPathsFor,
  type SessionPaths,
} from "./paths";
import { replaySession, selectCheckpointHead } from "./resume";
import {
  ACTIVE_SESSION_STATUSES,
  SESSION_SCHEMA_VERSION,
  emptyEvidenceSummary,
  isSessionStatus,
  type ExecutionEvidenceSummary,
  type ResumedSession,
  type SessionCheckpoint,
  type SessionDoctorIssue,
  type SessionDoctorReport,
  type SessionEvent,
  type SessionEventType,
  type SessionIndex,
  type SessionIndexEntry,
  type SessionMessage,
  type SessionRecord,
  type SessionStatus,
  type WorkspaceIdentity,
  type WorkspaceMatch,
} from "./types";
import { classifyWorkspace, normalizeWorkspaceIdentity } from "./workspace";

export interface SessionStoreOptions {
  sessionsDir?: string;
  onWarn?: (message: string) => void;
  now?: () => number;
}

export interface CreateSessionOptions {
  id?: string;
  title?: string;
  workspace?: WorkspaceIdentity;
  model?: string;
  provider?: string;
  harness?: string;
  authProfileId?: string;
  metadata?: Record<string, unknown>;
  parentSessionId?: string;
  forkedFromCheckpointId?: string;
}

export interface SaveSessionOptions {
  context?: unknown;
  /** Connector state (evidence/verdict/identity) recorded with the checkpoint. */
  evidence?: ExecutionEvidenceSummary;
  verdict?: string;
  status?: SessionStatus;
  reason?: string;
  model?: string;
  provider?: string;
  harness?: string;
  authProfileId?: string;
}

export interface CheckpointOptions {
  reason: string;
  evidence?: ExecutionEvidenceSummary;
  verdict?: string;
  model?: string;
  provider?: string;
  harness?: string;
  authProfileId?: string;
}

export interface ResumeOptions {
  /** True when a live owner (another process) is known to hold the session. */
  liveOwner?: boolean;
  /** Current workspace to classify against; defaults to process.cwd(). */
  workspace?: WorkspaceIdentity;
  /** Allow resuming a session bound to a different project. */
  allowWorkspaceMismatch?: boolean;
  /** Allow resuming a session whose workspace directory is gone. */
  allowMissingWorkspace?: boolean;
}

const TERMINAL_STATUS_EVENT: Partial<Record<SessionStatus, SessionEventType>> = {
  completed: "session.completed",
  failed: "session.failed",
  cancelled: "session.cancelled",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class SessionStore {
  private readonly explicitDir?: string;
  private readonly warn: (message: string) => void;
  private readonly clock: () => number;
  private lastDirSeen: string | null = null;
  private indexCache: SessionIndex | null = null;
  private sequenceCache = new Map<string, number>();

  constructor(options: SessionStoreOptions = {}) {
    this.explicitDir = options.sessionsDir;
    this.warn = options.onWarn ?? (() => {});
    this.clock = options.now ?? (() => Date.now());
  }

  /**
   * Directory is resolved on every call so an environment override that changes
   * mid-process (sandboxed installs, tests, a redirected HOME) is honored. A
   * change discards the derived caches rather than serving stale entries from
   * the previous directory.
   */
  dir(): string {
    const resolved = this.explicitDir ?? resolveSessionsDir();
    if (this.lastDirSeen !== resolved) {
      this.lastDirSeen = resolved;
      this.indexCache = null;
      this.sequenceCache.clear();
    }
    return resolved;
  }

  resetCache(): void {
    this.lastDirSeen = null;
    this.indexCache = null;
    this.sequenceCache.clear();
  }

  private paths(sessionId: string): SessionPaths {
    return sessionPathsFor(sessionId, this.dir());
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /**
   * Upgrade a legacy (unversioned) record in memory. Migration is deterministic
   * and non-destructive: the original file is left alone until the next save, so
   * a failed upgrade can never lose data.
   */
  private migrate(raw: Record<string, unknown>, sessionId: string): SessionRecord {
    const messages = Array.isArray(raw.messages) ? (raw.messages as SessionMessage[]) : [];
    const metadata = isRecord(raw.metadata) ? (raw.metadata as Record<string, unknown>) : {};
    const recordedWorkspace =
      typeof metadata.workspace === "string" && metadata.workspace.length > 0 ? metadata.workspace : undefined;
    const workspace = this.workspaceForRecord(raw.workspace, recordedWorkspace);
    const status = isSessionStatus(raw.status) ? raw.status : "idle";
    const createdAt =
      typeof raw.createdAt === "string"
        ? raw.createdAt
        : typeof metadata.createdAt === "string"
          ? metadata.createdAt
          : typeof raw.updatedAt === "string"
            ? raw.updatedAt
            : new Date(this.clock()).toISOString();
    return {
      version: SESSION_SCHEMA_VERSION,
      id: typeof raw.id === "string" ? raw.id : typeof raw.sessionId === "string" ? raw.sessionId : sessionId,
      ...(typeof raw.title === "string" ? { title: raw.title } : {}),
      workspace,
      createdAt,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt,
      status,
      ...(typeof raw.parentSessionId === "string" ? { parentSessionId: raw.parentSessionId } : {}),
      ...(typeof raw.forkedFromCheckpointId === "string"
        ? { forkedFromCheckpointId: raw.forkedFromCheckpointId }
        : {}),
      ...(typeof raw.model === "string"
        ? { model: raw.model }
        : typeof metadata.model === "string"
          ? { model: metadata.model }
          : {}),
      ...(typeof raw.provider === "string"
        ? { provider: raw.provider }
        : typeof metadata.provider === "string"
          ? { provider: metadata.provider }
          : {}),
      ...(typeof raw.harness === "string"
        ? { harness: raw.harness }
        : typeof metadata.harness === "string"
          ? { harness: metadata.harness }
          : {}),
      ...(typeof raw.authProfileId === "string" ? { authProfileId: raw.authProfileId } : {}),
      messages,
      metadata,
      ...(typeof raw.checkpointHead === "string" ? { checkpointHead: raw.checkpointHead } : {}),
      ...(raw.context !== undefined ? { context: raw.context } : {}),
    };
  }

  private workspaceForRecord(rawWorkspace: unknown, recordedPath?: string): WorkspaceIdentity {
    if (isRecord(rawWorkspace) && typeof rawWorkspace.path === "string" && typeof rawWorkspace.key === "string") {
      return {
        path: rawWorkspace.path,
        root: typeof rawWorkspace.root === "string" ? rawWorkspace.root : rawWorkspace.path,
        ...(typeof rawWorkspace.gitRoot === "string" ? { gitRoot: rawWorkspace.gitRoot } : {}),
        key: rawWorkspace.key,
      };
    }
    if (recordedPath) {
      // The original directory may be gone; derive a stable key from its name so
      // the session is still classified consistently on a later resume attempt.
      return {
        path: path.resolve(recordedPath),
        root: path.resolve(recordedPath),
        key: `path:${path.basename(path.resolve(recordedPath))}`,
      };
    }
    return normalizeWorkspaceIdentity(process.cwd());
  }

  load(sessionId: string, options: { strict?: boolean } = {}): SessionRecord | null {
    const id = normalizeSessionId(sessionId);
    const recordPath = this.paths(id).record;
    const raw = readFileSafe(recordPath);
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
      if (!isRecord(parsed)) throw new Error("session record is not an object");
    } catch (error) {
      const quarantined = quarantineFile(recordPath, "corrupt");
      const detail = error instanceof Error ? error.message : "unparseable session record";
      this.warn(`session ${id} is corrupt and was quarantined; contents were not logged`);
      if (options.strict) throw new SessionCorruptError(id, detail, quarantined ?? undefined);
      return null;
    }

    const version = parsed.version;
    if (version !== undefined && (typeof version !== "number" || version > SESSION_SCHEMA_VERSION)) {
      if (options.strict) throw new SessionUnsupportedVersionError(id, version, SESSION_SCHEMA_VERSION);
      this.warn(`session ${id} has an unsupported schema version ${String(version)}`);
      return null;
    }

    const record = this.migrate(parsed, id);
    if (record.id !== id) {
      // A record whose content disagrees with its file name is isolated rather
      // than silently trusted under two identities.
      this.warn(`session ${id} record id mismatch (${record.id})`);
      record.id = id;
    }
    return record;
  }

  exists(sessionId: string): boolean {
    try {
      return fileExists(this.paths(normalizeSessionId(sessionId)).record);
    } catch {
      return false;
    }
  }

  /** All persisted ids, newest-first by index/record mtime. Cheap: index-driven. */
  listIds(): string[] {
    return this.loadIndex().entries.map((entry) => entry.id);
  }

  // ── Index ─────────────────────────────────────────────────────────────────

  private readIndexFile(): SessionIndex | null {
    const raw = readFileSafe(sessionIndexPath(this.dir()));
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed) || !isRecord(parsed.sessions)) return null;
      const sessions: Record<string, SessionIndexEntry> = {};
      for (const [id, value] of Object.entries(parsed.sessions)) {
        if (isRecord(value) && typeof value.updatedAt === "string") sessions[id] = value as unknown as SessionIndexEntry;
      }
      return {
        version: typeof parsed.version === "number" ? parsed.version : SESSION_SCHEMA_VERSION,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(this.clock()).toISOString(),
        sessions,
      };
    } catch {
      return null;
    }
  }

  private entryFromRecord(record: SessionRecord): SessionIndexEntry {
    return {
      id: record.id,
      ...(record.title ? { title: record.title } : {}),
      workspacePath: record.workspace.path,
      workspaceKey: record.workspace.key,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      status: record.status,
      ...(record.model ? { model: record.model } : {}),
      ...(record.provider ? { provider: record.provider } : {}),
      ...(record.harness ? { harness: record.harness } : {}),
      messageCount: record.messages.length,
      ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
    };
  }

  private writeIndex(index: SessionIndex): void {
    const indexPath = sessionIndexPath(this.dir());
    ensureDir(path.dirname(indexPath));
    writeFileAtomic(indexPath, JSON.stringify(index, null, 2));
    this.indexCache = index;
  }

  private updateIndex(record: SessionRecord): void {
    const index = this.loadIndexRaw();
    index.sessions[record.id] = this.entryFromRecord(record);
    index.updatedAt = new Date(this.clock()).toISOString();
    this.writeIndex(index);
  }

  private loadIndexRaw(): SessionIndex {
    if (this.indexCache) return { ...this.indexCache, sessions: { ...this.indexCache.sessions } };
    const fromDisk = this.readIndexFile();
    if (fromDisk) {
      this.indexCache = fromDisk;
      return { ...fromDisk, sessions: { ...fromDisk.sessions } };
    }
    return {
      version: SESSION_SCHEMA_VERSION,
      updatedAt: new Date(this.clock()).toISOString(),
      sessions: {},
    };
  }

  /**
   * Index read with self-healing: if the index is missing, unparseable, or no
   * longer matches the transcript files on disk, it is rebuilt from the records
   * rather than trusted. A lost index costs one rebuild, never correctness.
   */
  private loadIndex(): { entries: SessionIndexEntry[]; rebuilt: boolean } {
    const index = this.loadIndexRaw();
    const ids = Object.keys(index.sessions);
    const diskIds = this.transcriptIdsOnDisk();
    const matches =
      ids.length === diskIds.length && ids.every((id) => diskIds.includes(id));
    if (matches && ids.length > 0) {
      return { entries: this.sortEntries(index.sessions), rebuilt: false };
    }
    if (matches && ids.length === 0 && diskIds.length === 0) {
      return { entries: [], rebuilt: false };
    }
    return { entries: this.sortEntries(this.rebuildIndex().sessions), rebuilt: true };
  }

  /**
   * Newest first. When two sessions share a timestamp (created in the same
   * millisecond) the id breaks the tie in descending order: generated ids embed
   * their creation time, so this stays deterministic and prefers the later one.
   */
  private sortEntries(sessions: Record<string, SessionIndexEntry>): SessionIndexEntry[] {
    return Object.values(sessions).sort((a, b) => {
      const diff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      if (diff !== 0) return diff;
      return b.id.localeCompare(a.id);
    });
  }

  private transcriptIdsOnDisk(): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.dir(), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("."))
      .map((entry) => entry.name.slice(0, -5));
  }

  private rebuildIndex(): SessionIndex {
    const sessions: Record<string, SessionIndexEntry> = {};
    for (const id of this.transcriptIdsOnDisk()) {
      const record = this.load(id);
      if (!record) continue;
      sessions[record.id] = this.entryFromRecord(record);
    }
    const index: SessionIndex = {
      version: SESSION_SCHEMA_VERSION,
      updatedAt: new Date(this.clock()).toISOString(),
      sessions,
    };
    try {
      this.writeIndex(index);
    } catch {
      /* a read-only sessions dir still lists, just without persisting the index */
    }
    return index;
  }

  list(): SessionIndexEntry[] {
    return this.loadIndex().entries;
  }

  listForWorkspace(workspace: WorkspaceIdentity = normalizeWorkspaceIdentity(process.cwd())): SessionIndexEntry[] {
    return this.list().filter((entry) => entry.workspaceKey === workspace.key);
  }

  // ── Create ────────────────────────────────────────────────────────────────

  create(options: CreateSessionOptions = {}): SessionRecord {
    const id = options.id ? normalizeSessionId(options.id) : this.generateId();
    if (this.exists(id)) throw new SessionError("SESSION_STORE_IO", `session already exists: ${id}`, { sessionId: id });
    const workspace = options.workspace ?? normalizeWorkspaceIdentity(process.cwd());
    const now = new Date(this.clock()).toISOString();
    const record: SessionRecord = {
      version: SESSION_SCHEMA_VERSION,
      id,
      ...(options.title ? { title: options.title } : {}),
      workspace,
      createdAt: now,
      updatedAt: now,
      status: "idle",
      ...(options.model ? { model: options.model } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.harness ? { harness: options.harness } : {}),
      ...(options.authProfileId ? { authProfileId: options.authProfileId } : {}),
      messages: [],
      metadata: { ...(options.metadata ?? {}) },
      ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
      ...(options.forkedFromCheckpointId ? { forkedFromCheckpointId: options.forkedFromCheckpointId } : {}),
    };
    this.persistRecord(record);
    this.appendSessionEvent(id, "session.created", {
      workspaceKey: workspace.key,
      ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
    });
    this.checkpoint(id, {
      reason: "session-created",
      model: record.model,
      provider: record.provider,
      harness: record.harness,
      authProfileId: record.authProfileId,
    });
    this.updateIndex(record);
    this.touchLastSession(id);
    return record;
  }

  private generateId(): string {
    return `sess_${this.clock()}_${crypto.randomBytes(4).toString("hex")}`;
  }

  private persistRecord(record: SessionRecord): void {
    try {
      // `sessionId` is written alongside the structured `id` for readers built
      // against the earlier flat format — the on-disk contract stays readable.
      writeFileAtomic(this.paths(record.id).record, JSON.stringify({ ...record, sessionId: record.id }, null, 2));
    } catch (error) {
      throw new SessionStoreIoError(record.id, error instanceof Error ? error.message : "write failed", error);
    }
  }

  // ── Journal + checkpoints ─────────────────────────────────────────────────

  lastSequence(sessionId: string): number {
    const id = normalizeSessionId(sessionId);
    const cached = this.sequenceCache.get(id);
    if (cached !== undefined) return cached;
    const read = readJournal(this.paths(id).journal);
    this.sequenceCache.set(id, read.lastSequence);
    return read.lastSequence;
  }

  /** Append one canonical event. Returns the durable event (with its sequence). */
  appendSessionEvent(
    sessionId: string,
    type: SessionEventType,
    data?: Record<string, unknown>,
  ): SessionEvent {
    const id = normalizeSessionId(sessionId);
    const seq = this.lastSequence(id) + 1;
    const event: SessionEvent = { seq, at: this.clock(), type, ...(data ? { data } : {}) };
    try {
      appendEvent(this.paths(id).journal, event);
    } catch (error) {
      throw new SessionStoreIoError(id, error instanceof Error ? error.message : "journal append failed", error);
    }
    this.sequenceCache.set(id, seq);
    return event;
  }

  /**
   * Take a checkpoint: a new reconstruction boundary. The referenced event
   * sequence is already durable, so the head can never point at lost state.
   */
  checkpoint(sessionId: string, options: CheckpointOptions): SessionCheckpoint {
    const id = normalizeSessionId(sessionId);
    const record = this.load(id);
    if (!record) throw new SessionNotFoundError(id);

    const created = this.appendSessionEvent(id, "checkpoint.created", {
      reason: options.reason,
      messageCount: record.messages.length,
    });

    const head: SessionCheckpoint = {
      checkpointId: `cp_${created.seq}_${crypto.randomBytes(3).toString("hex")}`,
      sessionId: id,
      eventSequence: created.seq,
      at: created.at,
      messageCount: record.messages.length,
      workspaceKey: record.workspace.key,
      status: record.status,
      reason: options.reason,
      ...(options.model ?? record.model ? { model: options.model ?? record.model } : {}),
      ...(options.provider ?? record.provider ? { provider: options.provider ?? record.provider } : {}),
      ...(options.harness ?? record.harness ? { harness: options.harness ?? record.harness } : {}),
      ...(options.authProfileId ?? record.authProfileId
        ? { authProfileId: options.authProfileId ?? record.authProfileId }
        : {}),
      ...(options.verdict ? { verdict: options.verdict } : {}),
      ...(options.evidence ? { evidence: options.evidence } : {}),
    };

    try {
      appendCheckpoint(this.paths(id).checkpoints, head);
    } catch (error) {
      throw new SessionStoreIoError(id, error instanceof Error ? error.message : "checkpoint append failed", error);
    }

    record.checkpointHead = head.checkpointId;
    record.updatedAt = new Date(this.clock()).toISOString();
    this.persistRecord(record);
    this.updateIndex(record);
    return head;
  }

  latestCheckpoint(sessionId: string): SessionCheckpoint | null {
    return readCheckpoints(this.paths(normalizeSessionId(sessionId)).checkpoints).latest;
  }

  // ── Save (the durability entry point) ─────────────────────────────────────

  /**
   * Persist the conversation and take a checkpoint. This is the function every
   * existing caller already uses, so durability is inherited rather than
   * requiring each call site to opt in.
   */
  save(
    sessionId: string,
    messages: SessionMessage[],
    metadata?: Record<string, unknown>,
    options: SaveSessionOptions = {},
  ): SessionRecord {
    const id = normalizeSessionId(sessionId);
    const existing = this.load(id);
    const workspace = existing?.workspace ?? normalizeWorkspaceIdentity(process.cwd());
    const now = new Date(this.clock()).toISOString();

    const record: SessionRecord = {
      version: SESSION_SCHEMA_VERSION,
      id,
      ...(existing?.title ? { title: existing.title } : {}),
      workspace,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      status: options.status ?? existing?.status ?? "idle",
      ...(existing?.parentSessionId ? { parentSessionId: existing.parentSessionId } : {}),
      ...(existing?.forkedFromCheckpointId ? { forkedFromCheckpointId: existing.forkedFromCheckpointId } : {}),
      ...(options.model ?? existing?.model ? { model: options.model ?? existing!.model } : {}),
      ...(options.provider ?? existing?.provider ? { provider: options.provider ?? existing!.provider } : {}),
      ...(options.harness ?? existing?.harness ? { harness: options.harness ?? existing!.harness } : {}),
      ...(options.authProfileId ?? existing?.authProfileId
        ? { authProfileId: options.authProfileId ?? existing!.authProfileId }
        : {}),
      messages: (messages ?? []).map((message) => ({ ...message })),
      metadata: { ...(existing?.metadata ?? {}), ...(metadata ?? {}) },
      ...(existing?.checkpointHead ? { checkpointHead: existing.checkpointHead } : {}),
      ...(options.context !== undefined ? { context: options.context } : existing?.context !== undefined ? { context: existing.context } : {}),
    };

    // 1. The journal event that the checkpoint will reference is durable first.
    const created = this.appendSessionEvent(id, "checkpoint.created", {
      reason: options.reason ?? "turn-complete",
      messageCount: record.messages.length,
    });

    const head: SessionCheckpoint = {
      checkpointId: `cp_${created.seq}_${crypto.randomBytes(3).toString("hex")}`,
      sessionId: id,
      eventSequence: created.seq,
      at: created.at,
      messageCount: record.messages.length,
      workspaceKey: workspace.key,
      status: record.status,
      reason: options.reason ?? "turn-complete",
      ...(record.model ? { model: record.model } : {}),
      ...(record.provider ? { provider: record.provider } : {}),
      ...(record.harness ? { harness: record.harness } : {}),
      ...(record.authProfileId ? { authProfileId: record.authProfileId } : {}),
      ...(options.verdict ? { verdict: options.verdict } : {}),
      ...(options.evidence ? { evidence: options.evidence } : {}),
    };

    // 2. The record is written with the NEW head, so the durable record never
    //    claims a head it has already moved past (a resume must see the head the
    //    checkpoint log agrees with).
    record.checkpointHead = head.checkpointId;
    this.persistRecord(record);

    // 3. Only then append the checkpoint line.
    try {
      appendCheckpoint(this.paths(id).checkpoints, head);
    } catch (error) {
      throw new SessionStoreIoError(id, error instanceof Error ? error.message : "checkpoint append failed", error);
    }

    this.updateIndex(record);
    this.touchLastSession(id);
    return record;
  }

  setStatus(
    sessionId: string,
    status: SessionStatus,
    extra: Record<string, unknown> = {},
  ): void {
    const id = normalizeSessionId(sessionId);
    const record = this.load(id);
    if (!record) throw new SessionNotFoundError(id);
    record.status = status;
    record.updatedAt = new Date(this.clock()).toISOString();
    this.persistRecord(record);
    const terminal = TERMINAL_STATUS_EVENT[status];
    this.appendSessionEvent(id, terminal ?? "session.status", { status, ...extra });
    this.updateIndex(record);
  }

  recordIdentity(
    sessionId: string,
    identity: { model?: string; provider?: string; harness?: string; authProfileId?: string },
  ): void {
    const id = normalizeSessionId(sessionId);
    const record = this.load(id);
    if (!record) throw new SessionNotFoundError(id);
    if (identity.model) record.model = identity.model;
    if (identity.provider) record.provider = identity.provider;
    if (identity.harness) record.harness = identity.harness;
    if (identity.authProfileId) record.authProfileId = identity.authProfileId;
    record.updatedAt = new Date(this.clock()).toISOString();
    this.persistRecord(record);
    const type: SessionEventType =
      identity.harness !== undefined
        ? "harness.selection"
        : identity.authProfileId !== undefined
          ? "auth.pin"
          : "model.selection";
    this.appendSessionEvent(id, type, { ...identity });
    this.updateIndex(record);
  }

  rename(sessionId: string, title: string): SessionRecord {
    const id = normalizeSessionId(sessionId);
    const record = this.load(id);
    if (!record) throw new SessionNotFoundError(id);
    record.title = title;
    // `metadata.name` is the long-standing display field front-ends read; the
    // structured `title` is its durable twin. Keep both in step so existing
    // consumers keep working.
    record.metadata = { ...record.metadata, name: title };
    record.updatedAt = new Date(this.clock()).toISOString();
    this.persistRecord(record);
    this.updateIndex(record);
    return record;
  }

  // ── Resume ────────────────────────────────────────────────────────────────

  /**
   * Reconstruct a session for continuation. Replay is state-only; the caller
   * resolves runtime dependencies (providers, credentials, processes) fresh.
   */
  resume(sessionId: string, options: ResumeOptions = {}): ResumedSession {
    const id = normalizeSessionId(sessionId);
    const record = this.load(id);
    if (!record) throw new SessionNotFoundError(id);

    const journal = readJournal(this.paths(id).journal);
    const checkpointRead = readCheckpoints(this.paths(id).checkpoints);
    const selection = selectCheckpointHead(checkpointRead.checkpoints, journal.lastSequence);
    const replayed = replaySession({ record, events: journal.events, checkpointHead: selection.head });

    const workspace = options.workspace ?? normalizeWorkspaceIdentity(process.cwd());
    const workspaceMatch: WorkspaceMatch = classifyWorkspace(record.workspace, workspace);

    const warnings = [...replayed.warnings];
    if (journal.truncated) warnings.push("event journal ended with an incomplete record; it was dropped");
    if (journal.malformedLines > 0) warnings.push(`${journal.malformedLines} unreadable journal line(s) were isolated`);
    if (journal.duplicateSequences > 0) {
      warnings.push(`${journal.duplicateSequences} out-of-order journal record(s) were ignored`);
    }
    if (selection.skipped > 0) {
      warnings.push(`${selection.skipped} checkpoint(s) referenced state the journal does not contain; skipped`);
    }
    if (checkpointRead.truncated) warnings.push("checkpoint log ended with an incomplete record; it was dropped");
    if (workspaceMatch === "mismatch") warnings.push("session belongs to a different project");
    if (workspaceMatch === "missing") warnings.push("session workspace directory no longer exists");

    if (workspaceMatch === "mismatch" && !options.allowWorkspaceMismatch) {
      throw new SessionError(
        "SESSION_WORKSPACE_MISMATCH",
        `session was created in ${record.workspace.path}, not in the current project`,
        { sessionId: id },
      );
    }
    if (workspaceMatch === "missing" && !options.allowMissingWorkspace) {
      throw new SessionError("SESSION_WORKSPACE_MISMATCH", `session workspace is missing: ${record.workspace.path}`, {
        sessionId: id,
      });
    }

    let status = replayed.status;
    // An active status whose process is gone is an interrupted run — reported as
    // interrupted, never as completed, and never with a fabricated outcome.
    const liveOwner = options.liveOwner ?? this.hasLiveOwner(id);
    if (replayed.activeAtEnd && !liveOwner) {
      status = "interrupted";
      warnings.push("session was interrupted by a crash; no tool is replayed automatically");
    }

    const evidence = replayed.evidence ?? emptyEvidenceSummary();

    return {
      id,
      record,
      transcript: replayed.transcript,
      status,
      checkpointHead: selection.head ?? undefined,
      workspaceMatch,
      identity: {
        ...(record.model ? { model: record.model } : {}),
        ...(record.provider ? { provider: record.provider } : {}),
        ...(record.harness ? { harness: record.harness } : {}),
        ...(record.authProfileId ? { authProfileId: record.authProfileId } : {}),
      },
      evidence,
      interruptedTools: replayed.interruptedTools,
      replayedEvents: replayed.replayedEvents,
      warnings,
    };
  }

  /** Mark a session as interrupted after a resume observes it was active. */
  markInterrupted(sessionId: string): void {
    const id = normalizeSessionId(sessionId);
    const record = this.load(id);
    if (!record) return;
    if (!ACTIVE_SESSION_STATUSES.has(record.status)) return;
    this.setStatus(id, "interrupted", { reason: "crash-recovery" });
  }

  // ── Continue ──────────────────────────────────────────────────────────────

  /**
   * Most recent session for this workspace. Scoped by workspace identity, so a
   * session from another repository is never resumed by accident.
   */
  continueForWorkspace(
    workspace: WorkspaceIdentity = normalizeWorkspaceIdentity(process.cwd()),
  ): SessionIndexEntry | null {
    const candidates = this.listForWorkspace(workspace);
    if (candidates.length === 0) return null;
    return candidates[0];
  }

  // ── Fork ──────────────────────────────────────────────────────────────────

  /**
   * Fork from a checkpoint. The source is not mutated beyond a pre-fork
   * checkpoint, and only stable identities are inherited — the credential is
   * resolved fresh on the next run, so a fork can never share a secret.
   */
  fork(sessionId: string, options: { title?: string; workspace?: WorkspaceIdentity } = {}): SessionRecord {
    const id = normalizeSessionId(sessionId);
    const source = this.load(id);
    if (!source) throw new SessionNotFoundError(id);

    const head = this.checkpoint(id, { reason: "pre-fork" });
    const workspace = options.workspace ?? normalizeWorkspaceIdentity(process.cwd());
    const now = new Date(this.clock()).toISOString();
    const forkId = this.generateId();

    const fork: SessionRecord = {
      version: SESSION_SCHEMA_VERSION,
      id: forkId,
      ...(options.title ? { title: options.title } : source.title ? { title: `${source.title} (fork)` } : {}),
      workspace,
      createdAt: now,
      updatedAt: now,
      status: "idle",
      parentSessionId: source.id,
      forkedFromCheckpointId: head.checkpointId,
      ...(source.model ? { model: source.model } : {}),
      ...(source.provider ? { provider: source.provider } : {}),
      ...(source.harness ? { harness: source.harness } : {}),
      ...(source.authProfileId ? { authProfileId: source.authProfileId } : {}),
      messages: source.messages.map((message) => ({ ...message, tool_calls: message.tool_calls?.map((call) => ({ ...call })) })),
      metadata: { ...source.metadata, forkedFrom: source.id },
    };

    this.persistRecord(fork);
    this.appendSessionEvent(forkId, "session.created", {
      workspaceKey: workspace.key,
      parentSessionId: source.id,
      forkedFromCheckpointId: head.checkpointId,
    });
    this.checkpoint(forkId, { reason: "session-created" });
    this.updateIndex(fork);
    this.touchLastSession(forkId);
    return fork;
  }

  childrenOf(sessionId: string): string[] {
    const id = normalizeSessionId(sessionId);
    return this.list()
      .filter((entry) => entry.parentSessionId === id)
      .map((entry) => entry.id);
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  /**
   * Delete is always explicit. A parent with forks is never silently cascaded —
   * the caller must ask for it, so an accidental delete cannot take a family of
   * sessions with it.
   */
  remove(sessionId: string, options: { cascade?: boolean } = {}): { removed: string[] } {
    const id = normalizeSessionId(sessionId);
    const record = this.load(id);
    if (!record) throw new SessionNotFoundError(id);

    const children = this.childrenOf(id);
    if (children.length > 0 && !options.cascade) throw new SessionHasChildrenError(id, children);

    const removed: string[] = [];
    for (const child of children) {
      removed.push(...this.remove(child, { cascade: true }).removed);
    }
    this.removeSingle(id);
    removed.push(id);
    return { removed };
  }

  /**
   * Remove exactly one session's files without considering forks. Callers that
   * must not silently cascade (legacy single-file delete) use this directly.
   */
  removeSingle(sessionId: string): void {
    const id = normalizeSessionId(sessionId);
    const paths = this.paths(id);
    for (const file of [paths.record, paths.journal, paths.checkpoints, paths.lock]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* already gone */
      }
    }
    this.sequenceCache.delete(id);
    const index = this.loadIndexRaw();
    delete index.sessions[id];
    index.updatedAt = new Date(this.clock()).toISOString();
    try {
      this.writeIndex(index);
    } catch {
      /* index self-heals on next read */
    }
    if (this.lastSessionId() === id) {
      try {
        fs.rmSync(lastSessionPointerPath(this.dir()), { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  // ── Locks ─────────────────────────────────────────────────────────────────

  acquire(sessionId: string): SessionLockHandle {
    return acquireSessionLock(this.paths(normalizeSessionId(sessionId)).lock, sessionId);
  }

  release(handle: SessionLockHandle): void {
    releaseSessionLock(handle.path, process.pid);
  }

  lockInfo(sessionId: string) {
    return readSessionLock(this.paths(normalizeSessionId(sessionId)).lock);
  }

  hasLiveOwner(sessionId: string): boolean {
    const info = this.lockInfo(sessionId);
    if (!info) return false;
    return !isLockStale(info);
  }

  // ── Last-session pointer ──────────────────────────────────────────────────

  private touchLastSession(sessionId: string): void {
    if (sessionId.startsWith("turbo-") || sessionId.startsWith("temp-")) return;
    try {
      writeFileAtomic(lastSessionPointerPath(this.dir()), sessionId.trim(), 0o600);
    } catch {
      /* a read-only store simply has no last-session pointer */
    }
  }

  lastSessionId(): string | null {
    const raw = readFileSafe(lastSessionPointerPath(this.dir()));
    if (raw === null) return null;
    const id = raw.trim();
    if (!id) return null;
    try {
      return this.exists(id) ? id : null;
    } catch {
      return null;
    }
  }

  // ── Doctor ────────────────────────────────────────────────────────────────

  /**
   * Read-only diagnostics. Never runs a model, never repairs destructively —
   * it reports, and only rebuilds the derived index, which is safe by design.
   */
  doctor(): SessionDoctorReport {
    const issues: SessionDoctorIssue[] = [];
    const indexPath = sessionIndexPath(this.dir());
    const indexFileExisted = fileExists(indexPath);
    const rawIndex = readFileSafe(indexPath);
    const indexPresent = rawIndex !== null;
    let indexOk = indexPresent;
    if (rawIndex !== null) {
      try {
        const parsed = JSON.parse(rawIndex);
        indexOk = isRecord(parsed) && isRecord(parsed.sessions);
      } catch {
        indexOk = false;
      }
    }

    const diskIds = this.transcriptIdsOnDisk();
    // A fresh store has no index — that is not damage and needs no rebuild noise.
    let indexRepaired = false;
    if (indexPresent && !indexOk) {
      // Unreadable index: quarantine it once and rebuild, rather than reporting
      // every session as desynced.
      quarantineFile(indexPath, "corrupt");
      issues.push({ kind: "index-desync", sessionId: "(index)", detail: "index was unreadable; rebuilt from records" });
      indexRepaired = true;
    } else if (indexOk) {
      const indexed = new Set(Object.keys(this.loadIndexRaw().sessions));
      for (const id of diskIds) {
        if (!indexed.has(id)) {
          indexRepaired = true;
          issues.push({ kind: "index-desync", sessionId: id, detail: "session missing from index; index rebuilt" });
        }
      }
    }
    if (indexRepaired || (!indexPresent && diskIds.length > 0)) {
      try {
        this.rebuildIndex();
        indexRepaired = diskIds.length > 0 || indexFileExisted;
      } catch {
        /* keep the report usable */
      }
    }

    for (const id of diskIds) {
      try {
        const record = this.load(id, { strict: true });
        if (!record) {
          issues.push({ kind: "corrupt-record", sessionId: id, detail: "record could not be read" });
          continue;
        }
        const journal = readJournal(this.paths(id).journal);
        if (journal.truncated || journal.malformedLines > 0 || journal.duplicateSequences > 0) {
          issues.push({
            kind: "corrupt-journal",
            sessionId: id,
            detail: `${journal.malformedLines} malformed, ${journal.duplicateSequences} out-of-order, truncated=${journal.truncated}`,
          });
        }
        const checkpoints = readCheckpoints(this.paths(id).checkpoints);
        const selection = selectCheckpointHead(checkpoints.checkpoints, journal.lastSequence);
        if (checkpoints.checkpoints.length === 0) {
          issues.push({ kind: "missing-checkpoint", sessionId: id, detail: "no checkpoint recorded" });
        } else if (selection.skipped > 0) {
          issues.push({
            kind: "missing-checkpoint",
            sessionId: id,
            detail: `${selection.skipped} checkpoint(s) reference missing journal state`,
          });
        }
        if (!fs.existsSync(record.workspace.path)) {
          issues.push({
            kind: "missing-workspace",
            sessionId: id,
            detail: `workspace directory is gone: ${record.workspace.path}`,
          });
        }
        if (record.authProfileId) {
          const missing = this.missingAuthProfile(record);
          if (missing) issues.push(missing);
        }
      } catch (error) {
        const code: SessionErrorCode = error instanceof SessionError ? error.code : "SESSION_STORE_IO";
        issues.push({
          kind: code === "SESSION_UNSUPPORTED_VERSION" ? "unsupported-version" : "corrupt-record",
          sessionId: id,
          detail: error instanceof Error ? error.message : "unknown error",
        });
      }
    }

    let strayDirectories: fs.Dirent[] = [];
    try {
      strayDirectories = fs.readdirSync(this.dir(), { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      /* ignore */
    }
    for (const entry of strayDirectories) {
      issues.push({ kind: "orphan-directory", sessionId: entry.name, detail: "unexpected directory in sessions root" });
    }

    for (const id of diskIds) {
      const info = this.lockInfo(id);
      if (info && isLockStale(info)) {
        issues.push({ kind: "stale-lock", sessionId: id, detail: `lock held by pid ${info.pid} is stale` });
      }
    }

    return {
      sessionsDir: this.dir(),
      indexPresent,
      indexOk: indexPresent ? indexOk : true,
      indexRepaired,
      totalSessions: diskIds.length,
      issues,
    };
  }

  /**
   * Wired through a lazy probe so the session layer does not depend on the auth
   * module at import time; a missing registry simply reports nothing.
   */
  private missingAuthProfile(record: SessionRecord): SessionDoctorIssue | null {
    if (!record.authProfileId) return null;
    const provider = record.provider;
    if (!provider) return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const auth = require("../auth/registry") as { authProfileRegistry?: { get(id: string): unknown } };
      const registry = auth?.authProfileRegistry;
      if (!registry) return null;
      if (registry.get(record.authProfileId)) return null;
      return {
        kind: "missing-auth-profile",
        sessionId: record.id,
        detail: `pinned auth profile '${record.authProfileId}' no longer exists`,
      };
    } catch {
      return null;
    }
  }
}

/** Process-wide canonical session store. */
export const sessionStore = new SessionStore();
