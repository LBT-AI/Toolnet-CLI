/**
 * Layer 4 — Phase 4: ContextRegistry + SessionContext primitives
 *
 * Every conversation owns a SessionContext keyed by sessionId. The registry
 * lives at module scope (so the live process can find it) but the entries
 * it stores are strictly per-session. No global mutable session data is
 * read or written through the legacy "default-session" path in production;
 * that path is reserved for tests and migration adapters.
 *
 *   SessionContext {
 *     sessionId,
 *     memory,                  // SessionMemoryStore (scoped)
 *     compactionState,         // { count, lastCompactedAt, lastSummary }
 *     fileAccess,              // { read: [...], write: [...], patched: [...] }
 *     goals,                   // user-supplied goals
 *     errors,                  // unresolved errors
 *     summary,                 // last compaction summary text
 *     tokenBudgetState,        // { estimatedContextTokens, actualUsagePromptTokens,
 *                              //   actualUsageCompletionTokens, cumulativeSessionTokens }
 *     metadata                 // { name, model, sandboxMode, ... }
 *     lifecycleState           // 'active' | 'persisted' | 'closed' | 'deleted'
 *   }
 */

import type { SessionMemoryData } from "./types";
import { SessionMemoryStore } from "./sessionMemory";

export type SessionLifecycleState = "active" | "persisted" | "closed" | "deleted";

export interface CompactionState {
  count: number;
  lastCompactedAt: number;
  lastSummary: string;
}

export interface FileAccessState {
  read: string[];
  write: string[];
  patched: string[];
}

export interface TokenBudgetState {
  estimatedContextTokens: number;
  actualUsagePromptTokens: number;
  actualUsageCompletionTokens: number;
  actualUsageCachedTokens: number;
  actualUsageReasoningTokens: number;
  cumulativeSessionTokens: number;
  lastUpdated: number;
}

export interface SessionContextMetadata {
  name?: string;
  model?: string;
  provider?: string;
  sandboxMode?: string;
  workspaceRoot?: string;
  parentSessionId?: string;
  childKind?: "stable" | "subagent" | "turbo" | "ephemeral";
  createdAt: number;
  lastTouchedAt: number;
}

export interface SessionContext {
  sessionId: string;
  memory: SessionMemoryStore;
  compactionState: CompactionState;
  fileAccess: FileAccessState;
  goals: string[];
  errors: string[];
  summary: string;
  tokenBudgetState: TokenBudgetState;
  metadata: SessionContextMetadata;
  lifecycleState: SessionLifecycleState;
  /** Generation counter, bumped on every mutation. Used by late-completion
   * guards to detect stale TUI renders after session switches. */
  generation: number;
}

function emptyFileAccess(): FileAccessState {
  return { read: [], write: [], patched: [] };
}

function emptyCompaction(): CompactionState {
  return { count: 0, lastCompactedAt: 0, lastSummary: "" };
}

function emptyTokens(): TokenBudgetState {
  return {
    estimatedContextTokens: 0,
    actualUsagePromptTokens: 0,
    actualUsageCompletionTokens: 0,
    actualUsageCachedTokens: 0,
    actualUsageReasoningTokens: 0,
    cumulativeSessionTokens: 0,
    lastUpdated: 0,
  };
}

function nowMs(): number {
  return Date.now();
}

class ContextRegistry {
  private readonly entries = new Map<string, SessionContext>();
  /** Bumped on every structural change to the registry. */
  private version = 0;

  getVersion(): number {
    return this.version;
  }

  /**
   * Returns the SessionContext for sessionId, creating an empty active
   * context if it does not exist. The caller MUST pass an explicit sessionId
   * in production code; the fallback "" string is reserved for tests that
   * intentionally want a throwaway context.
   */
  getOrCreate(sessionId: string, opts?: { metadata?: Partial<SessionContextMetadata>; bindMemory?: boolean }): SessionContext {
    if (!sessionId) {
      throw new Error("ContextRegistry.getOrCreate requires an explicit sessionId");
    }
    const existing = this.entries.get(sessionId);
    if (existing) {
      existing.metadata.lastTouchedAt = nowMs();
      if (existing.lifecycleState === "closed" || existing.lifecycleState === "deleted") {
        existing.lifecycleState = "active";
      }
      return existing;
    }
    const ctx: SessionContext = {
      sessionId,
      memory: opts?.bindMemory === false ? (null as unknown as SessionMemoryStore) : new SessionMemoryStore(sessionId),
      compactionState: emptyCompaction(),
      fileAccess: emptyFileAccess(),
      goals: [],
      errors: [],
      summary: "",
      tokenBudgetState: emptyTokens(),
      metadata: {
        createdAt: nowMs(),
        lastTouchedAt: nowMs(),
        ...(opts?.metadata || {}),
      },
      lifecycleState: "active",
      generation: 1,
    };
    this.entries.set(sessionId, ctx);
    this.version++;
    return ctx;
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  get(sessionId: string): SessionContext | undefined {
    return this.entries.get(sessionId);
  }

  list(): SessionContext[] {
    return Array.from(this.entries.values());
  }

  reset(sessionId: string): void {
    const ctx = this.entries.get(sessionId);
    if (!ctx) return;
    ctx.memory.reset();
    ctx.compactionState = emptyCompaction();
    ctx.fileAccess = emptyFileAccess();
    ctx.goals = [];
    ctx.errors = [];
    ctx.summary = "";
    ctx.tokenBudgetState = emptyTokens();
    ctx.metadata.lastTouchedAt = nowMs();
    ctx.generation++;
    ctx.lifecycleState = "active";
    this.version++;
  }

  /**
   * Mark a session as persisted (snapshot to disk via saveSession). Does NOT
   * drop the in-memory context; the live loop may still need it.
   */
  markPersisted(sessionId: string): void {
    const ctx = this.entries.get(sessionId);
    if (!ctx) return;
    ctx.lifecycleState = "persisted";
    ctx.metadata.lastTouchedAt = nowMs();
    this.version++;
  }

  markClosed(sessionId: string): void {
    const ctx = this.entries.get(sessionId);
    if (!ctx) return;
    ctx.lifecycleState = "closed";
    ctx.metadata.lastTouchedAt = nowMs();
    this.version++;
  }

  delete(sessionId: string): boolean {
    const ctx = this.entries.get(sessionId);
    if (!ctx) return false;
    if (ctx.lifecycleState === "persisted") {
      // Caller must explicitly purge the persisted file first.
      return false;
    }
    this.entries.delete(sessionId);
    this.version++;
    return true;
  }

  /** Bump generation for late-async completion detection. */
  bumpGeneration(sessionId: string): number {
    const ctx = this.entries.get(sessionId);
    if (!ctx) return 0;
    ctx.generation++;
    ctx.metadata.lastTouchedAt = nowMs();
    return ctx.generation;
  }
}

const REGISTRY = new ContextRegistry();

export const contextRegistry = REGISTRY;
export { REGISTRY };

/** Canonical accessor used by production callers. */
export function getSessionContext(sessionId: string): SessionContext {
  return REGISTRY.getOrCreate(sessionId);
}

export function hasSessionContext(sessionId: string): boolean {
  return REGISTRY.has(sessionId);
}

export function resetSessionContext(sessionId: string): void {
  REGISTRY.reset(sessionId);
}

export function deleteSessionContext(sessionId: string): boolean {
  return REGISTRY.delete(sessionId);
}

export function listSessionContexts(): SessionContext[] {
  return REGISTRY.list();
}

/** Test/utility: create a fresh context with no bound memory (used by subagent clones). */
export function createChildSessionContext(
  sessionId: string,
  parent: SessionContext,
  opts: { kind: "subagent" | "turbo" | "ephemeral" } = { kind: "subagent" }
): SessionContext {
  return REGISTRY.getOrCreate(sessionId, {
    metadata: {
      parentSessionId: parent.sessionId,
      childKind: opts.kind,
      workspaceRoot: parent.metadata.workspaceRoot,
      model: parent.metadata.model,
      sandboxMode: parent.metadata.sandboxMode,
    },
    bindMemory: true,
  });
}

/** Used by the registry to count entries (test introspection). */
export function registrySize(): number {
  return REGISTRY.list().length;
}

/** Used by the registry to read the current version (cache invalidation). */
export function registryVersion(): number {
  return REGISTRY.getVersion();
}

/** Stable child session id helper. */
export function childSessionId(parentSessionId: string, taskId: string): string {
  const safeTask = String(taskId).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
  return `${parentSessionId || "session"}:sub:${safeTask}`;
}

/** Used by tests and lazy callers — snapshot the current session's memory view. */
export function snapshotSessionMemory(sessionId: string): SessionMemoryData | null {
  const ctx = REGISTRY.get(sessionId);
  if (!ctx) return null;
  return ctx.memory.getSnapshot();
}
