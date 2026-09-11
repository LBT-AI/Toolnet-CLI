/**
 * Phase 77.12/77.15/77.18 — MCP → ToolRegistry adapter.
 *
 * An MCP tool becomes an ordinary registry entry. That is the entire point:
 * the model cannot tell an MCP tool from a built-in, and it travels the same
 * permission → execute → verify pipeline. There is no `mcpManager` shortcut
 * from the agent loop.
 *
 * Canonical names use the provider-legal `mcp__<serverId>__<tool>` form already
 * established in this codebase (`mcpToolName`), which keeps native function
 * calling working — OpenAI-compatible APIs reject `.` in function names.
 * The permission resource keeps the readable `mcp:<serverId>/<tool>` form.
 */

import { toolRegistry, type ToolDefinition } from "../../lib/harness/toolRegistry";
import { mcpToolName } from "../../lib/mcpRunner";
import type { NormalizedMcpTool } from "./schema";

/** Call boundary the manager supplies; keeps the adapter free of transport. */
export interface McpToolCaller {
  call(
    serverId: string,
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string>;
}

/** Canonical, provider-legal tool name for an MCP tool. */
export function canonicalMcpToolName(serverId: string, toolName: string): string {
  return mcpToolName(serverId, toolName);
}

/** Permission resource for an MCP tool, e.g. `mcp:github/search_code`. */
export function mcpPermissionResource(serverId: string, toolName: string): string {
  return `mcp:${serverId}/${toolName}`;
}

export interface McpAdapterContext {
  serverId: string;
  serverName: string;
  tool: NormalizedMcpTool;
  caller: McpToolCaller;
}

/**
 * Build the registry definition. `execute` is intentionally thin: it forwards
 * to the caller, which owns timeouts, redaction and result bounding.
 */
export function toRegistryTool(context: McpAdapterContext): ToolDefinition {
  const { serverId, serverName, tool, caller } = context;

  return {
    name: canonicalMcpToolName(serverId, tool.name),
    description: `${tool.description}\n\n[MCP tool '${tool.name}' from server '${serverName}']`,
    parameters: tool.parameters,
    risk: tool.risk,
    category: "MCP",
    async execute(input, ctx) {
      return caller.call(serverId, serverName, tool.name, (input ?? {}) as Record<string, unknown>, ctx?.signal);
    },
  };
}

/**
 * Register every normalized tool for one server.
 *
 * Returns the accepted names plus the rejected ones, so status reporting can
 * surface "server connected but tool X could not be registered" instead of
 * silently dropping it.
 */
export function registerMcpTools(
  serverId: string,
  serverName: string,
  tools: NormalizedMcpTool[],
  caller: McpToolCaller,
): { registered: string[]; rejected: string[] } {
  const owner = `mcp:${serverId}`;
  const registered: string[] = [];
  const rejected: string[] = [];

  for (const tool of tools) {
    const definition = toRegistryTool({ serverId, serverName, tool, caller });
    if (!toolRegistry.register(definition, owner)) {
      rejected.push(definition.name);
      continue;
    }
    registered.push(definition.name);
  }

  return { registered, rejected };
}

/** Remove every tool a server registered. Returns how many were removed. */
export function unregisterMcpTools(serverId: string): number {
  return toolRegistry.unregisterOwner(`mcp:${serverId}`);
}
