/**
 * Phase 77.14/77.19/77.20/77.22/77.35 — The one McpManager.
 * Phase 78.1/78.4/78.5/78.6/78.9/78.31 — Remote MCP + auth, same pipeline.
 *
 * The manager is a thin orchestration layer over two transport executors:
 *
 *   stdio  → `src/lib/mcpRunner.ts`  (Phase 77, unchanged)
 *   remote → `./remoteTransport.ts`  (Phase 78, Streamable HTTP then SSE)
 *
 * It does NOT become a second runtime. Whichever executor produced the tools,
 * they are normalized with the same schema layer and registered into the SAME
 * `toolRegistry`, so remote tools travel the identical
 * permission → execute → verify pipeline as built-ins. There is no
 * `remoteMcpManager`, no direct agent → HTTP path, and no way for a subagent or
 * teamwork node to reach a remote server except through the registry.
 *
 * What the manager adds for remote servers:
 *   - the deterministic status machine (`needs_auth`, `needs_client_registration`, …)
 *   - URL-bound OAuth credentials in the auth store, never in the transcript
 *   - `tools/list_changed` refresh without restarting the agent engine
 *   - onclose cleanup that WITHDRAWS stale tools from the model
 *   - secret-free diagnostics
 */

import { toolRegistry } from "../../lib/harness/toolRegistry";
import {
  connectServer,
  disconnectServer,
  executeMcpTool,
  getActiveMcpClients,
  getLocalMcpServers,
  isRemoteMcpConfig,
  mcpTrustManager,
  MCP_CALL_TIMEOUT_MS,
  MCP_MAX_RESULT_BYTES,
  truncateWithMarker,
  type LocalMcpServer,
} from "../../lib/mcpRunner";
import { redactSecrets } from "../../lib/security/secretGuard";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { canonicalMcpToolName, registerMcpTools, unregisterMcpTools, type McpToolCaller } from "./adapter";
import { normalizeMcpToolDefinition, type NormalizedMcpTool } from "./schema";
import { createStatusMachine, isToolWithdrawingStatus, type McpStatusMachine } from "./status";
import {
  getMcpAuthStorePath,
  mcpAuthStore,
  McpAuthStore,
  type McpAuthTokens,
} from "./authStore";
import {
  beginAuthorization,
  completeAuthorization,
  hasUsableToken,
  McpOAuthProvider,
  refreshAccessTokenIfNeeded,
} from "./oauth";
import { startOAuthCallbackServer, type OAuthCallbackServer } from "./oauthCallback";
import { createGuardedFetch } from "./remoteFetch";
import {
  mergeRemoteHeaders,
  parseRemoteServerConfig,
  redactRemoteError,
  type McpRemoteConfig,
} from "./remoteConfig";
import { connectRemoteServer, listRemoteTools, type RemoteConnection } from "./remoteTransport";
import {
  DEFAULT_MAX_CONCURRENT_MCP_CALLS,
  type ExtensionStatus,
  type McpServerEvent,
  type McpServerEventListener,
  type McpServerInfo,
  type McpServerKind,
  type McpServerPolicy,
  type McpServerStatus,
  type McpSyncReport,
  type McpToolInfo,
  type McpTransportKind,
} from "./types";
import { toExtensionStatus } from "./diagnostics";

interface RawTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}

interface PendingAuth {
  server: OAuthCallbackServer;
  redirectUrl: string;
  authorizationUrl?: string;
}

interface RemoteState {
  config: McpRemoteConfig;
  fetchFn: FetchLike;
  connection?: RemoteConnection;
  authProvider?: McpOAuthProvider;
  pending?: PendingAuth;
  authorized: boolean;
}

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
  kind: McpServerKind;
  transport?: McpTransportKind;
  remote?: RemoteState;
  /** True while an intentional disconnect is in progress (suppresses onclose noise). */
  closing: boolean;
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
  /** Auth store override — tests point this at a temp file. */
  authStore?: McpAuthStore;
  /** Structured lifecycle events (Phase 78.6). */
  onEvent?: McpServerEventListener;
}

export interface McpAuthStartResult {
  serverId: string;
  name: string;
  status: McpServerStatus;
  authorizationUrl?: string;
  /** Set when the flow cannot proceed without configuration. */
  reason?: string;
}

export class McpManager {
  private readonly servers = new Map<string, ManagedServer>();
  private readonly options: McpManagerOptions;
  private readonly authStore: McpAuthStore;
  private readonly listeners = new Set<McpServerEventListener>();
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
    this.authStore = options.authStore ?? mcpAuthStore;
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

  /** Secret-free diagnostic view of every known MCP server (Phase 78.31). */
  getDiagnostics(): ExtensionStatus[] {
    return this.listServers().map(toExtensionStatus);
  }

  /** Subscribe to status/tool changes. Returns an unsubscribe function. */
  subscribe(listener: McpServerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Auth store in use (tests/diagnostics). Never exposes token values. */
  getAuthStorePath(): string {
    return typeof (this.authStore as { getPath?: () => string }).getPath === "function"
      ? this.authStore.getPath()
      : getMcpAuthStorePath();
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

      if (managed.kind === "remote" && !managed.remote?.config.enabled) {
        this.setStatus(managed, "disabled");
        managed.error = undefined;
        unregisterMcpTools(server.serverId);
        managed.tools = [];
        report.skipped.push({
          serverId: server.serverId,
          name: server.name,
          status: "disabled",
          reason: "disabled by config (enabled: false)",
        });
        continue;
      }

      const trust = mcpTrustManager.getTrustState(
        server.serverId,
        server.config,
        server.sourceKind,
        server.config.disabled,
      );
      if (trust !== "enabled") {
        const status: McpServerStatus = trust === "disabled" ? "disabled" : "untrusted";
        this.setStatus(managed, status);
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
          status: managed.status,
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
      this.setStatus(managed, trust === "disabled" ? "disabled" : "untrusted");
      return managed.status;
    }

    await this.connectServerInternal(managed);
    return managed.status;
  }

  /** Disconnect one server and unregister its tools. */
  async disconnect(nameOrId: string): Promise<boolean> {
    const managed = this.find(nameOrId);
    if (!managed) return false;

    managed.closing = true;
    try {
      unregisterMcpTools(managed.server.serverId);
      managed.tools = [];
      managed.rejectedToolNames = [];

      if (managed.kind === "remote") {
        const connection = managed.remote?.connection;
        managed.remote && (managed.remote.connection = undefined);
        if (connection) {
          try {
            await connection.client.close();
          } catch {
            /* already gone */
          }
          try {
            await connection.transport.close();
          } catch {
            /* already gone */
          }
        }
        await this.stopPendingAuth(managed);
        this.setStatus(managed, managed.remote?.config.enabled ? "disconnected" : "disabled");
        managed.connectedAt = undefined;
        this.emit({
          type: "status-changed",
          serverId: managed.server.serverId,
          name: managed.server.name,
          status: managed.status,
          toolCount: 0,
        });
        return Boolean(connection);
      }

      const wasActive = await disconnectServer(managed.server.serverId);
      this.setStatus(managed, managed.server.config.disabled ? "disabled" : "unavailable");
      managed.connectedAt = undefined;
      return wasActive;
    } finally {
      managed.closing = false;
    }
  }

  /**
   * Call a tool by node-side name. Bounded per server and cancellable: the
   * stdio runner owns its protocol timeout, remote calls get the same bound
   * applied here.
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

  // ── Phase 78.9/78.12/78.16 — auth lifecycle ────────────────────────────────

  /**
   * Start the OAuth flow for a remote server.
   *
   * `waitForCallback: false` implements the headless/VPS path (Phase 78.12):
   * print the authorization URL, let the operator complete it elsewhere, then
   * finish with `completeAuth(name, code, state)`.
   */
  async startAuth(
    nameOrId: string,
    options: { waitForCallback?: boolean; timeoutMs?: number } = {},
  ): Promise<McpAuthStartResult> {
    const managed = this.find(nameOrId);
    if (!managed) {
      return { serverId: nameOrId, name: nameOrId, status: "not-installed", reason: "unknown server" };
    }
    const remote = managed.remote;
    if (managed.kind !== "remote" || !remote) {
      return {
        serverId: managed.server.serverId,
        name: managed.server.name,
        status: managed.status,
        reason: "stdio servers authenticate via their own environment, not OAuth",
      };
    }

    this.setStatus(managed, "connecting");
    const callback = await startOAuthCallbackServer({
      port: remote.config.oauth?.callbackPort,
      timeoutMs: options.timeoutMs,
    });
    remote.pending = { server: callback, redirectUrl: callback.redirectUri };

    let result: Awaited<ReturnType<typeof beginAuthorization>>;
    try {
      result = await beginAuthorization({
        name: managed.server.name,
        serverUrl: remote.config.url,
        store: this.authStore,
        fetchFn: remote.fetchFn,
        client: remote.config.oauth,
        redirectUrl: callback.redirectUri,
      });
    } catch (error) {
      await this.stopPendingAuth(managed);
      this.setStatus(managed, "failed");
      managed.error = redactRemoteError(error instanceof Error ? error.message : String(error));
      return {
        serverId: managed.server.serverId,
        name: managed.server.name,
        status: managed.status,
        reason: managed.error,
      };
    }

    if (result.status === "NEEDS_CLIENT_REGISTRATION") {
      await this.stopPendingAuth(managed);
      this.setStatus(managed, "needs_client_registration");
      managed.error = result.reason;
      return {
        serverId: managed.server.serverId,
        name: managed.server.name,
        status: managed.status,
        reason: result.reason,
      };
    }

    if (result.status === "AUTHORIZED") {
      await this.stopPendingAuth(managed);
      await this.connectServerInternal(managed);
      return { serverId: managed.server.serverId, name: managed.server.name, status: managed.status };
    }

    remote.pending.authorizationUrl = result.authorizationUrl;

    if (options.waitForCallback === false) {
      // Headless: the URL is returned to the operator; completeAuth finishes it.
      this.setStatus(managed, "needs_auth");
      return {
        serverId: managed.server.serverId,
        name: managed.server.name,
        status: "needs_auth",
        authorizationUrl: result.authorizationUrl,
      };
    }

    try {
      const callbackResult = await callback.waitForCallback();
      const status = await this.completeAuth(
        managed.server.name,
        callbackResult.code,
        callbackResult.state,
      );
      return {
        serverId: managed.server.serverId,
        name: managed.server.name,
        status,
        authorizationUrl: result.authorizationUrl,
      };
    } catch (error) {
      await this.stopPendingAuth(managed);
      this.setStatus(managed, "needs_auth");
      managed.error = redactRemoteError(error instanceof Error ? error.message : String(error));
      return {
        serverId: managed.server.serverId,
        name: managed.server.name,
        status: managed.status,
        authorizationUrl: result.authorizationUrl,
        reason: managed.error,
      };
    }
  }

  /**
   * Finish an authorization. `state` is validated against the stored value
   * BEFORE the code is exchanged (Phase 78.23); a mismatch saves nothing and
   * leaves the server unauthenticated.
   */
  async completeAuth(nameOrId: string, code: string, state?: string): Promise<McpServerStatus> {
    const managed = this.find(nameOrId);
    if (!managed?.remote) return "not-installed";
    const remote = managed.remote;

    const redirectUrl = remote.pending?.redirectUrl ?? remote.config.oauth?.redirectUri;
    if (!redirectUrl) {
      this.setStatus(managed, "needs_auth");
      managed.error = "authorization was not started; run 'toolnet mcp auth <server>' first";
      return managed.status;
    }

    try {
      await completeAuthorization({
        name: managed.server.name,
        serverUrl: remote.config.url,
        store: this.authStore,
        fetchFn: remote.fetchFn,
        client: remote.config.oauth,
        redirectUrl,
        code,
        state,
      });
    } catch (error) {
      // A state mismatch is a security event: never connect, never persist.
      this.setStatus(managed, "needs_auth");
      managed.error = redactRemoteError(error instanceof Error ? error.message : String(error));
      return managed.status;
    } finally {
      await this.stopPendingAuth(managed);
    }

    this.options.onLog?.("info", `MCP server '${managed.server.name}' authorized`, {
      serverId: managed.server.serverId,
    });

    await this.connectServerInternal(managed);
    return managed.status;
  }

  /**
   * Phase 78.16 — remove credentials for a server. The server config itself is
   * untouched; the next connect requires auth again.
   */
  async logout(nameOrId: string): Promise<boolean> {
    const managed = this.find(nameOrId);
    if (!managed) return false;

    // Disconnect first so no request can race the credential removal, then drop
    // tokens + client info + verifier/state. The server config is untouched.
    await this.disconnect(managed.server.serverId);
    const removed = await this.authStore.remove(managed.server.name);
    this.setStatus(managed, managed.remote?.config.enabled === false ? "disabled" : "disconnected");
    managed.error = undefined;
    return removed;
  }

  /** Cancel in-flight bookkeeping and drop every MCP tool from the registry. */
  async dispose(): Promise<void> {
    for (const managed of this.servers.values()) {
      managed.closing = true;
      await this.stopPendingAuth(managed);
      if (managed.remote?.connection) {
        try {
          await managed.remote.connection.client.close();
        } catch {
          /* ignore */
        }
        try {
          await managed.remote.connection.transport.close();
        } catch {
          /* ignore */
        }
        managed.remote.connection = undefined;
      } else {
        await disconnectServer(managed.server.serverId);
      }
      unregisterMcpTools(managed.server.serverId);
      managed.tools = [];
      this.setStatus(managed, "unavailable");
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

    const kind: McpServerKind = isRemoteMcpConfig(server.config) ? "remote" : "stdio";
    const managed: ManagedServer = {
      server,
      status: "unavailable",
      tools: [],
      toolWarnings: new Map(),
      rejectedToolNames: [],
      inFlight: 0,
      waiters: [],
      kind,
      closing: false,
    };

    if (kind === "remote") {
      const parsed = parseRemoteServerConfig({ ...server.config, type: "remote" });
      if (!parsed.ok) {
        managed.status = "failed";
        managed.error = parsed.reason;
        this.options.onLog?.("warn", `MCP server '${server.name}' has an invalid remote config: ${parsed.reason}`, {
          serverId: server.serverId,
        });
      } else {
        managed.remote = {
          config: parsed.value,
          fetchFn: createGuardedFetch(parsed.value.url, {
            timeoutMs: parsed.value.timeout,
            onWarn: (message) =>
              this.options.onLog?.("warn", `${server.name}: ${message}`, { serverId: server.serverId }),
          }),
          authorized: hasUsableToken(this.authStore, server.name, parsed.value.url),
        };
      }
    }

    this.servers.set(server.serverId, managed);
    return managed;
  }

  /** The status machine: refuse illegal jumps, log every change. */
  private setStatus(managed: ManagedServer, next: McpServerStatus): void {
    if (managed.status === next) return;
    const previous = managed.status;
    const machine: McpStatusMachine = createStatusMachine(previous);
    if (!machine.transition(next)) {
      // Forced for initial adoption only (e.g. invalid-config failure at load).
      this.options.onLog?.("warn", `MCP status ${previous} → ${next} is not a legal transition`, {
        serverId: managed.server.serverId,
      });
    }
    managed.status = next;
    if (isToolWithdrawingStatus(next) && next !== "connected") {
      // Keep `transport` as the last transport used: diagnostics report which
      // transport a server attempted, not colour the failure.
    }
    this.emit({
      type: "status-changed",
      serverId: managed.server.serverId,
      name: managed.server.name,
      status: next,
      toolCount: managed.tools.length,
    });
  }

  private emit(event: McpServerEvent): void {
    this.options.onEvent?.(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a bad listener must not break the manager */
      }
    }
  }

  private async connectServerInternal(managed: ManagedServer): Promise<boolean> {
    const { server } = managed;
    if (managed.status === "connected") return true;

    if (managed.kind === "remote") {
      return this.connectRemoteInternal(managed);
    }

    this.setStatus(managed, "connecting");
    try {
      const ok = await connectServer(server);
      if (!ok) {
        this.setStatus(managed, "failed");
        managed.error = "connect returned false";
        unregisterMcpTools(server.serverId);
        return false;
      }
    } catch (error) {
      this.setStatus(managed, "failed");
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
      this.setStatus(managed, "failed");
      managed.error = "connected but no active client was registered";
      return false;
    }

    managed.transport = "stdio";
    const raw: RawTool[] = client.tools.map((t) => ({
      name: t.originalName,
      description: t.function.description,
      inputSchema: t.function.parameters,
    }));
    return this.applyTools(managed, raw);
  }

  /** Phase 78.3/78.5 — Streamable HTTP first, SSE fallback, both exclusive. */
  private async connectRemoteInternal(managed: ManagedServer): Promise<boolean> {
    const remote = managed.remote;
    if (!remote) {
      this.setStatus(managed, "failed");
      managed.error = managed.error ?? "remote configuration is invalid";
      unregisterMcpTools(managed.server.serverId);
      return false;
    }

    this.setStatus(managed, "connecting");

    // Bounded refresh before dialing: one attempt, never a loop (Phase 78.15).
    const refreshOutcome = await refreshAccessTokenIfNeeded({
      name: managed.server.name,
      serverUrl: remote.config.url,
      store: this.authStore,
      fetchFn: remote.fetchFn,
      client: remote.config.oauth,
    });
    if (refreshOutcome === "refresh-failed") {
      this.setStatus(managed, "needs_auth");
      managed.error = "stored OAuth refresh token is no longer valid — re-authenticate";
      unregisterMcpTools(managed.server.serverId);
      return false;
    }

    const oauthConfigured = Boolean(remote.config.oauth) ||
      this.authStore.has(managed.server.name) ||
      this.authStore.getTokens(managed.server.name) !== undefined;

    const provider = oauthConfigured
      ? new McpOAuthProvider({
          name: managed.server.name,
          serverUrl: remote.config.url,
          store: this.authStore,
          redirectUrl: remote.config.oauth?.redirectUri ?? "http://127.0.0.1:0/mcp/oauth/callback",
          client: remote.config.oauth,
        })
      : undefined;
    remote.authProvider = provider;

    const { headers, droppedReserved } = mergeRemoteHeaders(remote.config.headers, {});
    if (droppedReserved.length) {
      // Names only — a header value is never logged.
      this.options.onLog?.(
        "warn",
        `MCP server '${managed.server.name}' declares reserved header name(s) that were ignored: ${droppedReserved.join(", ")}`,
        { serverId: managed.server.serverId },
      );
    }

    const result = await connectRemoteServer({
      name: managed.server.name,
      serverId: managed.server.serverId,
      url: remote.config.url,
      timeoutMs: remote.config.timeout,
      headers,
      authProvider: provider,
      fetchFn: remote.fetchFn,
      onToolsChanged: () => {
        void this.refreshRemoteTools(managed);
      },
      onClose: () => {
        void this.handleRemoteClose(managed);
      },
    });

    if (!result.ok) {
      this.setStatus(managed, result.status);
      managed.error = redactRemoteError(result.error);
      unregisterMcpTools(managed.server.serverId);
      managed.tools = [];
      this.options.onLog?.("warn", `MCP server '${managed.server.name}' is ${result.status}: ${managed.error}`, {
        serverId: managed.server.serverId,
      });
      return false;
    }

    remote.connection = result.connection;
    remote.authorized = true;
    managed.transport = result.connection.kind;
    // The SDK's Protocol.connect already wrapped onclose/onerror; assign after
    // connect so the manager observes the drop.
    result.connection.client.onclose = () => {
      void this.handleRemoteClose(managed);
    };
    result.connection.client.onerror = (error) => {
      // Log only: a single protocol hiccup must not withdraw usable tools.
      // Liveness is confirmed by the next call (see `callRemoteTool`).
      this.options.onLog?.(
        "warn",
        `MCP server '${managed.server.name}' transport error: ${redactRemoteError(
          error instanceof Error ? error.message : String(error),
        )}`,
        { serverId: managed.server.serverId },
      );
    };

    const raw = await listRemoteTools(result.connection, MCP_CALL_TIMEOUT_MS);
    return this.applyTools(managed, raw);
  }

  /**
   * Phase 78.5 — re-list tools after `tools/list_changed`: unregister the old
   * generation, register the current one. The agent engine is never restarted
   * and the registry remains the single source of model-visible tools.
   */
  private async refreshRemoteTools(managed: ManagedServer): Promise<void> {
    const connection = managed.remote?.connection;
    if (!connection || managed.closing) return;
    try {
      const raw = await listRemoteTools(connection, MCP_CALL_TIMEOUT_MS);
      const ok = await this.applyTools(managed, raw);
      if (ok) {
        this.emit({
          type: "tools-changed",
          serverId: managed.server.serverId,
          name: managed.server.name,
          status: managed.status,
          toolCount: managed.tools.length,
        });
      }
    } catch (error) {
      this.options.onLog?.(
        "warn",
        `MCP server '${managed.server.name}' tool refresh failed: ${redactRemoteError(
          error instanceof Error ? error.message : String(error),
        )}`,
        { serverId: managed.server.serverId },
      );
    }
  }

  /**
   * Phase 78.6/78.30 — the transport dropped. Withdraw the server's tools so the
   * model cannot keep calling into a dead remote, and keep the process alive.
   */
  private async handleRemoteClose(managed: ManagedServer): Promise<void> {
    if (managed.closing) return;
    if (managed.status === "failed" && !managed.remote?.connection) return;

    managed.remote && (managed.remote.connection = undefined);
    managed.remote && (managed.remote.authorized = false);
    unregisterMcpTools(managed.server.serverId);
    managed.tools = [];
    managed.connectedAt = undefined;
    this.setStatus(managed, "failed");
    managed.error = "connection closed by the remote server";
    this.emit({
      type: "tools-changed",
      serverId: managed.server.serverId,
      name: managed.server.name,
      status: "failed",
      toolCount: 0,
    });
    this.options.onLog?.("warn", `MCP server '${managed.server.name}' disconnected; its tools were withdrawn`, {
      serverId: managed.server.serverId,
    });
  }

  /** Normalize + register one generation of tools. Shared by both transports. */
  private async applyTools(managed: ManagedServer, raw: RawTool[]): Promise<boolean> {
    const { server } = managed;
    const normalized: NormalizedMcpTool[] = [];
    const warnings = new Map<string, string[]>();
    const rejected: string[] = [];

    for (const tool of raw) {
      const result = normalizeMcpToolDefinition(tool);
      if (!result.ok) {
        rejected.push(tool.name);
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

    // Re-registering is safe: unregister the owner first so a reconnect or a
    // tools/list_changed refresh never doubles up or leaves a stale tool.
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
    this.setStatus(managed, "connected");
    managed.error = undefined;
    managed.connectedAt = Date.now();

    this.options.onLog?.("info", `MCP server '${server.name}' connected (${managed.tools.length} tools)`, {
      serverId: server.serverId,
    });
    return true;
  }

  private async stopPendingAuth(managed: ManagedServer): Promise<void> {
    const pending = managed.remote?.pending;
    if (!pending) return;
    managed.remote && (managed.remote.pending = undefined);
    try {
      await pending.server.close();
    } catch {
      /* teardown is best-effort and bounded */
    }
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

    if (managed.kind === "remote") {
      return this.callRemoteTool(managed, toolName, args, signal);
    }

    // Crash isolation: a dead child means the tool is gone, not that the CLI dies.
    const alive = getActiveMcpClients().some((client) => client.serverId === serverId);
    if (!alive) {
      unregisterMcpTools(serverId);
      managed.tools = [];
      this.setStatus(managed, "failed");
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

  /**
   * Remote tool call. Same result envelope, redaction and byte bound as the
   * stdio path, with a dedicated tool-call timeout (Phase 78.18).
   */
  private async callRemoteTool(
    managed: ManagedServer,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const connection = managed.remote?.connection;
    if (!connection || managed.status !== "connected") {
      return JSON.stringify({
        stdout: "",
        stderr: `MCP server '${managed.server.name}' is not active (disconnected or unauthenticated).`,
        exitCode: 1,
        errorCode: "MCP_SERVER_DEAD",
      });
    }

    const policy = readServerPolicy(managed.server.config);
    const released = await this.acquireSlot(managed, policy.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_MCP_CALLS);
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), MCP_CALL_TIMEOUT_MS);
    timer.unref?.();

    try {
      const result = await connection.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { signal: controller.signal },
      );
      const text = extractText(result);
      const redacted = redactSecrets(text);
      const bounded = truncateWithMarker(redacted, MCP_MAX_RESULT_BYTES);
      const isError = Boolean((result as { isError?: boolean }).isError);
      return JSON.stringify({
        stdout: bounded,
        stderr: isError ? bounded : "",
        exitCode: isError ? 1 : 0,
      });
    } catch (error) {
      const message = redactRemoteError(error instanceof Error ? error.message : String(error));
      const timedOut = /abort|timeout/i.test(message);
      if (!timedOut) {
        // A transport-level throw (network failure, closed socket, torn-down
        // session) means the connection is no longer usable. Withdraw the tools
        // so the model cannot keep calling into a dead remote (Phase 78.6/78.30).
        await this.handleRemoteClose(managed);
      }
      return JSON.stringify({
        stdout: "",
        stderr: redactSecrets(`Error executing MCP tool '${toolName}': ${message}`),
        exitCode: 1,
        ...(timedOut ? { errorCode: "MCP_CALL_TIMEOUT" } : {}),
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
      released();
    }
  }

  private find(nameOrId: string): ManagedServer | undefined {
    if (!nameOrId) return undefined;
    const direct = this.servers.get(nameOrId);
    if (direct) return direct;
    return [...this.servers.values()].find((s) => s.server.name === nameOrId);
  }

  private toServerInfo(managed: ManagedServer): McpServerInfo {
    const url = managed.remote?.config.url;
    const authenticated =
      managed.kind === "remote" && url
        ? Boolean(this.authStore.getTokensFor(managed.server.name, url))
        : undefined;
    return {
      serverId: managed.server.serverId,
      name: managed.server.name,
      status: managed.status,
      sourceKind: managed.server.sourceKind,
      sourceFile: managed.server.sourceFile,
      command: managed.server.config.command ?? "",
      ...(url ? { url } : {}),
      kind: managed.kind,
      ...(managed.transport ? { transport: managed.transport } : {}),
      ...(authenticated !== undefined ? { authenticated } : {}),
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

/** Flatten an MCP tool result into text (same shape the stdio path produces). */
function extractText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) {
    return typeof result === "object" ? JSON.stringify(result) : String(result);
  }
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
    } else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
      else parts.push(JSON.stringify(item));
    }
  }
  return parts.join("\n") || (typeof result === "object" ? JSON.stringify(result) : String(result));
}

/** Access tokens currently stored for a server (never printed). */
export function getStoredTokens(serverName: string): McpAuthTokens | undefined {
  return mcpAuthStore.getTokens(serverName);
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
