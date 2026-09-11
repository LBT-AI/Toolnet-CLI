/**
 * Phase 77.13/77.14 — Canonical MCP manager types.
 */

import type { McpConfigSourceKind } from "../../lib/mcpRunner";
import type { NormalizedMcpTool } from "./schema";

export type McpServerStatus =
  | "connected"
  | "disabled"
  | "untrusted"
  | "not-installed"
  | "failed"
  | "unavailable";

export interface McpServerInfo {
  serverId: string;
  name: string;
  status: McpServerStatus;
  sourceKind: McpConfigSourceKind;
  sourceFile: string;
  command: string;
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
  failed: Array<{ serverId: string; name: string; error: string }>;
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
