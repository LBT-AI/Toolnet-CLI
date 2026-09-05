/**
 * Layer 4 — Phase 5: SessionTrust is a MAP of per-session trust state.
 *
 * Strict per-session isolation contract:
 *  - Every recordDecision / isTrustedForSession / isDeniedForSession call
 *    MUST receive an explicit sessionId. The legacy singleton (`sessionTrust`)
 *    is preserved ONLY for backward compatibility with tests and migration
 *    adapters — it routes to the current explicit session via the global
 *    hook published by setCurrentSessionId().
 *  - Production code MUST use:
 *      recordDecision(sessionId, toolName, targetKey, duration)
 *      isTrustedForSession(sessionId, toolName, targetKey, mode)
 *      isDeniedForSession(sessionId, toolName, targetKey)
 *  - The bare `sessionTrust` singleton is annotated @deprecated.
 *
 * Each session has its own trustedActions and deniedActions set. A
 * trust decision in session A NEVER applies to session B.
 *
 * MCP server trust (a global decision about a server config) is
 * intentionally NOT scoped to a session — it lives in mcpTrustManager
 * and is global. The two are not interchangeable.
 */

import type { TrustDuration, SandboxMode } from "./types";
import { canonicalizeJson } from "./auditLogger";

interface SessionTrustState {
  trustedActions: Set<string>;
  deniedActions: Set<string>;
}

class SessionScopedTrustMap {
  private states = new Map<string, SessionTrustState>();

  getOrCreate(sessionId: string): SessionTrustState {
    if (!sessionId) {
      // Fail-safe: only used by internal test paths with an explicit empty
      // bucket. Production callers MUST pass an explicit sessionId; the
      // SecurityEngine enforces this before reaching here.
      sessionId = "_no_session";
    }
    let state = this.states.get(sessionId);
    if (!state) {
      state = { trustedActions: new Set(), deniedActions: new Set() };
      this.states.set(sessionId, state);
    }
    return state;
  }

  trustedFor(sessionId: string): Set<string> {
    return this.getOrCreate(sessionId).trustedActions;
  }

  deniedFor(sessionId: string): Set<string> {
    return this.getOrCreate(sessionId).deniedActions;
  }

  listSessions(): string[] {
    return Array.from(this.states.keys());
  }

  clear(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state) {
      state.trustedActions.clear();
      state.deniedActions.clear();
    }
  }

  clearAll(): void {
    this.states.clear();
  }
}

const _SCOPED = new SessionScopedTrustMap();
const LEGACY_COMPAT_SESSION_ID = "__legacy_session_trust_compat__";

function isTrustDuration(value: unknown): value is TrustDuration | "ALWAYS" {
  return value === "ONCE" || value === "SESSION" || value === "DENIED" || value === "ALWAYS";
}

function isSandboxMode(value: unknown): value is SandboxMode {
  return value === "workspace" || value === "ask" || value === "full-access";
}

export class SessionTrustManager {
  /**
   * Generates a stable canonical key for an action or tool invocation.
   */
  generateKey(toolName: string, target?: string | Record<string, unknown>): string {
    let cleanTarget = "";
    if (typeof target === "string") {
      cleanTarget = target.trim().replace(/\s+/g, " ");
    } else if (target && typeof target === "object") {
      cleanTarget = canonicalizeJson(target);
    }
    return `${toolName}:${cleanTarget}`;
  }

  /**
   * Records a per-session trust decision.
   * Production code MUST pass an explicit sessionId.
   */
  recordDecision(
    sessionId: string,
    toolName: string,
    target: string | Record<string, unknown>,
    duration: TrustDuration | "ALWAYS"
  ): void;
  /** @deprecated Use recordDecision(sessionId, toolName, target, duration). */
  recordDecision(
    toolName: string,
    target: string | Record<string, unknown>,
    duration: TrustDuration | "ALWAYS",
    sessionId: string
  ): void;
  recordDecision(
    first: string,
    second: string | Record<string, unknown>,
    third: TrustDuration | "ALWAYS" | string | Record<string, unknown>,
    fourth?: TrustDuration | "ALWAYS" | string
  ): void {
    // Compatibility callers from Phase 0–4 used (tool, target, duration),
    // or (tool, target, duration, session). Keep that adapter explicit and
    // deterministic; production uses the first form.
    const legacyOrder = isTrustDuration(third);
    const sessionId = legacyOrder ? (fourth && !isTrustDuration(fourth) ? String(fourth) : resolveCurrentSessionId()) : first;
    const toolName = legacyOrder ? first : second as string;
    const target = legacyOrder ? second : third as string | Record<string, unknown>;
    const duration = legacyOrder ? third as TrustDuration | "ALWAYS" : fourth as TrustDuration | "ALWAYS";
    if (!sessionId || !toolName || !isTrustDuration(duration)) {
      throw new Error("SessionTrust.recordDecision requires explicit sessionId, toolName, target, and duration");
    }
    const state = _SCOPED.getOrCreate(sessionId);
    const key = this.generateKey(toolName, target);
    if (duration === "SESSION" || duration === "ALWAYS") {
      state.trustedActions.add(key);
      state.deniedActions.delete(key);
    } else if (duration === "DENIED") {
      state.deniedActions.add(key);
      state.trustedActions.delete(key);
    }
  }

  /**
   * Per-session trust lookup. Returns true if the (toolName, target) pair
   * is in the trusted set for the given sessionId. Production code MUST
   * pass an explicit sessionId.
   */
  isTrustedForSession(
    sessionId: string,
    toolName: string,
    target?: string | Record<string, unknown>,
    mode?: SandboxMode
  ): boolean;
  /** @deprecated Use isTrustedForSession(sessionId, toolName, target, mode). */
  isTrustedForSession(
    toolName: string,
    target: string | Record<string, unknown> | undefined,
    mode: SandboxMode,
    sessionId: string
  ): boolean;
  isTrustedForSession(
    first: string,
    second: string | Record<string, unknown> | undefined,
    third?: string | Record<string, unknown> | SandboxMode,
    fourth?: SandboxMode | string
  ): boolean {
    const legacyOrder = isSandboxMode(third) && fourth === undefined || fourth !== undefined && !isSandboxMode(fourth);
    const sessionId = legacyOrder ? (fourth && !isSandboxMode(fourth) ? String(fourth) : resolveCurrentSessionId()) : first;
    const toolName = legacyOrder ? first : second as string;
    const target = legacyOrder ? second : third as string | Record<string, unknown> | undefined;
    const mode = (legacyOrder ? third : fourth) as SandboxMode | undefined;
    if (!sessionId || !toolName) {
      throw new Error("SessionTrust.isTrustedForSession requires an explicit sessionId");
    }
    const trusted = _SCOPED.trustedFor(sessionId);
    const key = this.generateKey(toolName, target);
    if (trusted.has(key)) return true;

    const isShellTool = toolName === "shell" || toolName === "run_command" || toolName === "bash";
    if (isShellTool && (mode || "workspace") !== "full-access") {
      return false;
    }
    if (trusted.has(`${toolName}:*`)) return true;
    return false;
  }

  /**
   * Per-session denial lookup. Production code MUST pass an explicit sessionId.
   */
  isDeniedForSession(
    sessionId: string,
    toolName: string,
    target?: string | Record<string, unknown>
  ): boolean;
  /** @deprecated Use isDeniedForSession(sessionId, toolName, target). */
  isDeniedForSession(
    toolName: string,
    target?: string | Record<string, unknown>
  ): boolean;
  isDeniedForSession(
    first: string,
    second?: string | Record<string, unknown>,
    third?: string | Record<string, unknown>
  ): boolean {
    const legacyOrder = third === undefined;
    const sessionId = legacyOrder ? resolveCurrentSessionId() : first;
    const toolName = legacyOrder ? first : second as string;
    const target = legacyOrder ? second : third;
    if (!sessionId || !toolName) {
      throw new Error("SessionTrust.isDeniedForSession requires an explicit sessionId");
    }
    const denied = _SCOPED.deniedFor(sessionId);
    const key = this.generateKey(toolName, target);
    return denied.has(key) || denied.has(`${toolName}:*`);
  }

  /**
   * Trust an entire tool for a specific session. Returns true if successful.
   * Shell tools in non-full-access modes are NEVER trusted wholesale.
   */
  trustEntireToolForSession(
    sessionId: string,
    toolName: string,
    mode: SandboxMode = "workspace"
  ): boolean {
    if (!sessionId) {
      throw new Error("SessionTrust.trustEntireToolForSession requires an explicit sessionId");
    }
    const isShellTool = toolName === "shell" || toolName === "run_command" || toolName === "bash";
    if (isShellTool && mode !== "full-access") {
      return false;
    }
    const trusted = _SCOPED.trustedFor(sessionId);
    trusted.add(`${toolName}:*`);
    return true;
  }

  listTrusted(sessionId: string): string[] {
    if (!sessionId) return [];
    return Array.from(_SCOPED.trustedFor(sessionId));
  }

  listAllSessions(): string[] {
    return _SCOPED.listSessions();
  }

  clear(sessionId: string): void {
    if (!sessionId) return;
    _SCOPED.clear(sessionId);
  }

  clearAll(): void {
    _SCOPED.clearAll();
  }
}

/**
 * Resolve the "current" session for the legacy singleton accessor.
 * Test/migration only. Production code MUST pass sessionId explicitly
 * via the SessionTrustManager class methods.
 */
function resolveCurrentSessionId(): string {
  // Legacy compatibility only. Production code passes an explicit sessionId
  // to SessionTrustManager and never uses this resolver.
  const g = (globalThis as any).__toolnetCurrentSessionId;
  if (typeof g === "string" && g) return g;
  return LEGACY_COMPAT_SESSION_ID;
}

/** @deprecated Only for legacy compatibility adapters and tests. */
export function getLegacyCompatibilitySessionId(): string {
  return LEGACY_COMPAT_SESSION_ID;
}

/**
 * Backward-compat singleton. RESOLVES TO THE CURRENT EXPLICIT SESSION.
 *
 * @deprecated Production code MUST use SessionTrustManager class methods
 * with an explicit sessionId. The legacy singleton is preserved for
 * test/migration paths only and is NOT safe under concurrent sessions.
 */
export const sessionTrust = {
  generateKey: (toolName: string, target?: string | Record<string, unknown>) =>
    new SessionTrustManager().generateKey(toolName, target),
  recordDecision(
    toolName: string,
    target: string | Record<string, unknown>,
    duration: TrustDuration | "ALWAYS"
  ): void {
    const sid = resolveCurrentSessionId();
    new SessionTrustManager().recordDecision(sid, toolName, target, duration);
  },
  isTrustedForSession(
    toolName: string,
    target?: string | Record<string, unknown>,
    mode: SandboxMode = "workspace"
  ): boolean {
    const sid = resolveCurrentSessionId();
    return new SessionTrustManager().isTrustedForSession(sid, toolName, target, mode);
  },
  isDeniedForSession(
    toolName: string,
    target?: string | Record<string, unknown>
  ): boolean {
    const sid = resolveCurrentSessionId();
    return new SessionTrustManager().isDeniedForSession(sid, toolName, target);
  },
  trustEntireToolForSession(
    toolName: string,
    mode: SandboxMode = "workspace"
  ): boolean {
    const sid = resolveCurrentSessionId();
    return new SessionTrustManager().trustEntireToolForSession(sid, toolName, mode);
  },
  listTrusted(): string[] {
    const sid = resolveCurrentSessionId();
    return new SessionTrustManager().listTrusted(sid);
  },
  listAllSessions(): string[] {
    return new SessionTrustManager().listAllSessions();
  },
  clear(sessionId?: string): void {
    if (sessionId) {
      new SessionTrustManager().clear(sessionId);
      return;
    }
    new SessionTrustManager().clearAll();
  },
  clearAll(): void {
    new SessionTrustManager().clearAll();
  },
};

/** Per-session accessor. */
export function getSessionTrust(sessionId: string): SessionTrustManager {
  if (!sessionId) {
    throw new Error("getSessionTrust requires an explicit sessionId");
  }
  return new SessionTrustManager();
}
