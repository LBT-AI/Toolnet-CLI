/**
 * Event-contract reconciliation.
 *
 * The harness already EMITS more lifecycle events than the translator used to
 * forward: `tool:approval_required`, `agent:compact`, `verification-start` and
 * `verification-result` were silently dropped, so the TUI could never derive a
 * canonical "waiting for approval" / "compacting" state. Conversely the
 * AgentEvent union declared `tool-input-start`, `tool-input-delta` and
 * `step-finish`, which no producer ever emitted.
 *
 * These tests pin both directions: every semantic harness event translates to a
 * contract event, and the dropped ones now surface.
 */

import { describe, it, expect } from "bun:test";
import { toAgentEvents } from "../agentEngine";
import type { HarnessEvent, HarnessEventType, ExecutionMode } from "../../../lib/harness/types";
import type { AgentEvent } from "../../contracts";

const MODE: ExecutionMode = "INTERACTIVE";

function harnessEvent(type: HarnessEventType, payload?: unknown): HarnessEvent {
  return { type, timestamp: 1, sessionId: "sess_test", mode: MODE, payload };
}

/**
 * Harness events that are deliberately NOT mapped to a UI semantic event:
 * pure observability / infrastructure signals (plus subagent spawn/complete,
 * which no front-end consumes yet). Everything else MUST translate.
 */
const INFRASTRUCTURE_ONLY: ReadonlySet<HarnessEventType> = new Set([
  "harness:init",
  "agent:steer_promoted",
  "agent:routing",
  "subagent:spawn",
  "subagent:complete",
  "session:saved",
  "loop:start",
  "loop:end",
  "loop:error",
]);

const ALL_HARNESS_EVENTS: HarnessEventType[] = [
  "harness:init",
  "agent:start",
  "agent:thinking",
  "agent:stream_chunk",
  "agent:reasoning_start",
  "agent:reasoning_chunk",
  "agent:reasoning_end",
  "agent:notification",
  "agent:steer_promoted",
  "tool:queued",
  "tool:approval_required",
  "tool:start",
  "tool:progress",
  "verification-start",
  "verification-result",
  "tool:complete",
  "tool:error",
  "agent:compact",
  "agent:complete",
  "agent:error",
  "agent:routing",
  "subagent:spawn",
  "subagent:complete",
  "session:saved",
  "loop:start",
  "loop:end",
  "loop:error",
];

describe("AgentEvent contract — translator coverage", () => {
  it("every non-infrastructure harness event produces at least one AgentEvent", () => {
    const missing: HarnessEventType[] = [];
    for (const type of ALL_HARNESS_EVENTS) {
      if (INFRASTRUCTURE_ONLY.has(type)) continue;
      // Give reasoning/stream/verification cases the payload they need to emit.
      const payloads: Record<string, unknown> = {
        "agent:stream_chunk": { text: "x" },
        "agent:reasoning_chunk": { text: "x" },
      };
      const events = toAgentEvents(harnessEvent(type, payloads[type] ?? { id: "call-1", toolName: "read_file" }));
      if (events.length === 0) missing.push(type);
    }
    expect(missing).toEqual([]);
  });

  it("maps tool:approval_required to permission-required", () => {
    const events = toAgentEvents(harnessEvent("tool:approval_required", { toolName: "run_command", toolArgs: {}, reason: "needs approval" }));
    expect(events).toEqual([{ type: "permission-required", callId: "run_command", resource: "run_command" }]);
  });

  it("maps agent:compact to a canonical compaction event", () => {
    const events = toAgentEvents(harnessEvent("agent:compact", { trigger: "provider_overflow", originalTokens: 9000, newCount: 12 }));
    expect(events).toEqual([{ type: "compaction", trigger: "provider_overflow", originalTokens: 9000, newCount: 12 }]);
  });

  it("maps verification start/result", () => {
    expect(toAgentEvents(harnessEvent("verification-start", { id: "call-7", toolName: "write_file" }))).toEqual([
      { type: "verification-start", callId: "call-7" },
    ]);
    expect(toAgentEvents(harnessEvent("verification-result", { id: "call-7", ok: true }))).toEqual([
      { type: "verification-result", callId: "call-7", ok: true },
    ]);
  });

  it("never emits the removed speculative events", () => {
    const types = new Set<string>();
    for (const type of ALL_HARNESS_EVENTS) {
      for (const event of toAgentEvents(harnessEvent(type, { text: "x", id: "c", toolName: "t" }))) {
        types.add(event.type);
      }
    }
    expect(types.has("tool-input-start")).toBe(false);
    expect(types.has("tool-input-delta")).toBe(false);
    expect(types.has("step-finish")).toBe(false);
  });

  it("returns a well-formed AgentEvent shape for approval/compaction", () => {
    const approval = toAgentEvents(harnessEvent("tool:approval_required", { toolName: "x" }))[0] as AgentEvent;
    const compact = toAgentEvents(harnessEvent("agent:compact", {}))[0] as AgentEvent;
    expect(approval.type).toBe("permission-required");
    expect(compact.type).toBe("compaction");
  });
});
