/**
 * Append-only journals.
 *
 * The event journal and the checkpoint log are both JSONL: one complete record
 * per line, appended, never rewritten. That choice is what makes crash recovery
 * tractable — a killed process can only ever damage the final line, and every
 * earlier record stays readable. Readers therefore:
 *
 *   - drop a torn final line and report it (`truncated`),
 *   - isolate an unreadable interior line instead of failing the whole file,
 *   - reject out-of-order or duplicate sequence numbers rather than reordering,
 *   - keep unknown event types (forward compatibility) but never act on them.
 *
 * Nothing here interprets a session; it only guarantees that what was durably
 * written comes back in the order it was written.
 */

import { appendLineDurable, fileExists, readFileSafe } from "./atomic";
import {
  isSessionEventType,
  type SessionCheckpoint,
  type SessionEvent,
  type SessionStatus,
  isSessionStatus,
} from "./types";

export interface JournalReadResult {
  events: SessionEvent[];
  lastSequence: number;
  /** Final line was incomplete (a crash mid-append) and was dropped. */
  truncated: boolean;
  /** Interior lines that were not valid event records and were isolated. */
  malformedLines: number;
  /** Records whose sequence was not strictly greater than the previous one. */
  duplicateSequences: number;
  /** Event types this build does not know — preserved, never replayed as actions. */
  unknownTypes: string[];
}

export interface CheckpointReadResult {
  checkpoints: SessionCheckpoint[];
  latest: SessionCheckpoint | null;
  truncated: boolean;
  malformedLines: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitLines(raw: string): string[] {
  return raw.split("\n");
}

function isValidEventShape(value: unknown): value is { seq: number; at: number; type: string; data?: unknown } {
  if (!isRecord(value)) return false;
  if (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 1) return false;
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) return false;
  if (typeof value.type !== "string" || value.type.length === 0) return false;
  if (value.data !== undefined && !isRecord(value.data)) return false;
  return true;
}

export function readJournal(filePath: string): JournalReadResult {
  const result: JournalReadResult = {
    events: [],
    lastSequence: 0,
    truncated: false,
    malformedLines: 0,
    duplicateSequences: 0,
    unknownTypes: [],
  };
  const raw = readFileSafe(filePath);
  if (raw === null || raw.length === 0) return result;

  const lines = splitLines(raw);
  // A trailing newline produces one empty final element; that is normal.
  const lastIndex = lines.length - 1;
  const hasTrailingNewline = lines[lastIndex] === "";
  const usable = hasTrailingNewline ? lines.slice(0, lastIndex) : lines;

  for (let i = 0; i < usable.length; i++) {
    const line = usable[i];
    if (line.trim().length === 0) continue;
    const isFinalWithoutNewline = !hasTrailingNewline && i === usable.length - 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A torn tail is the expected crash shape; anything else is isolated.
      if (isFinalWithoutNewline) result.truncated = true;
      else result.malformedLines += 1;
      continue;
    }

    if (!isValidEventShape(parsed)) {
      if (isFinalWithoutNewline) result.truncated = true;
      else result.malformedLines += 1;
      continue;
    }

    if (parsed.seq <= result.lastSequence) {
      result.duplicateSequences += 1;
      continue;
    }

    if (!isSessionEventType(parsed.type) && !result.unknownTypes.includes(parsed.type)) {
      result.unknownTypes.push(parsed.type);
    }

    result.events.push({
      seq: parsed.seq,
      at: parsed.at,
      type: parsed.type as SessionEvent["type"],
      ...(parsed.data !== undefined ? { data: parsed.data as Record<string, unknown> } : {}),
    });
    result.lastSequence = parsed.seq;
  }

  return result;
}

export function appendEvent(filePath: string, event: SessionEvent): void {
  appendLineDurable(filePath, JSON.stringify(event));
}

function isValidCheckpointShape(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (typeof value.checkpointId !== "string" || value.checkpointId.length === 0) return false;
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) return false;
  if (typeof value.eventSequence !== "number" || !Number.isInteger(value.eventSequence) || value.eventSequence < 0) {
    return false;
  }
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) return false;
  if (typeof value.messageCount !== "number" || !Number.isInteger(value.messageCount) || value.messageCount < 0) {
    return false;
  }
  return true;
}

function normalizeCheckpoint(value: Record<string, unknown>): SessionCheckpoint {
  const status: SessionStatus = isSessionStatus(value.status) ? value.status : "idle";
  return {
    checkpointId: String(value.checkpointId),
    sessionId: String(value.sessionId),
    eventSequence: Number(value.eventSequence),
    at: Number(value.at),
    messageCount: Number(value.messageCount),
    workspaceKey: typeof value.workspaceKey === "string" ? value.workspaceKey : "",
    status,
    reason: typeof value.reason === "string" ? value.reason : "unknown",
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
    ...(typeof value.harness === "string" ? { harness: value.harness } : {}),
    ...(typeof value.authProfileId === "string" ? { authProfileId: value.authProfileId } : {}),
    ...(typeof value.verdict === "string" ? { verdict: value.verdict } : {}),
    ...(isRecord(value.evidence) ? { evidence: value.evidence as unknown as SessionCheckpoint["evidence"] } : {}),
  };
}

export function readCheckpoints(filePath: string): CheckpointReadResult {
  const result: CheckpointReadResult = {
    checkpoints: [],
    latest: null,
    truncated: false,
    malformedLines: 0,
  };
  const raw = readFileSafe(filePath);
  if (raw === null || raw.length === 0) return result;

  const lines = splitLines(raw);
  const lastIndex = lines.length - 1;
  const hasTrailingNewline = lines[lastIndex] === "";
  const usable = hasTrailingNewline ? lines.slice(0, lastIndex) : lines;

  for (let i = 0; i < usable.length; i++) {
    const line = usable[i];
    if (line.trim().length === 0) continue;
    const isFinalWithoutNewline = !hasTrailingNewline && i === usable.length - 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (isFinalWithoutNewline) result.truncated = true;
      else result.malformedLines += 1;
      continue;
    }

    if (!isValidCheckpointShape(parsed)) {
      if (isFinalWithoutNewline) result.truncated = true;
      else result.malformedLines += 1;
      continue;
    }

    result.checkpoints.push(normalizeCheckpoint(parsed));
  }

  result.latest = result.checkpoints.length > 0 ? result.checkpoints[result.checkpoints.length - 1] : null;
  return result;
}

export function appendCheckpoint(filePath: string, checkpoint: SessionCheckpoint): void {
  appendLineDurable(filePath, JSON.stringify(checkpoint));
}

export function journalExists(filePath: string): boolean {
  return fileExists(filePath);
}
