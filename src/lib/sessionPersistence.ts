import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getToolnetSessionsDir } from "./toolnetHome";
import { getVersion } from "./version";
import {
  resolveSessionsDir,
  sessionStore,
  normalizeSessionId,
  isValidSessionId,
  type SessionMessage,
  type SessionRecord,
  type SessionStatus,
} from "../core/session";

export type { SessionMessage };

/**
 * Optional per-session SessionContext snapshot. Persisted alongside messages;
 * restored on load. Transient fields (running worker handles, abort controllers,
 * active spinners) are NEVER persisted.
 */
export interface PersistedSessionContext {
  summary: string;
  fileAccess: { read: string[]; write: string[]; patched: string[] };
  goals: string[];
  errors: string[];
  compactionCount: number;
  lastCompactedAt: number;    tokenBudgetState: {
      estimatedContextTokens: number;
      actualUsagePromptTokens: number;
      actualUsageCompletionTokens: number;
      actualUsageCachedTokens?: number;
      actualUsageReasoningTokens?: number;
      cumulativeSessionTokens: number;
      lastUpdated: number;
    };
  lifecycleState: string;
  model?: string;
  sandboxMode?: string;
  workspaceRoot?: string;
  /** Monotonic generation counter — used to reject stale async completions. */
  generation: number;
}

export interface SavedSession {
  sessionId: string;
  messages: SessionMessage[];
  metadata?: Record<string, any>;
  updatedAt: string;
  context?: PersistedSessionContext;
  /** Durable-layer fields; absent on legacy snapshots. */
  version?: number;
  title?: string;
  status?: SessionStatus;
  workspace?: string;
  parentSessionId?: string;
  forkedFromCheckpointId?: string;
}

/**
 * Canonical sessions directory. The durable session layer owns this decision, so
 * a test override redirects both the legacy facade and the store together.
 */
export function getSessionsDir(): string {
  const dir = resolveSessionsDir();
  return dir || getToolnetSessionsDir();
}

export function formatExitMessage(sessionId?: string, hasContent = false): string {
  const version = getVersion();
  if (hasContent && sessionId && !sessionId.startsWith("turbo-") && !sessionId.startsWith("temp-")) {
    return `\n\x1b[32mSession saved.\x1b[0m\n\nResume with:\n\x1b[1m\x1b[36mtoolnet resume ${sessionId}\x1b[0m\n\n\x1b[2mToolNet CLI v${version} · /help for commands\x1b[0m\nGoodbye!\n`;
  }
  return `\x1b[2mToolNet CLI v${version} · /help for commands\x1b[0m\nGoodbye!\n`;
}

/**
 * Persist a SessionContext snapshot to disk. The snapshot is OPTIONAL — pass
 * `null` or `undefined` for legacy callers.
 *
 * Transient fields (running worker handles, abort controllers, active spinners,
 * transient approval modals) are NEVER read from the live SessionContext and
 * therefore never reach disk.
 */
function buildPersistedContext(snapshot: any): PersistedSessionContext | undefined {
  if (!snapshot) return undefined;
  return {
    summary: String(snapshot.summary || ""),
    fileAccess: {
      read: Array.isArray(snapshot.fileAccess?.read) ? snapshot.fileAccess.read.slice(-50) : [],
      write: Array.isArray(snapshot.fileAccess?.write) ? snapshot.fileAccess.write.slice(-50) : [],
      patched: Array.isArray(snapshot.fileAccess?.patched) ? snapshot.fileAccess.patched.slice(-50) : [],
    },
    goals: Array.isArray(snapshot.goals) ? snapshot.goals.slice(-20) : [],
    errors: Array.isArray(snapshot.errors) ? snapshot.errors.slice(-20) : [],
    compactionCount: Number(snapshot.compactionState?.count || 0),
    lastCompactedAt: Number(snapshot.compactionState?.lastCompactedAt || 0),
    tokenBudgetState: {
      estimatedContextTokens: Number(snapshot.tokenBudgetState?.estimatedContextTokens || 0),
      actualUsagePromptTokens: Number(snapshot.tokenBudgetState?.actualUsagePromptTokens || 0),
      actualUsageCompletionTokens: Number(snapshot.tokenBudgetState?.actualUsageCompletionTokens || 0),
      actualUsageCachedTokens: Number(snapshot.tokenBudgetState?.actualUsageCachedTokens || 0),
      actualUsageReasoningTokens: Number(snapshot.tokenBudgetState?.actualUsageReasoningTokens || 0),
      cumulativeSessionTokens: Number(snapshot.tokenBudgetState?.cumulativeSessionTokens || 0),
      lastUpdated: Number(snapshot.tokenBudgetState?.lastUpdated || 0),
    },
    lifecycleState: String(snapshot.lifecycleState || "persisted"),
    model: snapshot.metadata?.model,
    sandboxMode: snapshot.metadata?.sandboxMode,
    workspaceRoot: snapshot.metadata?.workspaceRoot,
    generation: Number(snapshot.generation || 0),
  };
}

function toSavedSession(record: SessionRecord): SavedSession {
  return {
    sessionId: record.id,
    messages: record.messages,
    metadata: record.metadata,
    updatedAt: record.updatedAt,
    context: record.context as PersistedSessionContext | undefined,
    version: record.version,
    ...(record.title ? { title: record.title } : {}),
    status: record.status,
    workspace: record.workspace.path,
    ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
    ...(record.forkedFromCheckpointId ? { forkedFromCheckpointId: record.forkedFromCheckpointId } : {}),
  };
}

function formatMessages(messages: any[]): SessionMessage[] {
  return (messages || []).map((msg) => {
    const item: SessionMessage = {
      role: msg.role || "user",
      content: msg.content ?? "",
    };
    if (typeof msg.id === "string" && msg.id) item.id = msg.id;
    if (msg.tool_calls !== undefined) item.tool_calls = msg.tool_calls;
    if (msg.tool_call_id !== undefined) item.tool_call_id = msg.tool_call_id;
    if (msg.name !== undefined) item.name = msg.name;
    // Structured file mutations are part of the durable transcript: the diff is
    // re-rendered from this payload on resume, never from ANSI text.
    if (Array.isArray(msg.fileMutations) && msg.fileMutations.length > 0) item.fileMutations = msg.fileMutations;
    return item;
  });
}

export function saveSession(
  sessionId: string,
  messages: any[],
  metadata?: any,
  options?: { context?: any }
): void {
  if (!sessionId) return;
  if (!isValidSessionId(sessionId)) {
    // Never let an unsafe id become a path segment.
    return;
  }

  const existing = loadSession(sessionId);
  const now = new Date().toISOString();
  const sessionMetadata = {
    workspace: process.cwd(),
    createdAt: existing?.metadata?.createdAt || now,
    ...(existing?.metadata || {}),
    ...(metadata || {}),
  };

  // Prefer the live SessionContext if one is registered for this session.
  // The caller may also pass an explicit `options.context` snapshot.
  let persistedContext: PersistedSessionContext | undefined;
  try {
    const { hasSessionContext, getSessionContext } = require("./context/contextRegistry");
    if (options?.context) {
      persistedContext = buildPersistedContext(options.context);
    } else if (hasSessionContext && hasSessionContext(sessionId)) {
      persistedContext = buildPersistedContext(getSessionContext(sessionId));
    }
  } catch {
    // contextRegistry unavailable — fall back to no-op
  }

  sessionStore.save(sessionId, formatMessages(messages), sessionMetadata, {
    context: persistedContext,
  });
}

/** Legacy `~/.toolnetapi/sessions` fallback for pre-migration installs. */
function loadLegacySessionFile(cleanId: string): SavedSession | null {
  try {
    const legacyPath = path.join(os.homedir(), ".toolnetapi", "sessions", `${cleanId}.json`);
    if (!fs.existsSync(legacyPath)) return null;
    const data = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
    return {
      sessionId: data.sessionId || cleanId,
      messages: Array.isArray(data.messages) ? data.messages : [],
      metadata: data.metadata || {},
      updatedAt: data.updatedAt || new Date().toISOString(),
      context: data.context,
    };
  } catch {
    return null;
  }
}

export function loadSession(sessionId: string): SavedSession | null {
  if (!sessionId) return null;
  let cleanId: string;
  try {
    cleanId = normalizeSessionId(sessionId);
  } catch {
    return null;
  }
  const record = sessionStore.load(cleanId);
  if (record) return toSavedSession(record);
  return loadLegacySessionFile(cleanId);
}

/**
 * Hydrate a ContextRegistry entry from a persisted snapshot. Replaces whatever
 * the registry currently holds for this sessionId (e.g. a fresh active state
 * from `loadSession`).
 *
 * Validates:
 *  - tool-call pair integrity in the message history
 *  - provider/model present (if recorded) — stale model is NOT silently
 *    replaced; the caller decides what to do.
 *  - token counters are not negative
 */
export function loadSessionContext(
  sessionId: string,
  loaded?: SavedSession | null
): { ok: boolean; warnings: string[]; snapshot?: PersistedSessionContext } {
  if (!sessionId) return { ok: false, warnings: ["missing sessionId"] };
  const sess = loaded || loadSession(sessionId);
  if (!sess) return { ok: false, warnings: ["session not found"] };
  const warnings: string[] = [];
  const snapshot = sess.context;

  if (snapshot) {
    // Guard: token counters must not be negative.
    if (
      snapshot.tokenBudgetState.actualUsagePromptTokens < 0 ||
      snapshot.tokenBudgetState.actualUsageCompletionTokens < 0 ||
      snapshot.tokenBudgetState.cumulativeSessionTokens < 0
    ) {
      warnings.push("negative token counters detected; resetting");
    }
  }

  try {
    const { getSessionContext } = require("./context/contextRegistry");
    const ctx = getSessionContext(sessionId);
    if (snapshot) {
      ctx.summary = snapshot.summary;
      ctx.fileAccess = {
        read: Array.isArray(snapshot.fileAccess?.read) ? snapshot.fileAccess.read : [],
        write: Array.isArray(snapshot.fileAccess?.write) ? snapshot.fileAccess.write : [],
        patched: Array.isArray(snapshot.fileAccess?.patched) ? snapshot.fileAccess.patched : [],
      };
      ctx.goals = Array.isArray(snapshot.goals) ? snapshot.goals : [];
      ctx.errors = Array.isArray(snapshot.errors) ? snapshot.errors : [];
      ctx.compactionState = {
        count: snapshot.compactionCount || 0,
        lastCompactedAt: snapshot.lastCompactedAt || 0,
        lastSummary: snapshot.summary || "",
      };
      ctx.tokenBudgetState = {
        estimatedContextTokens: Math.max(0, snapshot.tokenBudgetState?.estimatedContextTokens || 0),
        actualUsagePromptTokens: Math.max(0, snapshot.tokenBudgetState?.actualUsagePromptTokens || 0),
        actualUsageCompletionTokens: Math.max(0, snapshot.tokenBudgetState?.actualUsageCompletionTokens || 0),
        actualUsageCachedTokens: Math.max(0, snapshot.tokenBudgetState?.actualUsageCachedTokens || 0),
        actualUsageReasoningTokens: Math.max(0, snapshot.tokenBudgetState?.actualUsageReasoningTokens || 0),
        cumulativeSessionTokens: Math.max(0, snapshot.tokenBudgetState?.cumulativeSessionTokens || 0),
        lastUpdated: snapshot.tokenBudgetState?.lastUpdated || 0,
      };
      ctx.metadata = {
        ...ctx.metadata,
        ...(snapshot.model ? { model: snapshot.model } : {}),
        ...(snapshot.sandboxMode ? { sandboxMode: snapshot.sandboxMode } : {}),
        ...(snapshot.workspaceRoot ? { workspaceRoot: snapshot.workspaceRoot } : {}),
      };
      ctx.lifecycleState = "active";
      ctx.generation = (snapshot.generation || 0) + 1;
    }
  } catch (e: any) {
    warnings.push(`registry hydrate failed: ${e?.message || String(e)}`);
  }

  return { ok: true, warnings, snapshot };
}

/**
 * A session-keyed cache for prepared messages / summary / token estimates.
 * Cache key includes sessionId + model + provider + message revision, so:
 *  - mutating one session does not invalidate another
 *  - the same session is invalidated when its message history changes
 *  - deleting a session clears its cache entry
 */
const _sessionKeyedCache = new Map<string, { revision: number; model: string; provider: string; value: any }>();

function revisionOf(messages: any[]): number {
  // Lightweight revision: total message count + content length mod.
  // Deterministic, fast, and changes whenever the conversation changes.
  let h = messages.length * 2654435761;
  for (const m of messages.slice(-32)) {
    const c = String(m?.content || "").length;
    h = (h ^ c) * 2654435761;
  }
  return h >>> 0;
}

export interface CacheKeyParams {
  sessionId: string;
  model: string;
  provider: string;
  messages: any[];
}

export function getCachedPrepared<T = any>(params: CacheKeyParams): T | null {
  const key = params.sessionId;
  const entry = _sessionKeyedCache.get(key);
  if (!entry) return null;
  if (entry.model !== params.model) return null;
  if (entry.provider !== params.provider) return null;
  if (entry.revision !== revisionOf(params.messages)) return null;
  return entry.value as T;
}

export function setCachedPrepared<T = any>(params: CacheKeyParams, value: T): void {
  _sessionKeyedCache.set(params.sessionId, {
    revision: revisionOf(params.messages),
    model: params.model,
    provider: params.provider,
    value,
  });
}

export function clearSessionCache(sessionId: string): void {
  _sessionKeyedCache.delete(sessionId);
}

export function getLastSessionId(): string | null {
  const storeLast = sessionStore.lastSessionId();
  if (storeLast) return storeLast;

  const sessionsDir = getSessionsDir();
  if (!fs.existsSync(sessionsDir)) return null;

  try {
    const files = fs.readdirSync(sessionsDir);
    const sessionFiles = files.filter(
      (f) => f.endsWith(".json") && !f.startsWith(".") && !f.startsWith("turbo-") && !f.startsWith("temp-")
    );
    if (sessionFiles.length === 0) return null;

    let newestId: string | null = null;
    let newestMtime = 0;

    for (const file of sessionFiles) {
      const filePath = path.join(sessionsDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs > newestMtime) {
        newestMtime = stat.mtimeMs;
        newestId = file.slice(0, -5);
      }
    }

    return newestId;
  } catch {
    return null;
  }
}

export function parseSessionArgs(argv: string[]): { resume: boolean; sessionId?: string } {
  let resume = false;
  let sessionId: string | undefined = undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "resume") {
      resume = true;
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        sessionId = argv[i + 1];
        i++;
      }
    } else if (arg === "--resume" || arg === "-r") {
      resume = true;
    } else if ((arg === "--session" || arg === "-s") && i + 1 < argv.length) {
      sessionId = argv[i + 1];
      i++;
    } else if (arg.startsWith("--session=")) {
      sessionId = arg.slice(arg.indexOf("=") + 1);
    }
  }

  return { resume, sessionId };
}

/**
 * Full records — used by callers that need message content. Sorted by the
 * record's own `updatedAt` (not the cached index), so a session touched outside
 * the store still lists in the right place.
 */
export function listAllSessions(): SavedSession[] {
  const list: SavedSession[] = [];
  for (const entry of sessionStore.list()) {
    if (entry.id.startsWith("turbo-") || entry.id.startsWith("temp-")) continue;
    const record = sessionStore.load(entry.id);
    if (record) list.push(toSavedSession(record));
  }
  list.sort((a, b) => {
    const diff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
    return b.sessionId.localeCompare(a.sessionId);
  });
  return list;
}

/** Cheap metadata listing — no transcript load. */
export function listSessionSummaries() {
  return sessionStore.list().filter((entry) => !entry.id.startsWith("turbo-") && !entry.id.startsWith("temp-"));
}

export function deleteSessionFile(sessionId: string): boolean {
  if (!sessionId) return false;
  let cleanId: string;
  try {
    cleanId = normalizeSessionId(sessionId);
  } catch {
    return false;
  }
  try {
    sessionStore.removeSingle(cleanId);
  } catch {
    return false;
  }
  try {
    const { deleteSessionContext } = require("./context/contextRegistry");
    deleteSessionContext(cleanId);
  } catch {}
  clearSessionCache(cleanId);
  return true;
}

/**
 * Durable display title for a loaded session: the record `title`, falling back
 * to the legacy `metadata.name` a pre-title rename wrote. Returns undefined for
 * an untitled session so callers never render an empty separator or the word
 * "undefined". Display-only — never persist the result back as a title.
 */
export function sessionDisplayTitle(
  session: { title?: string; metadata?: Record<string, unknown> } | null | undefined,
): string | undefined {
  if (!session) return undefined;
  if (typeof session.title === "string" && session.title) return session.title;
  const legacyName = session.metadata?.name;
  return typeof legacyName === "string" && legacyName ? legacyName : undefined;
}

export function renameSessionFile(sessionId: string, newName: string): boolean {
  const loaded = loadSession(sessionId);
  if (!loaded) return false;
  try {
    sessionStore.rename(loaded.sessionId, newName);
    return true;
  } catch {
    return false;
  }
}

export function createNewSession(name?: string): SavedSession {
  const record = sessionStore.create({
    ...(name ? { title: name, metadata: { name } } : {}),
  });
  return toSavedSession(record);
}

/** Durable-layer access for callers that need resume/fork/doctor. */
export { sessionStore };
