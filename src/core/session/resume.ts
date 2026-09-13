/**
 * Deterministic reconstruction.
 *
 * Resume restores *state*, never execution: replaying the journal must not run a
 * tool, spawn a process, or touch the network. The reconstruction rule matches
 * the durable-write rule — the materialized record is the base described by the
 * newest checkpoint, and every journal event after that checkpoint is replayed
 * once, in sequence order, forward.
 *
 * The one place where "what happened" is genuinely unknown is a tool call that
 * was durably started and never completed (the process died mid-tool). Such a
 * call is reported as interrupted with an unknown outcome and is NEVER retried
 * automatically — a mutating tool may have half-applied, so only the harness,
 * after inspecting the real workspace, may decide to act again.
 */

import { isMutationTool, toolFileTarget } from "../harness/evidence";
import type {
  ExecutionEvidenceSummary,
  InterruptedTool,
  SessionCheckpoint,
  SessionEvent,
  SessionMessage,
  SessionRecord,
  SessionStatus,
} from "./types";
import { ACTIVE_SESSION_STATUSES, emptyEvidenceSummary } from "./types";

export interface ReplayInput {
  record: SessionRecord;
  events: SessionEvent[];
  checkpointHead: SessionCheckpoint | null;
}

export interface ReplayResult {
  transcript: SessionMessage[];
  status: SessionStatus;
  /** Status was still active when the journal ended. */
  activeAtEnd: boolean;
  interruptedTools: InterruptedTool[];
  evidence: ExecutionEvidenceSummary;
  replayedEvents: number;
  warnings: string[];
}

function messageFromEvent(event: SessionEvent): SessionMessage | null {
  const data = event.data ?? {};
  if (event.type === "user.message") {
    return { role: "user", content: String(data.content ?? "") };
  }
  if (event.type === "assistant.message") {
    const message: SessionMessage = { role: "assistant", content: String(data.content ?? "") };
    if (Array.isArray(data.toolCalls) && data.toolCalls.length > 0) message.tool_calls = data.toolCalls;
    return message;
  }
  if (event.type === "tool.completed" || event.type === "tool.failed") {
    const callId = typeof data.callId === "string" ? data.callId : "";
    const name = typeof data.name === "string" ? data.name : "tool";
    const content = String(data.content ?? data.error ?? "");
    return { role: "tool", content, name, ...(callId ? { tool_call_id: callId } : {}) };
  }
  return null;
}

function terminalStatusFromEvent(event: SessionEvent): SessionStatus | null {
  switch (event.type) {
    case "session.completed":
      return "completed";
    case "session.failed":
      return "failed";
    case "session.cancelled":
      return "cancelled";
    case "session.status": {
      const next = event.data?.status;
      return typeof next === "string" ? (next as SessionStatus) : null;
    }
    default:
      return null;
  }
}

/**
 * Replay the journal tail onto the materialized base. Pure: no i/o, no side
 * effects, safe to call during diagnostics.
 */
export function replaySession(input: ReplayInput): ReplayResult {
  const { record, events, checkpointHead } = input;
  const warnings: string[] = [];
  const baseSequence = checkpointHead?.eventSequence ?? 0;

  const transcript: SessionMessage[] = (record.messages ?? []).map((message) => ({ ...message }));
  const evidence: ExecutionEvidenceSummary = checkpointHead?.evidence
    ? { ...checkpointHead.evidence, filesChanged: [...checkpointHead.evidence.filesChanged] }
    : emptyEvidenceSummary();

  const started = new Map<string, { name: string; at: number }>();
  const countedCalls = new Set<string>();
  let status: SessionStatus = record.status;
  let replayedEvents = 0;
  let sawTerminalEvent = false;

  for (const event of events) {
    if (event.seq <= baseSequence) continue;
    replayedEvents += 1;

    if (event.type === "tool.started") {
      const callId = typeof event.data?.callId === "string" ? event.data.callId : `seq-${event.seq}`;
      const name = typeof event.data?.name === "string" ? event.data.name : "tool";
      started.set(callId, { name, at: event.at });
      if (!countedCalls.has(callId)) {
        countedCalls.add(callId);
        evidence.toolCalls += 1;
      }
      continue;
    }

    if (event.type === "tool.completed" || event.type === "tool.failed") {
      const callId = typeof event.data?.callId === "string" ? event.data.callId : "";
      if (callId) started.delete(callId);
      // A call that never emitted a start event is still a real call; one that
      // did must not be counted twice.
      if (!callId) evidence.toolCalls += 1;
      else if (!countedCalls.has(callId)) {
        countedCalls.add(callId);
        evidence.toolCalls += 1;
      }
      const failed = event.type === "tool.failed" || event.data?.ok === false;
      if (failed) evidence.failedToolCalls += 1;
      const name = typeof event.data?.name === "string" ? event.data.name : "";
      if (!failed && name && isMutationTool(name)) {
        const target = toolFileTarget(event.data?.args ?? event.data);
        if (target && !evidence.filesChanged.includes(target)) evidence.filesChanged.push(target);
      }
      const message = messageFromEvent(event);
      if (message) transcript.push(message);
      continue;
    }

    if (event.type === "permission.decision") {
      if (String(event.data?.decision ?? "").toUpperCase() === "DENY") evidence.permissionDenials += 1;
      continue;
    }

    if (event.type === "user.message" || event.type === "assistant.message") {
      const message = messageFromEvent(event);
      if (message) transcript.push(message);
      continue;
    }

    const terminal = terminalStatusFromEvent(event);
    if (terminal) {
      status = terminal;
      sawTerminalEvent = true;
    }
  }

  const interruptedTools: InterruptedTool[] = [];
  for (const [callId, info] of started) {
    interruptedTools.push({ callId, name: info.name, startedAt: info.at, reason: "started_without_completion" });
  }
  if (interruptedTools.length > 0) {
    warnings.push(
      `${interruptedTools.length} tool call(s) started but never completed — outcome unknown, not retried automatically`,
    );
  }

  // A run that was still active when the journal ended either has a live owner
  // (genuinely running) or was interrupted by a crash. The caller knows which;
  // this function only reports the durable fact.
  const activeAtEnd = ACTIVE_SESSION_STATUSES.has(status) && !sawTerminalEvent;

  return { transcript, status, activeAtEnd, interruptedTools, evidence, replayedEvents, warnings };
}

/**
 * Choose the newest checkpoint the journal can actually support. A checkpoint
 * whose `eventSequence` exceeds the last durable event points at state that was
 * lost (crash between checkpoint write and journal durability), so it is
 * rejected in favour of the newest earlier checkpoint that the journal covers.
 */
export function selectCheckpointHead(
  checkpoints: SessionCheckpoint[],
  journalLastSequence: number,
): { head: SessionCheckpoint | null; skipped: number } {
  let skipped = 0;
  for (let i = checkpoints.length - 1; i >= 0; i--) {
    const candidate = checkpoints[i];
    if (candidate.eventSequence <= journalLastSequence) {
      return { head: candidate, skipped };
    }
    skipped += 1;
  }
  return { head: null, skipped };
}
