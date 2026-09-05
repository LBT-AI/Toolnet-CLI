import type { SessionMemoryData } from "./types";
import { ContextCache } from "../../teamwork/contextCache";
import { detectProjectFramework } from "../projectDetector";
import { workspaceRoot } from "../codingAgent";

/**
 * Layer 4 — Phase 4: SessionMemoryStore is a CLASS that owns its own
 * per-session data. There is NO process-wide mutable singleton in
 * production. The exported `sessionMemory` is a thin compatibility
 * accessor that resolves to the *current* explicit session's memory
 * through the ContextRegistry.
 *
 * In production:
 *   - production code calls getSessionMemory(sessionId) to get a
 *     SessionMemoryStore bound to a specific session.
 *   - the legacy `sessionMemory` export resolves to the session
 *     currently bound by setCurrentSessionId() (or the explicitly
 *     provided sessionId at the time of access).
 *
 * Tests that legitimately need a "default session" use
 * setCurrentSessionId() to install it before exercising the legacy
 * API surface. The bare `new SessionMemoryStore()` is still available
 * for tests that want an isolated instance.
 */

class SessionMemoryStore {
  private data: SessionMemoryData;
  private cache: ContextCache | null = null;
  public readonly sessionId: string;

  constructor(sessionId = "default-session") {
    this.sessionId = sessionId;
    this.data = {
      workspaceRoot: workspaceRoot || process.cwd(),
      keyFilesTouched: [],
      modifiedFiles: [],
      userGoals: [],
      discoveredInsights: [],
      environmentInfo: {
        nodeVersion: process.version,
        platform: process.platform,
      },
      lastUpdated: Date.now(),
    };

    try {
      this.cache = new ContextCache();
      this.hydrateFromCache();
    } catch {
      // Non-fatal if sqlite is unavailable
    }

    this.detectWorkspaceContext();
  }

  private detectWorkspaceContext() {
    try {
      const root = this.data.workspaceRoot || process.cwd();
      const detected = detectProjectFramework(root);
      if (detected && detected.framework !== "unknown") {
        this.data.framework = detected.framework;
        this.data.projectOverview = `Detected ${detected.framework.toUpperCase()} project (Triggered by ${detected.configFile}). Verification: ${detected.verifyCommands.join(" && ") || "none"}`;
      }
    } catch {}
  }

  private hydrateFromCache() {
    if (!this.cache) return;
    try {
      const cached = this.cache.get(this.sessionId);
      if (cached && cached.fileMaps) {
        const parsed = JSON.parse(cached.fileMaps);
        if (Array.isArray(parsed.keyFilesTouched)) {
          this.data.keyFilesTouched = Array.from(new Set([...this.data.keyFilesTouched, ...parsed.keyFilesTouched]));
        }
        if (Array.isArray(parsed.modifiedFiles)) {
          this.data.modifiedFiles = Array.from(new Set([...this.data.modifiedFiles, ...parsed.modifiedFiles]));
        }
      }
    } catch {}
  }

  private persistToCache() {
    if (!this.cache) return;
    try {
      this.cache.set(this.sessionId, {
        astHash: this.data.framework || "generic",
        dependencyGraph: JSON.stringify(this.data.discoveredInsights.slice(-10)),
        fileMaps: JSON.stringify({
          keyFilesTouched: this.data.keyFilesTouched.slice(-30),
          modifiedFiles: this.data.modifiedFiles.slice(-30),
          userGoals: this.data.userGoals.slice(-10),
        }),
      });
    } catch {}
  }

  recordFileAccess(filePath: string, action: "read" | "write" | "patch") {
    if (!filePath) return;
    const clean = filePath.trim();
    if (!this.data.keyFilesTouched.includes(clean)) {
      this.data.keyFilesTouched.push(clean);
      if (this.data.keyFilesTouched.length > 50) {
        this.data.keyFilesTouched.shift();
      }
    }
    if ((action === "write" || action === "patch") && !this.data.modifiedFiles.includes(clean)) {
      this.data.modifiedFiles.push(clean);
      if (this.data.modifiedFiles.length > 50) {
        this.data.modifiedFiles.shift();
      }
    }
    this.data.lastUpdated = Date.now();
    this.persistToCache();
  }

  recordUserGoal(goal: string) {
    if (!goal) return;
    const clean = goal.trim().slice(0, 200);
    if (!this.data.userGoals.includes(clean)) {
      this.data.userGoals.push(clean);
      if (this.data.userGoals.length > 10) {
        this.data.userGoals.shift();
      }
    }
    this.data.lastUpdated = Date.now();
    this.persistToCache();
  }

  recordInsight(insight: string) {
    if (!insight) return;
    const clean = insight.trim().slice(0, 300);
    if (!this.data.discoveredInsights.includes(clean)) {
      this.data.discoveredInsights.push(clean);
      if (this.data.discoveredInsights.length > 15) {
        this.data.discoveredInsights.shift();
      }
    }
    this.data.lastUpdated = Date.now();
    this.persistToCache();
  }

  getSnapshot(): SessionMemoryData {
    return { ...this.data };
  }

  generateSystemPromptSnippet(): string {
    const lines: string[] = [];
    lines.push("<session_memory>");
    lines.push(`Workspace: ${this.data.workspaceRoot}`);
    if (this.data.framework) {
      lines.push(`Tech Stack: ${this.data.framework}`);
    }
    if (this.data.projectOverview) {
      lines.push(`Project Details: ${this.data.projectOverview}`);
    }
    if (this.data.modifiedFiles.length > 0) {
      lines.push(`Modified Files in Session: ${this.data.modifiedFiles.slice(-8).join(", ")}`);
    }
    if (this.data.keyFilesTouched.length > 0) {
      lines.push(`Key Files Referenced: ${this.data.keyFilesTouched.slice(-10).join(", ")}`);
    }
    if (this.data.discoveredInsights.length > 0) {
      lines.push(`Key Findings:`);
      for (const ins of this.data.discoveredInsights.slice(-4)) {
        lines.push(`- ${ins}`);
      }
    }
    lines.push("</session_memory>");
    return lines.join("\n");
  }

  reset() {
    this.data.keyFilesTouched = [];
    this.data.modifiedFiles = [];
    this.data.userGoals = [];
    this.data.discoveredInsights = [];
    this.data.lastUpdated = Date.now();
    this.persistToCache();
  }
}

export { SessionMemoryStore };

// ── Registry binding ────────────────────────────────────────────────────────

import { getSessionContext, hasSessionContext, getSessionContext as ensureSessionContext } from "./contextRegistry";

/**
 * Returns the SessionMemoryStore for the given sessionId, binding a new
 * SessionContext (with a fresh memory store) if one does not exist.
 *
 * This is the canonical way to obtain a per-session memory in production.
 */
export function getSessionMemory(sessionId: string): SessionMemoryStore {
  if (!sessionId) {
    throw new Error("getSessionMemory requires an explicit sessionId");
  }
  return getSessionContext(sessionId).memory;
}

/**
 * TEST-ONLY escape hatch: lazily creates a one-off SessionMemoryStore
 * for unit tests that don't want a full ContextRegistry entry. NOT for
 * production use.
 */
export function createEphemeralMemory(sessionId: string): SessionMemoryStore {
  return new SessionMemoryStore(sessionId);
}

// ── Backward-compat singleton ──────────────────────────────────────────────

let _currentSessionId: string | null = null;
let _compatMemo: { sessionId: string; store: SessionMemoryStore } | null = null;

/**
 * Production code MUST call this from the model loop bootstrap (once) and
 * from every session switch. Without an explicit binding, the legacy
 * `sessionMemory` accessor refuses to mutate (returns a no-op view) so
 * silent cross-session contamination is impossible.
 *
 * The current session is also published to a global hook so
 * SessionTrustManager (which lives in a separate module to avoid a
 * circular import) can resolve it without a hard import cycle.
 */
export function setCurrentSessionId(sessionId: string | null): void {
  _currentSessionId = sessionId || null;
  _compatMemo = null;
  (globalThis as any).__toolnetCurrentSessionId = _currentSessionId;
}

export function getCurrentSessionId(): string | null {
  return _currentSessionId;
}

/**
 * Legacy compatibility accessor. Production code should prefer
 * getSessionMemory(sessionId) — but for tests and adapter paths that
 * imported the bare `sessionMemory` singleton, this resolves to the
 * current explicit session's memory and refuses to act if no session is
 * bound (fail-safe default session used only by tests/migration).
 */
export const sessionMemory: SessionMemoryStore = new Proxy({} as SessionMemoryStore, {
  get(_target, prop) {
    const sid = _currentSessionId;
    let store: SessionMemoryStore;
    if (sid && hasSessionContext(sid)) {
      const memo = _compatMemo;
      if (memo && memo.sessionId === sid) {
        store = memo.store;
      } else {
        store = getSessionContext(sid).memory;
        _compatMemo = { sessionId: sid, store };
      }
    } else {
      // Fail-safe: only used by tests that don't bind a session.
      store = _compatMemo?.store ?? (_compatMemo = {
        sessionId: "default-session",
        store: new SessionMemoryStore("default-session"),
      }).store;
    }
    const value = (store as any)[prop];
    return typeof value === "function" ? value.bind(store) : value;
  },
});

/**
 * Used by tests to clear the lazy memo between runs.
 */
export function _resetCompatMemo(): void {
  _compatMemo = null;
  _currentSessionId = null;
}

// Keep the registry import alive for type-only side effects.
void ensureSessionContext;
