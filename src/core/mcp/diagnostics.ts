/**
 * Phase 78.31/78.33 — Extension diagnostics.
 *
 * One canonical, secret-free view of every extension. The model is deliberately
 * narrow: there is no field a token, client secret, code verifier, or header
 * value could be smuggled through, and the formatter prints only these fields.
 */

import { toDiagnosticStatus } from "./status";
import type { ExtensionStatus, McpServerInfo } from "./types";

/** Project a server record onto the diagnostic model. */
export function toExtensionStatus(info: McpServerInfo): ExtensionStatus {
  return {
    id: info.name || info.serverId,
    type: "mcp",
    status: toDiagnosticStatus(info.status),
    ...(info.transport ? { transport: info.transport } : {}),
    toolCount: info.toolCount,
    ...(info.error ? { error: info.error } : {}),
    authenticated: Boolean(info.authenticated),
  };
}

export function toPluginExtensionStatuses(
  plugins: Array<{ id: string; status: "connected" | "disabled" | "failed"; error?: string }>,
): ExtensionStatus[] {
  return plugins.map((plugin) => ({
    id: plugin.id,
    type: "plugin",
    status: plugin.status,
    ...(plugin.error ? { error: plugin.error } : {}),
  }));
}

/** Human-readable status block. Never prints a header or token value. */
export function formatExtensionStatuses(statuses: ExtensionStatus[]): string {
  if (statuses.length === 0) return "No extensions configured.";

  const lines: string[] = [];
  for (const status of statuses) {
    lines.push(status.id);
    lines.push(`  type: ${status.type}`);
    if (status.type === "mcp") {
      if (status.transport) lines.push(`  transport: ${status.transport}`);
    }
    lines.push(`  status: ${status.status}`);
    if (status.toolCount !== undefined) lines.push(`  tools: ${status.toolCount}`);
    if (status.type === "mcp") lines.push(`  auth: ${status.authenticated ? "yes" : "no"}`);
    if (status.error) lines.push(`  error: ${status.error}`);
    lines.push("");
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
