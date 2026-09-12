/**
 * Phase 77.13/77.14 — Canonical MCP manager types.
 * Phase 78.4/78.31 — Remote status machine + extension diagnostics.
 */

import type { McpConfigSourceKind } from "../../lib/mcpRunner";
import type { NormalizedMcpTool } from "./schema";

/**
 * Canonical status machine (Phase 78.4).
 *
 * `connected: boolean` is deliberately NOT the source of truth: a remote server
 * can be reachable but unauthenticated (`needs_auth`), registered-but-unknown
 * (`needs_client_registration`), or simply not attempted (`disabled`). The
 * legacy stdio states (`untrusted`, `not-installed`, `unavailable`) are kept so
 * the Phase 77 surface stays source-compatible.
 */
export type McpServerStatus =
  | "connected"
  | "connecting"
  | "disabled"
  | "failed"
  | "needs_auth"
  | "needs_client_registration"
  | "disconnected"
  | "untrusted"
  | "not-installed"
  | "unavailable";

/** Transport actually in use for a server. */
export type McpTransportKind = "stdio" | "streamable-http" | "sse";

/** How the server is reached. */
export type McpServerKind = "stdio" | "remote";

export interface McpServerInfo {
  serverId: string;
  name: string;
  status: McpServerStatus;
  sourceKind: McpConfigSourceKind;
  sourceFile: string;
  /** Empty string for remote servers (they have a URL instead). */
  command: string;
  /** Present for remote servers only. Never includes header values. */
  url?: string;
  kind: McpServerKind;
  /** Transport in use once connected (or the last attempted one). */
  transport?: McpTransportKind;
  /** True when an access token is stored and bound to this server's URL. */
  authenticated?: boolean;
  error?: string;
  toolCount: number;
  connectedAt?: number;
}

export interface McpToolInfo {
  serverId: string;
  serverName: string;
  /** Tool name as declared by the server. */
  originalName: string;
  /** Canonical registry name (`mcp__<serverId>__<tool>`). */
  canonicalName: string;
  /** Permission resource (`mcp:<serverId>/<tool>`). */
  permissionResource: string;
  description: string;
  risk: string;
  /** True when the server's declared schema was modified to fit our caps. */
  normalizedWithWarnings: boolean;
}

export interface McpSyncReport {
  /** Servers whose tools are now in the canonical registry. */
  connected: McpServerInfo[];
  skipped: Array<{ serverId: string; name: string; status: McpServerStatus; reason: string }>;
  failed: Array<{ serverId: string; name: string; error: string; status: McpServerStatus }>;
  registeredToolCount: number;
  rejectedToolNames: string[];
}

/**
 * Optional per-server policy. Read from the same MCP config entry as the
 * command — kept here so the manager has one place to consult.
 */
export interface McpServerPolicy {
  /** When non-empty, ONLY these tools are exposed to the model. */
  enabledTools?: string[];
  /** Always hidden, even if listed by the server. */
  disabledTools?: string[];
  /** Bound on simultaneous calls to this server. */
  maxConcurrentCalls?: number;
}

export const DEFAULT_MAX_CONCURRENT_MCP_CALLS = 4;

/** Normalized tool plus the warnings produced while normalizing it. */
export interface DiscoveredMcpTool {
  tool: NormalizedMcpTool;
  warnings: string[];
}

// ── Phase 78.31 — extension diagnostics ─────────────────────────────────────

/**
 * Canonical diagnostic model surfaced by `toolnet mcp status` / the TUI.
 * Intentionally narrow: it can never carry a token, header value, or verifier.
 */
export interface ExtensionStatus {
  id: string;
  type: "plugin" | "mcp";
  status: "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration" | "disconnected";
  transport?: McpTransportKind;
  toolCount?: number;
  error?: string;
  authenticated?: boolean;
}

/** Structured MCP lifecycle event emitted by the manager (Phase 78.6). */
export interface McpServerEvent {
  type: "tools-changed" | "status-changed";
  serverId: string;
  name: string;
  status: McpServerStatus;
  toolCount?: number;
}

export type McpServerEventListener = (event: McpServerEvent) => void;
