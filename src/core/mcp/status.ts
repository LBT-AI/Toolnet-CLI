/**
 * Phase 78.4 — Deterministic MCP status state machine.
 *
 * A single boolean can express neither "reachable but unauthenticated" nor
 * "registered but unknown", so the manager carries an explicit state and every
 * transition is validated against one table. Illegal transitions are refused
 * (and reported), which is what keeps `connected` from being set on a server
 * that never completed an MCP `initialize`.
 */

import type { McpServerStatus } from "./types";

/**
 * Legal transitions. `not-installed` is a terminal "no such server" answer and
 * `disabled` is reachable from anywhere (config wins outright).
 */
export const MCP_STATUS_TRANSITIONS: Record<McpServerStatus, McpServerStatus[]> = {
  "not-installed": [],
  "untrusted": ["disabled", "connecting", "not-installed"],
  "unavailable": ["connecting", "disabled", "not-installed", "disconnected"],
  "disabled": ["connecting", "unavailable", "not-installed"],
  "disconnected": ["connecting", "disabled", "not-installed", "failed"],
  "connecting": [
    "connected",
    "failed",
    "needs_auth",
    "needs_client_registration",
    "disconnected",
    "disabled",
  ],
  "connected": ["connecting", "failed", "disconnected", "disabled"],
  "failed": ["connecting", "disabled", "not-installed", "unavailable", "disconnected"],
  "needs_auth": ["connecting", "connected", "failed", "disabled", "not-installed"],
  "needs_client_registration": ["connecting", "needs_auth", "failed", "disabled", "not-installed"],
};

/** True when the machine permits `from → to`. A no-op transition is always ok. */
export function canTransition(from: McpServerStatus, to: McpServerStatus): boolean {
  if (from === to) return true;
  return (MCP_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

export interface StatusTransition {
  from: McpServerStatus;
  to: McpServerStatus;
  at: number;
}

export interface McpStatusMachine {
  readonly status: McpServerStatus;
  readonly history: ReadonlyArray<StatusTransition>;
  /** Apply a transition. Returns false (and keeps the old state) when illegal. */
  transition(to: McpServerStatus): boolean;
  /** Force a state without validation — only for initial adoption. */
  adopt(to: McpServerStatus): void;
}

export function createStatusMachine(initial: McpServerStatus = "unavailable"): McpStatusMachine {
  let current = initial;
  const history: StatusTransition[] = [];

  return {
    get status() {
      return current;
    },
    get history() {
      return history;
    },
    transition(to) {
      if (!canTransition(current, to)) return false;
      if (to !== current) {
        history.push({ from: current, to, at: Date.now() });
        current = to;
      }
      return true;
    },
    adopt(to) {
      if (to !== current) {
        history.push({ from: current, to, at: Date.now() });
        current = to;
      }
    },
  };
}

/** Statuses that mean "the model must not see this server's tools". */
export function isToolWithdrawingStatus(status: McpServerStatus): boolean {
  return (
    status === "failed" ||
    status === "needs_auth" ||
    status === "needs_client_registration" ||
    status === "disconnected" ||
    status === "disabled" ||
    status === "untrusted" ||
    status === "not-installed" ||
    status === "unavailable"
  );
}

/** Map any canonical status onto the narrow diagnostic enum (Phase 78.31). */
export function toDiagnosticStatus(
  status: McpServerStatus,
): "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration" | "disconnected" {
  switch (status) {
    case "connected":
      return "connected";
    case "disabled":
    case "untrusted":
      return "disabled";
    case "needs_auth":
      return "needs_auth";
    case "needs_client_registration":
      return "needs_client_registration";
    case "failed":
    case "not-installed":
      return "failed";
    default:
      return "disconnected";
  }
}
