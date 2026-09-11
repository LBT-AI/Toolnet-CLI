/**
 * Phase 77 — Extension bootstrap.
 *
 * Front-ends call this ONCE at startup. It is the only place that turns
 * configuration on disk into registered capabilities, which keeps the invariant
 * "the registry is the single source of model-visible tools" true no matter
 * which front-end (TUI, headless REPL, subagent) is running.
 *
 * Everything here is failure-isolated: a broken plugin or an unreachable MCP
 * server degrades to a warning. Initialization can never take the CLI down.
 */

import { mcpManager, type McpManager } from "../mcp/manager";
import { pluginRuntime, type PluginRuntime } from "../plugins";
import { toolRegistry } from "../../lib/harness/toolRegistry";

export interface ExtensionsInitOptions {
  workspaceRoot?: string;
  /** Skip plugin loading (used by tests that only want MCP). */
  skipPlugins?: boolean;
  /** Skip MCP sync (used by tests that only want plugins). */
  skipMcp?: boolean;
}

export interface ExtensionsReport {
  workspaceRoot: string;
  plugins: {
    loaded: Array<{ id: string; toolNames: string[]; hookCount: number }>;
    failures: Array<{ spec: string; stage: string; reason: string }>;
  };
  mcp: {
    connected: Array<{ serverId: string; name: string; toolCount: number }>;
    skipped: Array<{ name: string; reason: string }>;
    failed: Array<{ name: string; error: string }>;
  };
  /** Number of external tools now visible to the model. */
  externalToolCount: number;
}

let initialized = false;

/** True once `initializeExtensions` has completed at least once. */
export function isInitialized(): boolean {
  return initialized;
}

/** Reset bootstrap bookkeeping (tests). */
export function resetInitialization(): void {
  initialized = false;
}

/**
 * Load plugins and sync MCP servers into the canonical tool registry.
 *
 * Idempotent by construction: `pluginRuntime.loadAll` disposes the previous
 * generation first, and MCP registration is owner-scoped so a re-sync replaces
 * a server's tools instead of duplicating them.
 */
export async function initializeExtensions(
  options: ExtensionsInitOptions = {},
  deps: { plugins?: PluginRuntime; mcp?: McpManager } = {},
): Promise<ExtensionsReport> {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const plugins = deps.plugins ?? pluginRuntime;
  const mcp = deps.mcp ?? mcpManager;

  const report: ExtensionsReport = {
    workspaceRoot,
    plugins: { loaded: [], failures: [] },
    mcp: { connected: [], skipped: [], failed: [] },
    externalToolCount: 0,
  };

  if (!options.skipPlugins) {
    try {
      const pluginReport = await plugins.loadAll(workspaceRoot);
      report.plugins.loaded = pluginReport.loaded.map((record) => ({
        id: record.id,
        toolNames: record.toolNames,
        hookCount: record.hookCount,
      }));
      report.plugins.failures = pluginReport.failures.map((failure) => ({
        spec: failure.spec,
        stage: failure.stage,
        reason: failure.reason,
      }));
    } catch (error) {
      // Plugin loading is best-effort: a runtime bug must not block the CLI.
      report.plugins.failures.push({
        spec: "<runtime>",
        stage: "init",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!options.skipMcp) {
    try {
      const mcpReport = await mcp.sync(workspaceRoot);
      report.mcp.connected = mcpReport.connected.map((server) => ({
        serverId: server.serverId,
        name: server.name,
        toolCount: server.toolCount,
      }));
      report.mcp.skipped = mcpReport.skipped.map((server) => ({ name: server.name, reason: server.reason }));
      report.mcp.failed = mcpReport.failed.map((server) => ({ name: server.name, error: server.error }));
    } catch (error) {
      report.mcp.failed.push({
        name: "<runtime>",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  report.externalToolCount = toolRegistry
    .list()
    .filter((def) => {
      const owner = toolRegistry.ownerOf(def.name);
      return owner !== undefined;
    }).length;

  initialized = true;
  return report;
}

/** Tear down every extension-managed capability (shutdown / test cleanup). */
export async function disposeExtensions(
  deps: { plugins?: PluginRuntime; mcp?: McpManager } = {},
): Promise<void> {
  const plugins = deps.plugins ?? pluginRuntime;
  const mcp = deps.mcp ?? mcpManager;
  try {
    await plugins.dispose();
  } catch {
    // Shutdown must not throw.
  }
  try {
    await mcp.dispose();
  } catch {
    // Shutdown must not throw.
  }
  initialized = false;
}
