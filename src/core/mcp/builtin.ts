/**
 * Built-in default MCP configurations for ToolNet CLI.
 *
 * Provides out-of-the-box MCP capabilities (such as ToolNet Skills)
 * without requiring manual user configuration on fresh install.
 */

import type { LocalMcpServer, McpServerConfig } from "../../lib/mcpRunner";

export const TOOLNET_SKILLS_MCP_URL = "https://skills.toolnet.tech/mcp";
export const TOOLNET_SKILLS_MCP_ID = "toolnet-skills";
export const TOOLNET_SKILLS_MCP_NAME = "ToolNet Skills";
export const TOOLNET_SKILLS_DEFAULT_TIMEOUT_MS = 10_000;

/** Normalizes an MCP URL for robust duplicate detection. */
export function normalizeMcpUrl(url: string | undefined): string {
  if (!url || typeof url !== "string") return "";
  try {
    const parsed = new URL(url.trim());
    return (parsed.origin + parsed.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return url.trim().replace(/\/+$/, "").toLowerCase();
  }
}

/** Check if a candidate server represents the built-in ToolNet Skills server. */
export function isBuiltinSkillsMcp(server: {
  url?: string;
  name?: string;
  serverId?: string;
  config?: { url?: string };
}): boolean {
  const candidateUrl = server.config?.url ?? server.url;
  if (candidateUrl && normalizeMcpUrl(candidateUrl) === normalizeMcpUrl(TOOLNET_SKILLS_MCP_URL)) {
    return true;
  }
  if (server.serverId && server.serverId.toLowerCase() === TOOLNET_SKILLS_MCP_ID.toLowerCase()) {
    return true;
  }
  const name = server.name?.trim().toLowerCase();
  if (name === TOOLNET_SKILLS_MCP_ID.toLowerCase() || name === TOOLNET_SKILLS_MCP_NAME.toLowerCase()) {
    return true;
  }
  return false;
}

/** Creates the canonical built-in ToolNet Skills server instance. */
export function createBuiltinSkillsServer(overrides?: Partial<McpServerConfig>): LocalMcpServer {
  return {
    name: TOOLNET_SKILLS_MCP_NAME,
    serverId: TOOLNET_SKILLS_MCP_ID,
    sourceFile: "builtin",
    sourceKind: "BUILTIN",
    config: {
      type: "remote",
      url: TOOLNET_SKILLS_MCP_URL,
      enabled: true,
      timeout: TOOLNET_SKILLS_DEFAULT_TIMEOUT_MS,
      ...overrides,
    },
  };
}

/** Returns the list of all default built-in MCP servers. */
export function getBuiltinMcpServers(): LocalMcpServer[] {
  return [createBuiltinSkillsServer()];
}
