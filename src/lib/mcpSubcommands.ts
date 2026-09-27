/**
 * Canonical MCP subcommand metadata.
 *
 * ONE definition drives:
 *   - the `/mcp` interactive picker (src/tui/mcpPicker + slash palette)
 *   - the `/mcp` / `/mcp help` help text
 *   - the `/mcp` usage string
 *
 * Adding a subcommand here is the only change needed for it to appear in the
 * picker and in help. It is intentionally dependency-free so both the TUI and
 * the headless command registry can import it without a cycle.
 */

export interface McpSubcommand {
  /** Subcommand token, e.g. `show`. */
  name: string;
  /** Canonical usage line shown in help. */
  usage: string;
  /** One-line description shown in the picker and help. */
  description: string;
  /**
   * Selecting this subcommand should immediately offer a server picker
   * (level-2) instead of letting the user free-type the argument.
   */
  requiresServer: boolean;
  /**
   * Requires a free-form argument (url, or name + command). The picker cannot
   * enumerate it, so selection completes the composer and the handler prints a
   * contextual usage hint when the arg is still missing.
   */
  requiresArgs?: boolean;
}

export const MCP_SUBCOMMANDS: McpSubcommand[] = [
  { name: "list",       usage: "/mcp list",               description: "List configured servers",  requiresServer: false },
  { name: "show",       usage: "/mcp show [name]",        description: "Server diagnostics",       requiresServer: true },
  { name: "connect",    usage: "/mcp connect <name>",     description: "Connect a server",         requiresServer: true },
  { name: "disconnect", usage: "/mcp disconnect <name>",  description: "Disconnect a server",      requiresServer: true },
  { name: "enable",     usage: "/mcp enable <name>",      description: "Enable / trust server",    requiresServer: true },
  { name: "disable",    usage: "/mcp disable <name>",     description: "Disable server",           requiresServer: true },
  { name: "add",        usage: "/mcp add <name> <cmd>",   description: "Add local MCP server",     requiresServer: false, requiresArgs: true },
  { name: "remove",     usage: "/mcp remove <name>",      description: "Remove MCP server",        requiresServer: true },
  { name: "registry",   usage: "/mcp registry",           description: "Browse MCP registry",      requiresServer: false },
  { name: "tools",      usage: "/mcp tools <url>",        description: "Probe server tools",       requiresServer: false, requiresArgs: true },
  { name: "auth",       usage: "/mcp auth <name>",        description: "Authenticate server",      requiresServer: true },
  { name: "logout",     usage: "/mcp logout <name>",      description: "Remove credentials",       requiresServer: true },
];

/** Look up a subcommand by exact token (case-insensitive). */
export function findMcpSubcommand(name: string): McpSubcommand | undefined {
  const n = (name || "").toLowerCase();
  return MCP_SUBCOMMANDS.find((s) => s.name === n);
}

/** Subcommands whose name starts with `prefix` (case-insensitive). */
export function filterMcpSubcommands(prefix: string): McpSubcommand[] {
  const p = (prefix || "").toLowerCase();
  if (!p) return [...MCP_SUBCOMMANDS];
  return MCP_SUBCOMMANDS.filter((s) => s.name.startsWith(p));
}

/** Help lines for the `/mcp` status/help text, from the one definition. */
export function mcpSubcommandHelpLines(): string[] {
  return MCP_SUBCOMMANDS.map((s) => `  ${s.usage.padEnd(24)}${s.description}`);
}

/** Compact `[list|show|...]` token list for a usage string. */
export function mcpSubcommandUsageTokens(): string {
  return MCP_SUBCOMMANDS.map((s) => s.name).join("|");
}
