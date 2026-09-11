/**
 * Phase 77.14/77.19/77.20/77.22/77.35 — The one McpManager.
 *
 * The manager is a thin orchestration layer over the existing hardened runner
 * (`src/lib/mcpRunner.ts`). It does NOT open transports itself: trust gating,
 * env scrubbing, connect timeouts and result bounding all stay in the runner,
 * so there is exactly one connector implementation.
 *
 * What the manager adds:
 *   - per-server lifecycle (connect / disconnect / status)
 *   - untrusted-schema normalization before anything reaches the model
 *   - registration into the CANONICAL toolRegistry, and unregistration on crash
 *   - a bounded, cancellable call path
 *   - per-server concurrency and tool filters from the server's own config
 */

import { toolRegistry } from "../../lib/harness/toolRegistry";
import {
  connectServer,
  disconnectServer,
  executeMcpTool,
  getActiveMcpClients,
  getLocalMcpServers,
  mcpTrustManager,
  type LocalMcpServer,
} from "../../lib/mcpRunner";
import { canonicalMcpToolName, registerMcpTools, unregisterMcpTools, type McpToolCaller } from "./adapter";
import { normalizeMcpToolDefinition, type NormalizedMcpTool } from "./schema";
import {
  DEFAULT_MAX_CONCURRENT_MCP_CALLS,
  type McpServerInfo,
  type McpServerPolicy,
  type McpServerStatus,
  type McpSyncReport,
  type McpToolInfo,
} from "./types";

interface ManagedServer {
  server: LocalMcpServer;
  status: McpServerStatus;
  error?: string;
  tools: NormalizedMcpTool[];
  toolWarnings: Map<string, string[]>;
  rejectedToolNames: string[];
  connectedAt?: number;
  /** In-flight call count for the per-server concurrency bound. */
  inFlight: number;
  waiters: Array<() => void>;
}

/** Read the optional policy fields from a raw MCP config entry. */
export function readServerPolicy(config: unknown): McpServerPolicy {
  const record = config && typeof config === "object" ? (config as Record<string, unknown>) : {};
  const asStringArray = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const items = value.filter((v): v is string => typeof v === "string");
    return items.length ? items : undefined;
  };
  const max = record.maxConcurrentCalls;
  return {
    enabledTools: asStringArray(record.enabledTools),
    disabledTools: asStringArray(record.disabledTools),
    maxConcurrentCalls:
      typeof max === "number" && Number.isFinite(max) && max > 0 ? Math.floor(max) : undefined,
  };
}

/** Apply the server's tool filter. */
export function filterServerTools(tools: NormalizedMcpTool[], policy: McpServerPolicy): NormalizedMcpTool[] {
  const enabled = policy.enabledTools ? new Set(policy.enabledTools.map((t) => t.trim())) : null;
  const disabled = new Set((policy.disabledTools ?? []).map((t) => t.trim()));

  return tools.filter((tool) => {
    if (disabled.has(tool.name)) return false;
    if (enabled && !enabled.has(tool.name)) return false;
    return true;
  });
}

export interface McpManagerOptions {
  onLog?: (level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => void;
}

export class McpManager {
  private readonly servers = new Map<string, ManagedServer>();
  private readonly options: McpManagerOptions;
  private workspaceRoot: string;
  private lastSync: McpSyncReport = {
    connected: [],
    skipped: [],
    failed: [],
    registeredToolCount: 0,
    rejectedToolNames: [],
  };
  private disposed = false;

  constructor(options: McpManagerOptions = {}) {
    this.options = options;
    this.workspaceRoot = process.cwd();
  }

  /** Call boundary handed to registry entries. */
  private readonly caller: McpToolCaller = {
    call: (serverId, serverName, toolName, args, signal) =>
      this.callToolByName(serverId, serverName, toolName, args, signal),
  };

  /** Summary of the most recent `sync`. */
  getReport(): McpSyncReport {
    return this.lastSync;
  }

  listServers(): McpServerInfo[] {
    return [...this.servers.values()].map((s) => this.toServerInfo(s));
  }

  /** Tools of one server, as the model sees them. */
  listTools(serverId: string): McpToolInfo[] {
    const managed = this.servers.get(serverId);
    if (!managed) return [];
    return managed.tools.map((tool) => this.toToolInfo(managed, tool));
  }

  /** Status of a server by name or id. "not-installed" when unknown. */
  status(nameOrId: string): McpServerStatus {
    const managed = this.find(nameOrId);
    if (!managed) return "not-installed";
    return managed.status;
  }

  /**
   * Discover every configured server, connect the trusted + enabled ones, and
   * register their normalized tools into the canonical registry.
   *
   * Servers that are untrusted/disabled are reported as skipped — never
   * silently treated as connected.
   */
  async sync(baseDir: string = this.workspaceRoot): Promise<McpSyncReport> {
    this.workspaceRoot = baseDir;
    const report: McpSyncReport = {
      connected: [],
      skipped: [],
      failed: [],
      registeredToolCount: 0,
      rejectedToolNames: [],
    };

    const discovered = getLocalMcpServers(baseDir);
    const liveIds = new Set<string>();

    for (const server of discovered) {
      liveIds.add(server.serverId);
      const managed = this.ensureManaged(server);

      const trust = mcpTrustManager.getTrustState(
        server.serverId,
        server.config,
        server.sourceKind,
        server.config.disabled,
      );
      if (trust !== "enabled") {
        const status: McpServerStatus = trust === "disabled" ? "disabled" : "untrusted";
        managed.status = status;
        managed.error = undefined;
        // A server that loses trust must not keep stale tools in the registry.
        unregisterMcpTools(server.serverId);
        managed.tools = [];
        report.skipped.push({
          serverId: server.serverId,
          name: server.name,
          status,
          reason:
            status === "disabled"
              ? "disabled by config"
              : `untrusted (${server.sourceKind}) — run /mcp enable ${server.name}`,
        });
        continue;
      }

      const connected = await this.connectServerInternal(managed);
      if (!connected) {
        report.failed.push({
          serverId: server.serverId,
          name: server.name,
          error: managed.error || "connect failed",
        });
        continue;
      }

      report.connected.push(this.toServerInfo(managed));
      report.registeredToolCount += managed.tools.length;
      report.rejectedToolNames.push(...managed.rejectedToolNames);
    }

    // Drop servers that disappeared from config.
    for (const serverId of [...this.servers.keys()]) {
      if (liveIds.has(serverId)) continue;
      await this.disconnect(serverId);
    }

    this.lastSync = report;
    return report;
  }

  /** Connect one server by name or id. Returns its status. */
  async connect(nameOrId: string): Promise<McpServerStatus> {
    const managed = this.find(nameOrId);
    if (!managed) return "not-installed";

    const trust = mcpTrustManager.getTrustState(
      managed.server.serverId,
      managed.server.config,
      managed.server.sourceKind,
      managed.server.config.disabled,
    );
    if (trust !== "enabled") {
      managed.status = trust === "disabled" ? "disabled" : "untrusted";
      return managed.status;
    }

    await this.connectServerInternal(managed);
    return managed.status;
  }

  /** Disconnect one server and unregister its tools. */
  async disconnect(nameOrId: string): Promise<boolean> {
    const managed = this.find(nameOrId);
    if (!managed) return false;

    unregisterMcpTools(managed.server.serverId);
    managed.tools = [];
    managed.rejectedToolNames = [];

    const wasActive = await disconnectServer(managed.server.serverId);
    managed.status = managed.server.config.disabled ? "disabled" : "unavailable";
    managed.connectedAt = undefined;
    return wasActive;
  }

  /**
   * Call a tool by node-side name. Bounded per server and cancellable: the
   * runner owns the protocol timeout, this method adds cancellation and
   * liveness recovery.
   */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<string> {
    const managed = this.servers.get(serverId);
    if (!managed) {
      return JSON.stringify({
        stdout: "",
        stderr: `MCP server '${serverId}' is not registered.`,
        exitCode: 1,
      });
    }
    return this.callToolByName(managed.server.serverId, managed.server.name, toolName, args, signal);
  }

  private async callToolByName(
    serverId: string,
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const managed = this.servers.get(serverId) ?? this.find(serverName);
    if (!managed) {
      return JSON.stringify({ stdout: "", stderr: `MCP server '${serverName}' is not registered.`, exitCode: 1 });
    }

    if (signal?.aborted) {
      return JSON.stringify({ stdout: "", stderr: "Cancelled", exitCode: 130 });
    }

    // Crash isolation: a dead child means the tool is gone, not that the CLI dies.
    const alive = getActiveMcpClients().some((client) => client.serverId === serverId);
    if (!alive) {
      unregisterMcpTools(serverId);
      managed.tools = [];
      managed.status = "failed";
      managed.error = "connection closed";
      this.options.onLog?.("warn", `MCP server '${serverName}' is no longer active — its tools were withdrawn`, {
        serverId,
      });
      return JSON.stringify({
        stdout: "",
        stderr: `MCP server '${serverName}' is not active (crashed or disconnected).`,
        exitCode: 1,
        errorCode: "MCP_SERVER_DEAD",
      });
    }

    const policy = readServerPolicy(managed.server.config);
    const released = await this.acquireSlot(managed, policy.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_MCP_CALLS);
    try {
      const canonicalName = canonicalMcpToolName(serverId, toolName);
      // The runner owns timeouts, redaction and output bounding.
      const raw = await executeMcpTool(canonicalName, args);
      if (raw !== null) return raw;
      return JSON.stringify({
        stdout: "",
        stderr: `MCP tool '${toolName}' is not routed on server '${serverName}'.`,
        exitCode: 1,
        errorCode: "MCP_ROUTE_NOT_FOUND",
      });
    } finally {
      released();
    }
  }

  /** Cancel in-flight bookkeeping and drop every MCP tool from the registry. */
  async dispose(): Promise<void> {
    for (const managed of this.servers.values()) {
      unregisterMcpTools(managed.server.serverId);
      await disconnectServer(managed.server.serverId);
      managed.tools = [];
      managed.status = "unavailable";
      managed.connectedAt = undefined;
    }
    this.servers.clear();
    this.lastSync = {
      connected: [],
      skipped: [],
      failed: [],
      registeredToolCount: 0,
      rejectedToolNames: [],
    };
    this.disposed = true;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private ensureManaged(server: LocalMcpServer): ManagedServer {
    const existing = this.servers.get(server.serverId);
    if (existing) {
      // Keep the freshest config (a changed command re-triggers trust anyway).
      existing.server = server;
      return existing;
    }
    const managed: ManagedServer = {
      server,
      status: "unavailable",
      tools: [],
      toolWarnings: new Map(),
      rejectedToolNames: [],
      inFlight: 0,
      waiters: [],
    };
    this.servers.set(server.serverId, managed);
    return managed;
  }

  private async connectServerInternal(managed: ManagedServer): Promise<boolean> {
    const { server } = managed;
    if (managed.status === "connected") return true;

    try {
      const ok = await connectServer(server);
      if (!ok) {
        managed.status = "failed";
        managed.error = "connect returned false";
        unregisterMcpTools(server.serverId);
        return false;
      }
    } catch (error) {
      managed.status = "failed";
      managed.error = error instanceof Error ? error.message : String(error);
      unregisterMcpTools(server.serverId);
      this.options.onLog?.("error", `failed to connect MCP server '${server.name}': ${managed.error}`, {
        serverId: server.serverId,
      });
      return false;
    }

    // Discover from the live client (the runner already listed tools).
    const client = getActiveMcpClients().find((c) => c.serverId === server.serverId);
    if (!client) {
      managed.status = "failed";
      managed.error = "connected but no active client was registered";
      return false;
    }

    const normalized: NormalizedMcpTool[] = [];
    const warnings = new Map<string, string[]>();
    const rejected: string[] = [];

    for (const raw of client.tools.map((t) => ({ name: t.originalName, description: t.function.description, inputSchema: t.function.parameters }))) {
      const result = normalizeMcpToolDefinition(raw);
      if (!result.ok) {
        rejected.push(raw.name);
        this.options.onLog?.("warn", `MCP tool rejected on '${server.name}': ${result.reason}`, {
          serverId: server.serverId,
        });
        continue;
      }
      normalized.push(result.value);
      if (result.value.warnings.length) warnings.set(result.value.name, result.value.warnings);
    }

    const policy = readServerPolicy(server.config);
    const filtered = filterServerTools(normalized, policy);

    // Re-registering is safe: unregister the owner first so a reconnect never
    // doubles up tools.
    unregisterMcpTools(server.serverId);
    const { registered, rejected: registrationRejected } = registerMcpTools(
      server.serverId,
      server.name,
      filtered,
      this.caller,
    );

    const registeredSet = new Set(registered);
    managed.tools = filtered.filter((tool) => registeredSet.has(canonicalMcpToolName(server.serverId, tool.name)));
    managed.toolWarnings = warnings;
    managed.rejectedToolNames = [...rejected, ...registrationRejected];
    managed.status = "connected";
    managed.error = undefined;
    managed.connectedAt = Date.now();

    this.options.onLog?.("info", `MCP server '${server.name}' connected (${managed.tools.length} tools)`, {
      serverId: server.serverId,
    });
    return true;
  }

  private find(nameOrId: string): ManagedServer | undefined {
    if (!nameOrId) return undefined;
    const direct = this.servers.get(nameOrId);
    if (direct) return direct;
    return [...this.servers.values()].find((s) => s.server.name === nameOrId);
  }

  private toServerInfo(managed: ManagedServer): McpServerInfo {
    return {
      serverId: managed.server.serverId,
      name: managed.server.name,
      status: managed.status,
      sourceKind: managed.server.sourceKind,
      sourceFile: managed.server.sourceFile,
      command: managed.server.config.command,
      error: managed.error,
      toolCount: managed.tools.length,
      connectedAt: managed.connectedAt,
    };
  }

  private toToolInfo(managed: ManagedServer, tool: NormalizedMcpTool): McpToolInfo {
    return {
      serverId: managed.server.serverId,
      serverName: managed.server.name,
      originalName: tool.name,
      canonicalName: canonicalMcpToolName(managed.server.serverId, tool.name),
      permissionResource: `mcp:${managed.server.serverId}/${tool.name}`,
      description: tool.description,
      risk: tool.risk,
      normalizedWithWarnings: (managed.toolWarnings.get(tool.name)?.length ?? 0) > 0,
    };
  }

  /** Simple fair semaphore so one server cannot saturate the agent loop. */
  private async acquireSlot(managed: ManagedServer, limit: number): Promise<() => void> {
    if (managed.inFlight < limit) {
      managed.inFlight++;
      return () => this.releaseSlot(managed);
    }
    await new Promise<void>((resolve) => managed.waiters.push(resolve));
    managed.inFlight++;
    return () => this.releaseSlot(managed);
  }

  private releaseSlot(managed: ManagedServer): void {
    managed.inFlight = Math.max(0, managed.inFlight - 1);
    const next = managed.waiters.shift();
    if (next) next();
  }
}

/**
 * Process-wide manager. Front-ends call `sync()` once at startup; tests build
 * their own instance so registry state stays isolated.
 */
export const mcpManager = new McpManager({
  onLog: (level, message, meta) => {
    if (level === "info") return;
    console.error(`[mcp] ${message}`, meta ?? "");
  },
});
