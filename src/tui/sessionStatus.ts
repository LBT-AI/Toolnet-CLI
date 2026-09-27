/**
 * Canonical session status derived from the ONE lifecycle field the agent
 * wiring writes (`tuiState.agentPhase`).
 *
 * Background / architecture rationale (learned from public agent-CLI patterns,
 * not copied): a maturity-minded CLI renders its status line, header badge and
 * terminal title from a small, explicit runtime state — never by inspecting the
 * text it happens to be showing. Before this module the header and status line
 * guessed "thinking" vs "working" by running `statusText.toLowerCase().includes("think")`,
 * which is exactly the inference the canonical state is supposed to remove, and
 * `agentPhase` was written but never read by any renderer.
 *
 * `SessionStatus` is a presentation-level projection of `AgentPhase`. It is NOT
 * a second state machine: it owns no timers and is never assigned — it is only
 * derived. The single writer of `AgentPhase` remains the TUI event wiring.
 */

import type { AgentPhase } from "../lib/reasoning";
import { A } from "../term";

/**
 * Conceptual lifecycle status surfaced to the UI. Mirrors the target flow
 * start → think → tool → permission → compaction → respond → idle.
 */
export type SessionStatus =
  | "starting"
  | "idle"
  | "thinking"
  | "tool_use"
  | "waiting_permission"
  | "compacting"
  | "finalizing"
  | "cancelled"
  | "error";

export interface StatusPresentation {
  status: SessionStatus;
  /** Concise semantic label ("Thinking", "Working", "Waiting for permission"). */
  label: string;
  /** ToolNet theme color for the status. */
  color: string;
  /** True while the spinner should animate for this status. */
  animated: boolean;
}

/**
 * Project the canonical agent phase into the UI status. Pure and total so the
 * renderers can call it on every frame without allocating or disagreeing.
 */
export function sessionStatusFromPhase(phase: AgentPhase): SessionStatus {
  switch (phase) {
    case "thinking":
      return "thinking";
    case "working":
      return "tool_use";
    case "waiting_approval":
      return "waiting_permission";
    case "compacting":
      return "compacting";
    case "streaming":
      return "finalizing";
    case "cancelled":
      return "cancelled";
    case "error":
      return "error";
    case "done":
      // "done" is terminal: the transient text ("✔ Done in 2.1s") carries the
      // result and the badge returns to idle on its own.
      return "idle";
    case "idle":
    default:
      return "idle";
  }
}

/** Build the full presentation for a canonical phase. */
export function describeAgentPhase(phase: AgentPhase): StatusPresentation {
  return describeSessionStatus(sessionStatusFromPhase(phase));
}

/** Human label + ToolNet theme color for a canonical status. */
export function describeSessionStatus(status: SessionStatus): StatusPresentation {
  switch (status) {
    case "starting":
      return { status, label: "Starting", color: A.fgCyan, animated: true };
    case "thinking":
      return { status, label: "Thinking", color: A.fgViolet, animated: true };
    case "tool_use":
      return { status, label: "Working", color: A.fgAmber, animated: true };
    case "waiting_permission":
      return { status, label: "Waiting for permission", color: A.fgAmber, animated: true };
    case "compacting":
      return { status, label: "Compacting", color: A.fgCyan, animated: true };
    case "finalizing":
      return { status, label: "Responding", color: A.fgAmber, animated: true };
    case "cancelled":
      return { status, label: "Cancelled", color: A.fgMuted, animated: false };
    case "error":
      return { status, label: "Error", color: A.fgRed, animated: false };
    case "idle":
    default:
      return { status: "idle", label: "", color: A.fgCyan, animated: false };
  }
}

/** True when the canonical status represents live work (drives the spinner). */
export function isActiveStatus(status: SessionStatus): boolean {
  return describeSessionStatus(status).animated;
}

/**
 * True when the status line / badge should be painted for a canonical phase.
 * Idle and terminal phases render nothing on their own; transient result text
 * is handled separately by the renderers.
 */
export function isActivePhase(phase: AgentPhase): boolean {
  return isActiveStatus(sessionStatusFromPhase(phase));
}
