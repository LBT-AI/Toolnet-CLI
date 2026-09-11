/**
 * Phase 75.6 / 75.9 — Child Session Store
 *
 * Every subagent run gets its own session. The child keeps its own transcript
 * so that (a) intermediate tokens never pollute the parent conversation and
 * (b) a later `task_id` call can resume the SAME child with its history intact.
 *
 * Sessions are kept in memory for the process lifetime and are also persisted
 * through `lib/sessionPersistence` when the parent session is saved. Deleting a
 * child here only drops the live registry entry — persisted history stays.
 */

import { randomUUID } from "node:crypto";
import type {
  ChildMessage,
  SubagentSession,
  SubagentStatus,
} from "./types";

/** Deterministic, audit-friendly child id. */
export function deriveChildSessionId(
  parentSessionId: string,
  agentId: string,
  sequence: number
): string {
  const parent = parentSessionId || "session";
  return `sub:${parent}:${agentId}:${sequence}`;
}

export class SubagentSessionStore {
  private readonly sessions = new Map<string, SubagentSession>();
  private readonly sequenceByParent = new Map<string, number>();

  /** Create a fresh child session for `parentSessionId`. */
  create(input: {
    parentSessionId: string;
    agentId: string;
    prompt: string;
    depth: number;
    model?: string;
  }): SubagentSession {
    const parentKey = input.parentSessionId || "session";
    const next = (this.sequenceByParent.get(parentKey) ?? 0) + 1;
    this.sequenceByParent.set(parentKey, next);

    const session: SubagentSession = {
      id: deriveChildSessionId(parentKey, input.agentId, next),
      parentSessionId: parentKey,
      agentId: input.agentId,
      status: "running",
      createdAt: Date.now(),
      prompt: input.prompt,
      messages: [{ role: "user", content: input.prompt }],
      toolCalls: 0,
      depth: input.depth,
      ...(input.model ? { model: input.model } : {}),
    };

    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Create an orphan session with a caller-supplied id. Used when a caller
   * wants a stable id it controls (tests, external orchestration).
   */
  createWithId(id: string, input: {
    parentSessionId: string;
    agentId: string;
    prompt: string;
    depth: number;
    model?: string;
  }): SubagentSession {
    const session: SubagentSession = {
      id,
      parentSessionId: input.parentSessionId || "session",
      agentId: input.agentId,
      status: "running",
      createdAt: Date.now(),
      prompt: input.prompt,
      messages: [{ role: "user", content: input.prompt }],
      toolCalls: 0,
      depth: input.depth,
      ...(input.model ? { model: input.model } : {}),
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): SubagentSession | undefined {
    return this.sessions.get(id);
  }

  /** Append a resume prompt and flip the session back to running. */
  resume(id: string, prompt: string): SubagentSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    session.prompt = prompt;
    session.messages.push({ role: "user", content: prompt });
    session.status = "running";
    session.completedAt = undefined;
    return session;
  }

  appendMessages(id: string, messages: ChildMessage[]): void {
    const session = this.sessions.get(id);
    if (!session || messages.length === 0) return;
    session.messages.push(...messages);
  }

  /**
   * Replace the stored transcript with the authoritative one.
   *
   * Replacing (rather than appending) is what keeps a resumed run from
   * duplicating history: the engine returns the FULL transcript, which already
   * contains every earlier message. The system message is stripped because the
   * role prompt must be regenerated from live policy on the next resume.
   */
  replaceMessages(id: string, messages: ChildMessage[]): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const transcript = messages.filter((m) => m.role !== "system");
    if (transcript.length === 0) return;
    session.messages = transcript;
  }

  recordToolCall(id: string, count = 1): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.toolCalls += count;
  }

  finish(id: string, status: SubagentStatus): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.status = status;
    session.completedAt = Date.now();
  }

  list(): SubagentSession[] {
    return [...this.sessions.values()];
  }

  listByParent(parentSessionId: string): SubagentSession[] {
    return this.list().filter((s) => s.parentSessionId === parentSessionId);
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  clear(): void {
    this.sessions.clear();
    this.sequenceByParent.clear();
  }
}

/** Process-wide store; tests construct isolated instances instead. */
export const subagentSessions = new SubagentSessionStore();

/** Fresh id for callers that need one without a session. */
export function newSubagentId(): string {
  return `sub-${randomUUID()}`;
}
