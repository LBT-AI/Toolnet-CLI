/**
 * Durable reconstruction of pending (steer/queue) inputs.
 *
 * A follow-up admitted while the agent is busy must survive a crash BEFORE it is
 * promoted into the model-visible conversation. The session journal is the one
 * durable sequence the store already owns, so pending input is derived from it —
 * no second store, no second log.
 *
 * State machine per input id:
 *
 *   (admitted) ──► pending
 *        │
 *        ├── user.message(inputId) / session.input.promoted ──► promoted
 *        └── session.input.cancelled ─────────────────────────► cancelled
 *
 * The promoted `user.message` event IS the durable promotion marker: it is
 * appended at promotion time, before the run's end-of-turn checkpoint, so a
 * crash immediately after promotion replays it exactly once (the transcript
 * checkpoint then covers it, so a later resume does not double it).
 */

import { readJournal } from "./journal";
import { sessionPathsFor } from "./paths";
import type { SessionEvent } from "./types";

export type InputDelivery = "steer" | "queue";

export interface DurablePendingInput {
  id: string;
  sessionId: string;
  content: string;
  delivery: InputDelivery;
  admittedSequence: number;
  admittedAt: number;
}

export interface PendingInputFold {
  /** Admitted, not yet promoted, not cancelled — FIFO by admission. */
  pending: DurablePendingInput[];
  promoted: string[];
  cancelled: string[];
}

function readDelivery(value: unknown): InputDelivery {
  return value === "queue" ? "queue" : "steer";
}

/**
 * Fold a session's journal events into the pending-input state. Pure: no I/O, so
 * it is safe to call from diagnostics and tests.
 */
export function foldPendingInputs(events: readonly SessionEvent[], sessionId: string): PendingInputFold {
  const admitted = new Map<string, DurablePendingInput>();
  const promoted = new Set<string>();
  const cancelled = new Set<string>();

  for (const event of events) {
    const inputId = typeof event.data?.inputId === "string" ? event.data.inputId : undefined;
    if (!inputId) continue;

    switch (event.type) {
      case "session.input.admitted": {
        admitted.set(inputId, {
          id: inputId,
          sessionId,
          content: typeof event.data?.content === "string" ? event.data.content : "",
          delivery: readDelivery(event.data?.delivery),
          admittedSequence: typeof event.data?.admittedSequence === "number" ? event.data.admittedSequence : event.seq,
          admittedAt: event.at,
        });
        break;
      }
      case "session.input.promoted":
      case "user.message":
        // `user.message` with an inputId is the promotion itself.
        promoted.add(inputId);
        break;
      case "session.input.cancelled":
        cancelled.add(inputId);
        break;
      default:
        break;
    }
  }

  const pending = [...admitted.values()]
    .filter((input) => !promoted.has(input.id) && !cancelled.has(input.id))
    .sort((a, b) => a.admittedSequence - b.admittedSequence);

  return { pending, promoted: [...promoted], cancelled: [...cancelled] };
}

/** Read and fold the pending-input state from a session's durable journal. */
export function readPendingInputs(sessionId: string, sessionsDir?: string): DurablePendingInput[] {
  try {
    const journal = readJournal(sessionPathsFor(sessionId, sessionsDir).journal);
    return foldPendingInputs(journal.events, sessionId).pending;
  } catch {
    return [];
  }
}
