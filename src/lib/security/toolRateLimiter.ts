import type { SandboxMode } from "./types";

export interface ToolRateLimitContext {
  sessionId: string;
  toolName: string;
  now: number;
  source?: string;
}

export interface ToolRateLimitResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

interface WindowCounter {
  count: number;
  windowStart: number;
}

interface SessionState {
  turnCount: Map<string, number>;
  concurrent: number;
  sessionTotal: number;
  sessionStart: number;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_MINUTE = 120;
const DEFAULT_MAX_PER_TURN = 60;
const DEFAULT_MAX_CONCURRENT = 10;
const DEFAULT_MAX_PER_SESSION = 5000;
const DEFAULT_SESSION_WINDOW_MS = 3600_000;

export interface ToolRateLimiterConfig {
  maxPerMinute?: number;
  maxPerTurn?: number;
  maxConcurrent?: number;
  maxPerSession?: number;
  windowMs?: number;
  sessionWindowMs?: number;
}

export class ToolRateLimiter {
  private maxPerMinute: number;
  private maxPerTurn: number;
  private maxConcurrent: number;
  private maxPerSession: number;
  private windowMs: number;
  private sessionWindowMs: number;

  private readonly minuteWindows = new Map<string, WindowCounter>();
  private readonly sessionStates = new Map<string, SessionState>();
  private readonly turnResets = new Map<string, number>();

  constructor(config: ToolRateLimiterConfig = {}) {
    this.maxPerMinute = config.maxPerMinute ?? DEFAULT_MAX_PER_MINUTE;
    this.maxPerTurn = config.maxPerTurn ?? DEFAULT_MAX_PER_TURN;
    this.maxConcurrent = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.maxPerSession = config.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
    this.windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
    this.sessionWindowMs = config.sessionWindowMs ?? DEFAULT_SESSION_WINDOW_MS;
  }

  configure(config: ToolRateLimiterConfig): void {
    if (config.maxPerMinute !== undefined) this.maxPerMinute = config.maxPerMinute;
    if (config.maxPerTurn !== undefined) this.maxPerTurn = config.maxPerTurn;
    if (config.maxConcurrent !== undefined) this.maxConcurrent = config.maxConcurrent;
    if (config.maxPerSession !== undefined) this.maxPerSession = config.maxPerSession;
    if (config.windowMs !== undefined) this.windowMs = config.windowMs;
    if (config.sessionWindowMs !== undefined) this.sessionWindowMs = config.sessionWindowMs;
  }

  check(context: ToolRateLimitContext): ToolRateLimitResult {
    const { sessionId, toolName, now } = context;

    if (!sessionId) {
      return { allowed: true };
    }

    const session = this.getSessionState(sessionId, now);

    if (session.concurrent >= this.maxConcurrent) {
      return {
        allowed: false,
        reason: `Concurrent tool execution limit reached (${this.maxConcurrent}).`,
        retryAfterMs: 100,
      };
    }

    const turnKey = `${sessionId}:turn`;
    const turnCount = session.turnCount.get(toolName) ?? 0;

    if (turnCount >= this.maxPerTurn) {
      return {
        allowed: false,
        reason: `Tool '${toolName}' per-turn limit reached (${this.maxPerTurn}).`,
        retryAfterMs: this.windowMs,
      };
    }

    const minuteKey = `${sessionId}:min:${Math.floor(now / this.windowMs)}`;
    const minuteCounter = this.minuteWindows.get(minuteKey);

    if (minuteCounter && minuteCounter.count >= this.maxPerMinute) {
      const elapsed = now - minuteCounter.windowStart;
      const retryAfter = Math.max(0, this.windowMs - elapsed);
      return {
        allowed: false,
        reason: `Tool call rate limit exceeded (${this.maxPerMinute}/min).`,
        retryAfterMs: retryAfter,
      };
    }

    if (session.sessionTotal >= this.maxPerSession) {
      return {
        allowed: false,
        reason: `Session tool call limit reached (${this.maxPerSession}).`,
        retryAfterMs: this.sessionWindowMs,
      };
    }

    return { allowed: true };
  }

  record(context: ToolRateLimitContext): void {
    const { sessionId, toolName, now } = context;

    if (!sessionId) return;

    const session = this.getSessionState(sessionId, now);

    session.turnCount.set(toolName, (session.turnCount.get(toolName) ?? 0) + 1);
    session.concurrent++;
    session.sessionTotal++;

    const minuteKey = `${sessionId}:min:${Math.floor(now / this.windowMs)}`;
    const existing = this.minuteWindows.get(minuteKey);

    if (existing) {
      existing.count++;
    } else {
      this.minuteWindows.set(minuteKey, { count: 1, windowStart: now });
    }

    this.turnResets.set(`${sessionId}:turn`, now);
  }

  release(context: ToolRateLimitContext): void {
    const { sessionId } = context;

    if (!sessionId) return;

    const session = this.sessionStates.get(sessionId);

    if (session && session.concurrent > 0) {
      session.concurrent--;
    }
  }

  resetTurn(sessionId: string, now = Date.now()): void {
    const session = this.sessionStates.get(sessionId);

    if (session) {
      session.turnCount.clear();
    }

    this.turnResets.set(`${sessionId}:turn`, now);
  }

  resetAll(): void {
    this.minuteWindows.clear();
    this.sessionStates.clear();
    this.turnResets.clear();
  }

  private getSessionState(sessionId: string, now: number): SessionState {
    let session = this.sessionStates.get(sessionId);

    if (!session) {
      session = {
        turnCount: new Map(),
        concurrent: 0,
        sessionTotal: 0,
        sessionStart: now,
      };
      this.sessionStates.set(sessionId, session);
    }

    if (now - session.sessionStart > this.sessionWindowMs) {
      session.turnCount.clear();
      session.concurrent = 0;
      session.sessionTotal = 0;
      session.sessionStart = now;
    }

    const lastReset = this.turnResets.get(`${sessionId}:turn`);

    if (lastReset && now - lastReset > this.windowMs) {
      session.turnCount.clear();
    }

    return session;
  }
}

export const toolRateLimiter = new ToolRateLimiter();
