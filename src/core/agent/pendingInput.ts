/**
 * Pending (steer/queue) session input — the orchestration state that lets a
 * follow-up admitted while the agent is BUSY join the SAME session instead of
 * aborting the run, opening a new one, or racing a second provider request.
 *
 * Semantics:
 *
 *   ADMITTED  the prompt is accepted and durable (journal event `session.input.admitted`).
 *   PROMOTED  the prompt has become a real user message in the model-visible
 *             conversation — exactly once, at a safe provider-turn boundary.
 *
 * Admission is NOT promotion. The agent loop only promotes at a boundary where
 * the current provider turn has finished and its tool calls have settled; nothing
 * is ever injected into a streaming request.
 *
 * Scope: strictly per session. A session only ever sees its own inputs.
 * Order:  FIFO by a monotonic admission sequence — never by callback/render timing.
 */

import { observabilityHub } from "../../lib/observability/hub";
import { sessionStore } from "../session";
import type { InputDelivery } from "../session/pendingInputJournal";

/** Line count for observability only (never part of the payload). */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines++;
  }
  return lines;
}

export type { InputDelivery };
export type PendingInputState = "pending" | "promoted" | "cancelled";

export interface PendingInput {
  id: string;
  sessionId: string;
  content: string;
  delivery: InputDelivery;
  /** Monotonic, process-wide admission order; the FIFO key. */
  admittedSequence: number;
  createdAt: number;
  state: PendingInputState;
}

/**
 * The minimum a durable fold (or a test) must provide to re-seed the registry.
 * Kept structural so the journal's `DurablePendingInput` can be restored without
 * the registry depending on the journal module.
 */
export interface RestorableInput {
  id: string;
  content: string;
  delivery: InputDelivery;
  admittedSequence: number;
  createdAt?: number;
}

/** Durable sink for the input lifecycle. Injected (and stubbed) for tests. */
export interface PendingInputJournal {
  admit(input: PendingInput): void;
  promote(input: PendingInput): void;
  cancel(input: PendingInput): void;
}

function preview(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 60);
}

/** The canonical journal: pending input is written through the ONE SessionStore. */
const defaultJournal: PendingInputJournal = {
  admit(input) {
    sessionStore.appendSessionEvent(input.sessionId, "session.input.admitted", {
      inputId: input.id,
      delivery: input.delivery,
      admittedSequence: input.admittedSequence,
      // The content is durable so a crash before promotion cannot lose the real
      // prompt. Observability logs only the length/preview — never the payload.
      content: input.content,
      contentLength: input.content.length,
      lineCount: countLines(input.content),
      preview: preview(input.content),
    });
  },
  promote(input) {
    // Promotion IS the user message: one durable event that both adds it to the
    // transcript and marks the input promoted (see pendingInputJournal fold).
    sessionStore.appendSessionEvent(input.sessionId, "user.message", { inputId: input.id, content: input.content });
    sessionStore.appendSessionEvent(input.sessionId, "session.input.promoted", { inputId: input.id, delivery: input.delivery });
  },
  cancel(input) {
    sessionStore.appendSessionEvent(input.sessionId, "session.input.cancelled", { inputId: input.id });
  },
};

function logTransition(event: string, input: PendingInput, extra: Record<string, unknown> = {}): void {
  try {
    observabilityHub.info("agent", event, {
      ...extra,
      metadata: {
        sessionId: input.sessionId,
        inputId: input.id,
        admittedSequence: input.admittedSequence,
        delivery: input.delivery,
        contentLength: input.content.length,
        lineCount: countLines(input.content),
        preview: preview(input.content),
      },
    });
  } catch {
    /* observability must never break orchestration */
  }
}

export class PendingInputRegistry {
  private readonly bySession = new Map<string, PendingInput[]>();
  private sequence = 0;

  constructor(private readonly journal: PendingInputJournal = defaultJournal) {}

  /**
   * Admit a follow-up for a session. Idempotent when an explicit `id` is given
   * and already admitted (a duplicated submit event never admits twice).
   */
  admit(
    sessionId: string,
    content: string,
    options: { delivery?: InputDelivery; id?: string } = {},
  ): PendingInput | undefined {
    const session = sessionId?.trim();
    if (!session) return undefined;
    if (typeof content !== "string" || content.trim().length === 0) return undefined;

    if (options.id) {
      const existing = this.find(session, options.id);
      if (existing) return existing;
    }

    this.sequence += 1;
    const input: PendingInput = {
      id: options.id ?? `pin_${Date.now().toString(36)}_${this.sequence}`,
      sessionId: session,
      content,
      delivery: options.delivery ?? "steer",
      admittedSequence: this.sequence,
      createdAt: Date.now(),
      state: "pending",
    };

    const bucket = this.bySession.get(session);
    if (bucket) bucket.push(input);
    else this.bySession.set(session, [input]);

    this.safeJournal(() => this.journal.admit(input));
    logTransition("steer.admitted", input, { outcome: "ok" });
    return input;
  }

  /** Pending inputs for a session, FIFO by admission sequence. */
  pending(sessionId: string): PendingInput[] {
    return (this.bySession.get(sessionId) ?? [])
      .filter((input) => input.state === "pending")
      .sort((a, b) => a.admittedSequence - b.admittedSequence);
  }

  count(sessionId: string): number {
    return this.pending(sessionId).length;
  }

  hasPending(sessionId: string): boolean {
    return this.pending(sessionId).length > 0;
  }

  /** Promote the given pending ids (promotion happens once per input). */
  promote(sessionId: string, ids: readonly string[]): PendingInput[] {
    const promoted: PendingInput[] = [];
    const wanted = new Set(ids);
    for (const input of this.pending(sessionId)) {
      if (!wanted.has(input.id)) continue;
      input.state = "promoted";
      this.safeJournal(() => this.journal.promote(input));
      logTransition("steer.promoted", input, { outcome: "ok" });
      promoted.push(input);
    }
    return promoted;
  }

  cancel(sessionId: string, id: string): boolean {
    const input = this.find(sessionId, id);
    if (!input || input.state !== "pending") return false;
    input.state = "cancelled";
    this.safeJournal(() => this.journal.cancel(input));
    logTransition("steer.cancelled", input, { outcome: "ok" });
    return true;
  }

  /** Drop a pending input without promoting it (edit/remove UX). */
  remove(sessionId: string, id: string): boolean {
    const bucket = this.bySession.get(sessionId);
    if (!bucket) return false;
    const index = bucket.findIndex((input) => input.id === id);
    if (index === -1) return false;
    if (bucket[index].state === "pending") {
      this.safeJournal(() => this.journal.cancel(bucket[index]));
    }
    bucket.splice(index, 1);
    return true;
  }

  /** Seed the in-memory registry from a durable fold (resume/reconnect). */
  restore(sessionId: string, inputs: readonly RestorableInput[]): void {
    if (!sessionId || inputs.length === 0) return;
    const existing = new Set((this.bySession.get(sessionId) ?? []).map((input) => input.id));
    const bucket = this.bySession.get(sessionId) ?? [];
    for (const input of inputs) {
      if (existing.has(input.id)) continue;
      const restored: PendingInput = {
        id: input.id,
        sessionId,
        content: input.content,
        delivery: input.delivery,
        admittedSequence: input.admittedSequence,
        createdAt: input.createdAt ?? Date.now(),
        state: "pending",
      };
      bucket.push(restored);
      existing.add(input.id);
      // Observability: a steer survived a crash/resume (no payload logged).
      logTransition("steer.restored", restored, { outcome: "ok" });
      this.sequence = Math.max(this.sequence, input.admittedSequence);
    }
    this.bySession.set(sessionId, bucket);
  }

  clear(sessionId?: string): void {
    if (sessionId) this.bySession.delete(sessionId);
    else this.bySession.clear();
  }

  private find(sessionId: string, id: string): PendingInput | undefined {
    return (this.bySession.get(sessionId) ?? []).find((input) => input.id === id);
  }

  private safeJournal(write: () => void): void {
    try {
      write();
    } catch {
      // Durability is best-effort at the boundary of a broken disk: the input
      // still lives in memory for this process rather than failing the submit.
    }
  }
}

/** Process-wide pending-input registry; tests construct isolated instances. */
export const pendingInputs = new PendingInputRegistry();

/** Test/teardown hook: forget all in-memory pending input. */
export function resetPendingInputs(): void {
  pendingInputs.clear();
}
