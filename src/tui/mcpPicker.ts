/**
 * MCP namespace suggestions for the slash-command picker.
 *
 * `/mcp` is a command NAMESPACE: typing it alone must open an interactive
 * picker, not execute a handler or print a wall of help into the transcript.
 * This module builds the picker items from the canonical subcommand metadata
 * (`src/lib/mcpSubcommands`) and the live MCP registry, and is consumed by the
 * existing slash palette (getSuggestions) — no second palette/engine.
 */

import { MCP_SUBCOMMANDS, findMcpSubcommand } from "../lib/mcpSubcommands";
import { getEffectiveMcpServers, mcpTrustManager } from "../lib/mcpRunner";
import { mcpManager } from "../core/mcp/manager";

export interface McpPickerItem {
  /** Display label (subcommand token, or human server name). */
  name: string;
  /** Secondary text (description, or server status). */
  desc: string;
  /** Stable id used for filtering/matching (serverId; equals name for subcommands). */
  id: string;
  /**
   * When true the palette COMPLETES the composer instead of executing. Used by
   * the subcommand and server levels of the namespace.
   */
  complete: true;
  /** Exact composer text inserted when this item is selected. */
  insert: string;
}

/** True when `/mcp` + optional whitespace matches this input's first token. */
export function isMcpNamespaceInput(input: string): boolean {
  return /^\/mcp(\s|$)/i.test(input);
}

/**
 * Generic namespace registry — one entry per root command that owns
 * subcommands. Adding a namespace is a single entry here; the palette and key
 * handling stay generic (`/mcp` is just the first provider).
 */
const NAMESPACE_PROVIDERS: Record<string, (input: string) => McpPickerItem[] | null> = {
  mcp: (input) => getMcpPickerItems(input),
};

/**
 * Resolve picker items for ANY namespace input, or `null` when the input is not
 * in a registered namespace (so the caller uses the top-level command list).
 */
export function getNamespacePickerItems(input: string): McpPickerItem[] | null {
  for (const [root, provider] of Object.entries(NAMESPACE_PROVIDERS)) {
    if (new RegExp(`^/${root}(\\s|$)`, "i").test(input)) return provider(input);
  }
  return null;
}

/**
 * Build the picker items for an `/mcp ...` composer value, or `null` when the
 * input is not in the MCP namespace (so the caller keeps the top-level
 * command palette).
 *
 * Levels:
 *   `/mcp`            → subcommands
 *   `/mcp s`          → subcommands filtered by prefix
 *   `/mcp show`       → servers (pick level 2)
 *   `/mcp show too`   → servers filtered
 *   `/mcp show id`    → [] (a complete command; Enter submits it)
 *   `/mcp list`       → [] (complete, non-server subcommand)
 */
export function getMcpPickerItems(input: string): McpPickerItem[] | null {
  if (!isMcpNamespaceInput(input)) return null;

  const rest = input.replace(/^\/mcp/i, "").replace(/^\s+/, "");
  const parts = rest.length ? rest.split(/\s+/) : [];
  const first = parts[0]?.toLowerCase() ?? "";
  const exact = parts.length >= 1 ? findMcpSubcommand(first) : undefined;

  if (!exact) {
    return MCP_SUBCOMMANDS.filter((s) => s.name.startsWith(first)).map((s) => ({
      name: s.name,
      desc: s.description,
      id: s.name,
      complete: true as const,
      insert: `/mcp ${s.name} `,
    }));
  }

  if (exact.requiresServer) {
    if (parts.length <= 1) return serverItems(exact.name, "");
    const query = parts[1];
    // A resolved server argument (plus optional extra args) means the command
    // is complete — hand it to the normal submit path.
    if (parts.length >= 2 && matchesServerExactly(query)) return [];
    if (parts.length === 2) return serverItems(exact.name, query);
    return [];
  }

  // Exact, non-server subcommand (`list`, `registry`, or arg-only `add`/`tools`):
  // the composer already names a runnable command — no picker level.
  return [];
}

function serverItems(sub: string, query: string): McpPickerItem[] {
  const q = query.toLowerCase();
  return getEffectiveMcpServers()
    .filter((server) => {
      if (!q) return true;
      return (
        server.name.toLowerCase().includes(q) ||
        server.serverId.toLowerCase().includes(q)
      );
    })
    .map((server) => {
      const trust = mcpTrustManager.getTrustState(
        server.serverId,
        server.config,
        server.sourceKind,
        server.config.disabled,
      );
      const status = trust === "disabled" ? "disabled" : mcpManager.status(server.serverId);
      const builtin = server.sourceKind === "BUILTIN" ? " [builtin]" : "";
      return {
        name: server.name || server.serverId,
        desc: `${status}${builtin}`,
        id: server.serverId,
        complete: true as const,
        // The stable serverId is what the composer carries; the handler
        // resolves it to a display name for the headless CLI.
        insert: `/mcp ${sub} ${server.serverId}`,
      };
    });
}

function matchesServerExactly(value: string): boolean {
  const v = value.toLowerCase();
  return getEffectiveMcpServers().some(
    (server) =>
      server.serverId.toLowerCase() === v || server.name.toLowerCase() === v,
  );
}
