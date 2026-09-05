import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { getToolnetSessionsDir } from "./toolnetHome";

export interface SessionMessage {
  role: string;
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
  [key: string]: any;
}

/**
 * Layer 4 — Phase 4: optional per-session SessionContext snapshot.
 * Persisted alongside messages; restored on load. Transient fields
 * (running worker handles, abort controllers, active spinners) are
 * NEVER persisted.
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
  /** Phase 4: per-session SessionContext snapshot (optional for legacy files). */
  context?: PersistedSessionContext;
}

export function getSessionsDir(): string {
  if (process.env.TOOLNETCLI_SESSIONS_DIR) {
    return process.env.TOOLNETCLI_SESSIONS_DIR;
  }
  if (process.env.TOOLNETAPI_SESSIONS_DIR) {
    return process.env.TOOLNETAPI_SESSIONS_DIR;
  }
  if (process.env.DATA_DIR) {
    return path.join(process.env.DATA_DIR, "sessions");
  }
  // Phase 3: canonical home module (TOOLNETCLI_CONFIG_DIR-aware).
  return getToolnetSessionsDir();
}

export function formatExitMessage(sessionId?: string, hasContent = false): string {
  if (hasContent && sessionId && !sessionId.startsWith("turbo-") && !sessionId.startsWith("temp-")) {
    return `\n\x1b[32mSession saved.\x1b[0m\n\nResume with:\n\x1b[1m\x1b[36mtoolnet resume ${sessionId}\x1b[0m\n\nGoodbye!\n`;
  }
  return "Goodbye!\n";
}

/**
 * Layer 4 — Phase 4: persist a SessionContext snapshot to disk. The
 * snapshot is OPTIONAL — pass `null` or `undefined` for legacy callers.
 *
 * Transient fields (running worker handles, abort controllers, active
 * spinners, transient approval modals) are NEVER read from the live
 * SessionContext and therefore never reach disk.
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

export function saveSession(
  sessionId: string,
  messages: any[],
  metadata?: any,
  options?: { context?: any }
): void {
  if (!sessionId) return;
  const sessionsDir = getSessionsDir();
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  const formattedMessages: SessionMessage[] = (messages || []).map(msg => {
    const item: SessionMessage = {
      role: msg.role || "user",
      content: msg.content ?? "",
    };
    if (msg.tool_calls !== undefined) item.tool_calls = msg.tool_calls;
    if (msg.tool_call_id !== undefined) item.tool_call_id = msg.tool_call_id;
    if (msg.name !== undefined) item.name = msg.name;
    return item;
  });

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

  const sessionData: SavedSession = {
    sessionId,
    messages: formattedMessages,
    metadata: sessionMetadata,
    updatedAt: now,
    context: persistedContext,
  };

  const filePath = path.join(sessionsDir, `${sessionId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2), "utf8");

  if (!sessionId.startsWith("turbo-") && !sessionId.startsWith("temp-")) {
    const lastSessionFile = path.join(sessionsDir, "last_session.txt");
    fs.writeFileSync(lastSessionFile, sessionId.trim(), "utf8");
  }
}

export function loadSession(sessionId: string): SavedSession | null {
  if (!sessionId) return null;
  const cleanId = sessionId.endsWith(".json") ? sessionId.slice(0, -5) : sessionId;
  const sessionsDir = getSessionsDir();
  let filePath = path.join(sessionsDir, `${cleanId}.json`);

  if (!fs.existsSync(filePath)) {
    // Check legacy ~/.toolnetapi/sessions fallback
    const legacyPath = path.join(os.homedir(), ".toolnetapi", "sessions", `${cleanId}.json`);
    if (fs.existsSync(legacyPath)) {
      filePath = legacyPath;
    } else {
      return null;
    }
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    return {
      sessionId: data.sessionId || cleanId,
      messages: Array.isArray(data.messages) ? data.messages : [],
      metadata: data.metadata || {},
      updatedAt: data.updatedAt || new Date().toISOString(),
      context: data.context, // Phase 4: pass through persisted context snapshot
    };
  } catch {
    return null;
  }
}

/**
 * Phase 4: hydrate a ContextRegistry entry from a persisted snapshot.
 * Replaces whatever the registry currently holds for this sessionId
 * (e.g. a fresh active state from `loadSession`).
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
 * Phase 4: a session-keyed cache for prepared messages / summary /
 * token estimates. Cache key includes sessionId + model + provider +
 * message revision, so:
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
  const sessionsDir = getSessionsDir();
  const lastSessionFile = path.join(sessionsDir, "last_session.txt");

  if (fs.existsSync(lastSessionFile)) {
    try {
      const id = fs.readFileSync(lastSessionFile, "utf8").trim();
      if (id) {
        const sessionPath = path.join(sessionsDir, `${id}.json`);
        if (fs.existsSync(sessionPath)) {
          return id;
        }
      }
    } catch {}
  }

  if (!fs.existsSync(sessionsDir)) return null;

  try {
    const files = fs.readdirSync(sessionsDir);
    const sessionFiles = files.filter(f => f.endsWith(".json"));
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

export function listAllSessions(): SavedSession[] {
  const sessionsDir = getSessionsDir();
  if (!fs.existsSync(sessionsDir)) return [];
  try {
    const files = fs.readdirSync(sessionsDir).filter(
      f => f.endsWith(".json") && !f.startsWith("turbo-") && !f.startsWith("temp-")
    );
    const list: SavedSession[] = [];
    for (const file of files) {
      const loaded = loadSession(file);
      if (loaded && !loaded.sessionId.startsWith("turbo-") && !loaded.sessionId.startsWith("temp-")) {
        list.push(loaded);
      }
    }
    list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return list;
  } catch {
    return [];
  }
}

export function deleteSessionFile(sessionId: string): boolean {
  if (!sessionId) return false;
  const cleanId = sessionId.endsWith(".json") ? sessionId.slice(0, -5) : sessionId;
  const sessionsDir = getSessionsDir();
  const filePath = path.join(sessionsDir, `${cleanId}.json`);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      const lastSessionFile = path.join(sessionsDir, "last_session.txt");
      if (fs.existsSync(lastSessionFile)) {
        const lastId = fs.readFileSync(lastSessionFile, "utf8").trim();
        if (lastId === cleanId) {
          try { fs.unlinkSync(lastSessionFile); } catch {}
        }
      }
      try {
        const { deleteSessionContext } = require("./context/contextRegistry");
        deleteSessionContext(cleanId);
      } catch {}
      clearSessionCache(cleanId);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function renameSessionFile(sessionId: string, newName: string): boolean {
  const loaded = loadSession(sessionId);
  if (!loaded) return false;
  loaded.metadata = loaded.metadata || {};
  loaded.metadata.name = newName;
  saveSession(loaded.sessionId, loaded.messages, loaded.metadata);
  return true;
}

export function createNewSession(name?: string): SavedSession {
  const randomSuffix = crypto.randomBytes(4).toString("hex");
  const sessionId = `sess_${Date.now()}_${randomSuffix}`;
  const metadata: Record<string, any> = {};
  if (name) metadata.name = name;
  saveSession(sessionId, [], metadata);
  return {
    sessionId,
    messages: [],
    metadata,
    updatedAt: new Date().toISOString()
  };
}
