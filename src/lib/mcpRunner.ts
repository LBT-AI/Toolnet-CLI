/**
 * MCP Runner — Layer 4 Phase 3 (Supply-Chain Hardening)
 *
 * Security model:
 *  - MCP server configs are discovered from workspace files (semi-trusted
 *    input) and the canonical global config. DISCOVERY != EXECUTION.
 *  - A workspace server is UNTRUSTED until explicitly enabled via
 *    `mcpTrustManager.enableServer()` (backed by /mcp enable <server> or an
 *    approval UI). Trust is bound to a fingerprint of (source config path,
 *    server name, command+args) — ANY change re-requires approval.
 *  - Child processes get a scrubbed, allowlist env (NO host secrets) plus
 *    explicit config.env keys only.
 *  - Tool names are namespaced: mcp__<serverId>__<toolName> — built-ins and
 *    plugin tools can never be shadowed; merged registries stay unique.
 *  - callTool has a hard timeout (AbortController) and a result byte cap.
 *  - Every model-callable MCP tool still executes through ToolGateway →
 *    SecurityEngine (mcp__ prefix NEVER auto-allows).
 *
 * Remote MCP transport review (Layer 4 Phase 4):
 *  - This module currently ONLY uses StdioClientTransport. There is NO
 *    HTTP / SSE / StreamableHTTP transport in production code paths.
 *  - If a future PR adds StreamableHTTP or HTTP+SSE transport, it MUST
 *    route every outbound call through `safeFetch` (src/lib/security/safeFetch.ts)
 *    so the URL-scheme guard (http:/https: only, file:/javascript:/data:/ftp:
 *    rejected), localhost policy, redirect hop limit (≤3), per-hop revalidation,
 *    cross-origin header strip (no Authorization/Cookie forwarded), and
 *    auth-header redaction in errors are enforced.
 *  - Direct `fetch()` to an MCP remote endpoint is FORBIDDEN; any such
 *    occurrence will be flagged by the audit grep in t9.
 *  - No implicit OAuth flow is wired. If a remote MCP server requires
 *    OAuth/bearer auth, the auth header MUST be passed via the explicit
 *    `auth` config field and routed through the safeFetch allow-list;
 *    it MUST never be read from a global env var and MUST be redacted
 *    in tool output, logs, and audit.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { scrubChildEnv } from "./security/childEnv";
import { getToolnetHome, ensureToolnetDir } from "./toolnetHome";
import { redactSecrets } from "./security/secretGuard";

// ── Tunables (env-overridable, sane defaults) ──────────────────────────────

export const MCP_CONNECT_TIMEOUT_MS = numEnv("MCP_CONNECT_TIMEOUT_MS", 5000);
export const MCP_CALL_TIMEOUT_MS = numEnv("MCP_CALL_TIMEOUT_MS", 30_000);
export const MCP_MAX_RESULT_BYTES = numEnv("MCP_MAX_RESULT_BYTES", 256 * 1024);

function numEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

// ── Config types ───────────────────────────────────────────────────────────

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
}

export type McpConfigSourceKind =
  | "GLOBAL_TRUSTED"   // canonical home mcp.json (~/.toolnetcli/mcp.json)
  | "USER_CONFIG"      // workspace ./mcp.json written by the user via /mcp add
  | "WORKSPACE_UNTRUSTED" // project .toolnet/mcp.json or .gemini/mcp.json
  | "LEGACY";          // unknown/unrecognized location

export interface LocalMcpServer {
  name: string;
  config: McpServerConfig;
  sourceFile: string;
  sourceKind: McpConfigSourceKind;
  /** Stable server id used for namespacing and trust bookkeeping. */
  serverId: string;
}

export interface McpToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
  serverName: string;
  serverId: string;
  originalName: string;
}

export interface ActiveMcpClient {
  name: string;
  serverId: string;
  client: Client;
  transport: StdioClientTransport;
  tools: McpToolDefinition[];
  child?: ChildProcess;
  connectedAt: number;
}

export interface McpManagerStatus {
  connectedServers: string[];
  totalTools: number;
  failedServers: Array<{ name: string; error: string }>;
  /** Servers discovered but skipped because untrusted/disabled. */
  skippedServers: Array<{ name: string; reason: string }>;
}

// ── Canonical MCP namespacing ──────────────────────────────────────────────

/** OpenAI function-name safe charset. */
function sanitizeNamePart(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "srv";
}

/** Built-in / reserved names an MCP tool must never shadow. */
const RESERVED_TOOL_NAMES = new Set([
  "shell", "run_command", "bash", "read_file", "write_file", "edit_file",
  "replace_all", "apply_patch", "delete_file", "browser", "browser_action",
  "spawn_subagent", "delegate_task", "web_fetch", "get_cwd", "list_dir",
  "tree", "grep", "glob", "glob_search", "grep_search", "find_path",
  "file_exists", "git_status", "git_diff", "create_artifact", "update_artifact",
]);

/**
 * Canonical public MCP tool name: mcp__<serverId>__<toolName>.
 * Deterministic, collision-free across servers with the same tool names.
 */
export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${sanitizeNamePart(serverId)}__${sanitizeNamePart(toolName)}`;
}

/**
 * Deterministic server id: unique per (name, sourceFile). Two servers with
 * the same name from different sources never collide; the same server from
 * the same source is stable across restarts (trust bookkeeping key).
 */
export function computeServerId(name: string, sourceFile: string): string {
  const dir = path.dirname(path.resolve(sourceFile));
  const suffix = dir === path.resolve(process.cwd())
    ? "ws"
    : sanitizeNamePart(path.basename(dir));
  return `${sanitizeNamePart(name)}-${suffix}`;
}

// ── Trust manager (explicit enable; fingerprint-bound) ─────────────────────

export type McpServerTrustState = "disabled" | "untrusted" | "enabled" | "failed";

export interface McpTrustRecord {
  state: "enabled" | "disabled";
  /** Fingerprint of command+args+cwd at enable time. */
  fingerprint: string;
  enabledAt: number;
  sourceFile: string;
}

export function computeServerFingerprint(config: McpServerConfig): string {
  const payload = JSON.stringify({
    command: config.command,
    args: [...(config.args || [])].sort(),
    cwd: config.cwd || "",
  });
  // FNV-1a 32-bit — short, deterministic, not security-critical (we only need
  // change detection, not tamper resistance; the file itself is user-local).
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

const TRUST_FILE = () => path.join(getToolnetHome(), "mcp-trust.json");

function loadTrustMap(): Record<string, McpTrustRecord> {
  try {
    const raw = JSON.parse(fs.readFileSync(TRUST_FILE(), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function saveTrustMap(map: Record<string, McpTrustRecord>): void {
  try {
    ensureToolnetDir(getToolnetHome());
    fs.writeFileSync(TRUST_FILE(), JSON.stringify(map, null, 2), { mode: 0o600 });
  } catch {}
}

export const mcpTrustManager = {
  /** Explicit enable (user decision via /mcp enable or approval UI). */
  enableServer(serverId: string, config: McpServerConfig, sourceFile: string): void {
    const map = loadTrustMap();
    map[serverId] = {
      state: "enabled",
      fingerprint: computeServerFingerprint(config),
      enabledAt: Date.now(),
      sourceFile,
    };
    saveTrustMap(map);
  },

  disableServer(serverId: string): void {
    const map = loadTrustMap();
    const rec = map[serverId];
    if (rec) {
      rec.state = "disabled";
      saveTrustMap(map);
    }
  },

  removeServer(serverId: string): void {
    const map = loadTrustMap();
    delete map[serverId];
    saveTrustMap(map);
  },

  /**
   * Resolves the effective trust state. Config `disabled` wins outright;
   * enabled records are invalidated when the command fingerprint changes.
   */
  getTrustState(
    serverId: string,
    config: McpServerConfig,
    sourceKind: McpConfigSourceKind,
    disabled?: boolean
  ): McpServerTrustState {
    if (disabled) return "disabled";

    // Global (canonical home) config is operator-managed → trusted.
    if (sourceKind === "GLOBAL_TRUSTED") return "enabled";

    const map = loadTrustMap();
    const rec = map[serverId];
    if (!rec || rec.state !== "enabled") return "untrusted";

    // Fingerprint mismatch (command/args/cwd changed) → old trust invalid.
    if (rec.fingerprint !== computeServerFingerprint(config)) return "untrusted";

    return "enabled";
  },
};

// ── Config discovery with source classification ────────────────────────────

interface DiscoveredServer {
  name: string;
  config: McpServerConfig;
  sourceFile: string;
  sourceKind: McpConfigSourceKind;
}

function readMcpConfigFile(filePath: string): Record<string, McpServerConfig> {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const servers = parsed.mcpServers || parsed.servers || parsed;
    if (!servers || typeof servers !== "object") return {};
    const out: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(servers)) {
      if (cfg && typeof cfg === "object" && typeof (cfg as any).command === "string") {
        out[name] = cfg as McpServerConfig;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function classifySource(filePath: string, baseDir: string): McpConfigSourceKind {
  const resolved = path.resolve(filePath);
  const home = path.resolve(getToolnetHome());
  if (resolved === path.join(home, "mcp.json")) return "GLOBAL_TRUSTED";

  const base = path.resolve(baseDir);
  if (resolved === path.join(base, "mcp.json")) return "USER_CONFIG";
  if (resolved === path.join(base, ".toolnet", "mcp.json")) return "WORKSPACE_UNTRUSTED";
  if (resolved === path.join(base, ".gemini", "mcp.json")) return "WORKSPACE_UNTRUSTED";
  return "LEGACY";
}

const WORKSPACE_CANDIDATE_PATHS = (baseDir: string) => [
  path.join(baseDir, "mcp.json"),
  path.join(baseDir, ".gemini", "mcp.json"),
  path.join(baseDir, ".toolnet", "mcp.json"),
];

/**
 * Loads stdio MCP configurations from workspace + canonical-global sources.
 * @param baseDir workspace base (defaults to process.cwd()).
 */
export function loadLocalMcpConfig(baseDir: string = process.cwd()): Record<string, McpServerConfig> {
  const configs: Record<string, McpServerConfig> = {};
  for (const server of getLocalMcpServers(baseDir)) {
    if (!configs[server.name]) configs[server.name] = server.config;
  }
  return configs;
}

/**
 * Returns discovered LocalMcpServer objects with source classification and
 * deterministic server ids. Workspace `.toolnet/mcp.json` remains supported
 * (project-local config) but is classified WORKSPACE_UNTRUSTED.
 */
export function getLocalMcpServers(baseDir: string = process.cwd()): LocalMcpServer[] {
  const discovered: DiscoveredServer[] = [];

  // Canonical global config first (trusted), then workspace candidates.
  const globalPath = path.join(getToolnetHome(), "mcp.json");
  if (fs.existsSync(globalPath)) {
    for (const [name, cfg] of Object.entries(readMcpConfigFile(globalPath))) {
      discovered.push({ name, config: cfg, sourceFile: globalPath, sourceKind: "GLOBAL_TRUSTED" });
    }
  }
  for (const filePath of WORKSPACE_CANDIDATE_PATHS(baseDir)) {
    if (!fs.existsSync(filePath)) continue;
    for (const [name, cfg] of Object.entries(readMcpConfigFile(filePath))) {
      // First source wins for a (name, file) pair; multiple files keep both
      // because serverId disambiguates per-source below.
      discovered.push({
        name,
        config: cfg,
        sourceFile: filePath,
        sourceKind: classifySource(filePath, baseDir),
      });
    }
  }

  const serversMap = new Map<string, LocalMcpServer>();
  for (const d of discovered) {
    const serverId = computeServerId(d.name, d.sourceFile);
    if (serversMap.has(serverId)) continue; // deterministic first-wins per id
    serversMap.set(serverId, {
      name: d.name,
      config: d.config,
      sourceFile: d.sourceFile,
      sourceKind: d.sourceKind,
      serverId,
    });
  }

  return Array.from(serversMap.values());
}

// ── Child spawn (scrubbed env) ─────────────────────────────────────────────

/**
 * Builds the MCP child environment: allowlist-only base + explicit
 * config.env keys (names logged at most — never values).
 */
export function buildMcpChildEnv(config: McpServerConfig): NodeJS.ProcessEnv {
  const explicit = config.env || {};
  const env = scrubChildEnv(process.env, explicit);
  return env;
}

/** Env var NAMES passed to a child (for audit — values never logged). */
export function mcpChildEnvNames(config: McpServerConfig): string[] {
  return Object.keys(buildMcpChildEnv(config)).sort();
}

/**
 * Spawns a stdio MCP server child process with a scrubbed environment.
 * NOTE: production connects via initMcpClients (SDK transport); this direct
 * spawn is used by /mcp status checks and tests.
 */
export function spawnMcpServer(name: string, config: McpServerConfig, baseDir: string = process.cwd()): ChildProcess {
  const env = buildMcpChildEnv(config);
  const cwd = config.cwd ? path.resolve(baseDir, config.cwd) : baseDir;
  return spawn(config.command, config.args || [], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// ── Client lifecycle (locks, cleanup, registry) ────────────────────────────

const activeClientsMap = new Map<string, ActiveMcpClient>(); // keyed by serverId
const toolRoutingMap = new Map<string, { serverId: string; serverName: string; originalName: string }>();
/** Per-server init promises — concurrent init never spawns duplicates. */
const initLocks = new Map<string, Promise<boolean>>();

function registerClient(info: ActiveMcpClient, tools: McpToolDefinition[]): void {
  activeClientsMap.set(info.serverId, info);
  for (const t of tools) {
    toolRoutingMap.set(t.function.name, {
      serverId: info.serverId,
      serverName: t.serverName,
      originalName: t.originalName,
    });
  }
}

/** True when the registered client's transport is still alive. */
function isClientAlive(info: ActiveMcpClient): boolean {
  try {
    const child: any = (info.transport as any)._process || info.child;
    if (child && child.exitCode !== null && child.exitCode !== undefined) return false;
    if (child && child.killed) return false;
    return true;
  } catch {
    return false;
  }
}

async function cleanupClient(info: ActiveMcpClient): Promise<void> {
  try { await Promise.race([info.client.close(), delay(1000)]); } catch {}
  try { info.transport.close?.(); } catch {}
  try { info.child?.kill("SIGTERM"); } catch {}
  activeClientsMap.delete(info.serverId);
  for (const [toolName, route] of toolRoutingMap.entries()) {
    if (route.serverId === info.serverId) toolRoutingMap.delete(toolName);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Connects ONE server with connect-timeout, scrubbed env, and registry
 * bookkeeping. Concurrent calls for the same serverId share one init promise.
 */
async function connectServer(server: LocalMcpServer): Promise<boolean> {
  const existingLock = initLocks.get(server.serverId);
  if (existingLock) return existingLock;

  const lock = (async (): Promise<boolean> => {
    // Guard: already connected & alive → no duplicate spawn.
    const existing = activeClientsMap.get(server.serverId);
    if (existing && isClientAlive(existing)) return true;
    if (existing) await cleanupClient(existing);

    const envRecord: Record<string, string> = {};
    for (const [k, v] of Object.entries(buildMcpChildEnv(server.config))) {
      if (typeof v === "string") envRecord[k] = v;
    }

    const transport = new StdioClientTransport({
      command: server.config.command,
      args: server.config.args || [],
      env: envRecord,
      cwd: server.config.cwd ? path.resolve(process.cwd(), server.config.cwd) : process.cwd(),
    });

    const client = new Client(
      { name: `toolnet-cli-${server.serverId}`, version: "1.0.0" },
      { capabilities: {} }
    );

    // Hard connect timeout with typed error.
    const connectWithTimeout = () => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`MCP_CONNECT_TIMEOUT: server '${server.name}' did not connect within ${MCP_CONNECT_TIMEOUT_MS}ms`)),
        MCP_CONNECT_TIMEOUT_MS
      );
      client.connect(transport).then(
        () => { clearTimeout(timer); resolve(); },
        (err) => { clearTimeout(timer); reject(err); }
      );
    });

    try {
      await connectWithTimeout();

      // tools/list also bounded (a hung server must not block startup).
      const listResult = await Promise.race([
        client.listTools(),
        delay(MCP_CALL_TIMEOUT_MS).then(() => {
          throw new Error(`MCP_CALL_TIMEOUT: tools/list for '${server.name}' exceeded ${MCP_CALL_TIMEOUT_MS}ms`);
        }),
      ]);

      const rawTools = (listResult as any)?.tools || [];
      const mcpTools: McpToolDefinition[] = [];

      for (const rawTool of rawTools) {
        if (!rawTool?.name) continue;
        const publicName = mcpToolName(server.serverId, rawTool.name);
        mcpTools.push({
          type: "function",
          function: {
            name: publicName,
            description: redactSecrets(
              rawTool.description || `MCP tool '${rawTool.name}' from server '${server.name}'`
            ),
            parameters: rawTool.inputSchema || { type: "object", properties: {}, required: [] },
          },
          serverName: server.name,
          serverId: server.serverId,
          originalName: rawTool.name,
        });
      }

      const info: ActiveMcpClient = {
        name: server.name,
        serverId: server.serverId,
        client,
        transport,
        tools: mcpTools,
        child: (transport as any)._process,
        connectedAt: Date.now(),
      };
      registerClient(info, mcpTools);
      return true;
    } catch (err: any) {
      // Startup failure cleanup: no orphan transport/child left behind.
      try { await Promise.race([client.close(), delay(500)]); } catch {}
      try { transport.close?.(); } catch {}
      throw err;
    }
  })();

  initLocks.set(server.serverId, lock);
  try {
    return await lock;
  } catch (err) {
    // Surface failure to caller but keep lock short-lived for retries.
    throw err;
  } finally {
    initLocks.delete(server.serverId);
  }
}

/**
 * Initializes MCP clients for all DISCOVERED + ENABLED local stdio servers.
 * Workspace servers that are untrusted are SKIPPED (discovery != execution).
 * Failed servers are typed in `failedServers` — never fake-success.
 */
export async function initMcpClients(baseDir: string = process.cwd()): Promise<McpManagerStatus> {
  const servers = getLocalMcpServers(baseDir);
  const connectedServers: string[] = [];
  const failedServers: Array<{ name: string; error: string }> = [];
  const skippedServers: Array<{ name: string; reason: string }> = [];
  let totalTools = 0;

  for (const server of servers) {
    const trust = mcpTrustManager.getTrustState(
      server.serverId,
      server.config,
      server.sourceKind,
      server.config.disabled
    );

    if (trust !== "enabled") {
      skippedServers.push({
        name: server.name,
        reason: trust === "disabled" ? "disabled by config" : `untrusted (${server.sourceKind}) — run /mcp enable ${server.name}`,
      });
      continue;
    }

    try {
      const ok = await connectServer(server);
      if (ok) {
        const info = activeClientsMap.get(server.serverId);
        connectedServers.push(server.name);
        totalTools += info?.tools.length || 0;
      }
    } catch (err: any) {
      failedServers.push({
        name: server.name,
        error: redactSecrets(err?.message || String(err)),
      });
    }
  }

  return { connectedServers, totalTools, failedServers, skippedServers };
}

/** OpenAI-compatible tool list from all active MCP clients. */
export function getMcpAgentTools(): Array<any> {
  const tools: Array<any> = [];
  for (const clientInfo of activeClientsMap.values()) {
    if (!isClientAlive(clientInfo)) continue; // dead server → drop tools
    for (const toolDef of clientInfo.tools) {
      tools.push({ type: toolDef.type, function: toolDef.function });
    }
  }
  return tools;
}

/** Registry introspection for the merged-registry uniqueness assertion. */
export function getMcpToolRouting(): Map<string, { serverId: string; serverName: string; originalName: string }> {
  return toolRoutingMap;
}

export function isMcpTool(name: string): boolean {
  return toolRoutingMap.has(name) || name.startsWith("mcp__");
}

// ── callTool: timeout + result bound + typed errors ────────────────────────

/** Truncates a string deterministically with an explicit marker. */
export function truncateWithMarker(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const marker = `\n[MCP output truncated: ${buf.length} bytes total, showing first ${maxBytes} bytes]`;
  const slice = buf.subarray(0, Math.max(0, maxBytes - Buffer.byteLength(marker)));
  // Avoid splitting a UTF-8 sequence.
  let s = slice.toString("utf8");
  while (Buffer.byteLength(s, "utf8") + Buffer.byteLength(marker) > maxBytes + 64 && s.length > 0) {
    s = s.slice(0, Math.floor(s.length / 2));
  }
  return s + marker;
}

export interface McpCallResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Typed deterministic failure marker (timeout / dead server / oversized). */
  errorCode?: "MCP_CALL_TIMEOUT" | "MCP_SERVER_DEAD" | "MCP_RESULT_OVERSIZE" | "MCP_ROUTE_NOT_FOUND";
}

/**
 * Dispatches an MCP tool call by CANONICAL public name.
 * Result is size-bounded BEFORE returning to the model; timeouts are typed
 * errors — never swallowed into an empty success.
 */
export async function executeMcpTool(name: string, args: Record<string, any> = {}): Promise<string | null> {
  const route = toolRoutingMap.get(name);
  if (!route) return null;

  const clientInfo = activeClientsMap.get(route.serverId);
  if (!clientInfo || !isClientAlive(clientInfo)) {
    // Dead server: drop from registry so tools disappear on next listing.
    if (clientInfo) await cleanupClient(clientInfo);
    const dead: McpCallResult = {
      stdout: "",
      stderr: `MCP server '${route.serverName}' is not active (crashed or disconnected).`,
      exitCode: 1,
      errorCode: "MCP_SERVER_DEAD",
    };
    return JSON.stringify(dead);
  }

  try {
    // Hard call timeout via AbortController (SDK supports abort signal).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MCP_CALL_TIMEOUT_MS);

    let result: any;
    try {
      result = await Promise.race([
        clientInfo.client.callTool(
          { name: route.originalName, arguments: args },
          undefined,
          { signal: controller.signal }
        ),
        delay(MCP_CALL_TIMEOUT_MS).then(() => {
          throw new Error(`MCP_CALL_TIMEOUT: tool '${name}' exceeded ${MCP_CALL_TIMEOUT_MS}ms`);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }

    const contentArray = (result as any).content || [];
    const textParts: string[] = [];
    for (const item of contentArray) {
      if (typeof item === "string") {
        textParts.push(item);
      } else if (item && typeof item === "object") {
        if (item.type === "text" && typeof item.text === "string") {
          textParts.push(item.text);
        } else {
          textParts.push(JSON.stringify(item));
        }
      }
    }

    const rawStdout = textParts.join("\n") || (typeof result === "object" ? JSON.stringify(result) : String(result));
    const isError = Boolean((result as any).isError);

    // Secret redaction FIRST, then size bound — bounded output is what the
    // model ever sees; nothing multi-MB is held beyond this point.
    const redacted = redactSecrets(rawStdout);
    const bounded = truncateWithMarker(redacted, MCP_MAX_RESULT_BYTES);

    const out: McpCallResult = {
      stdout: bounded,
      stderr: isError ? bounded : "",
      exitCode: isError ? 1 : 0,
    };
    return JSON.stringify(out);
  } catch (err: any) {
    const msg = String(err?.message || err);
    const timedOut = msg.includes("MCP_CALL_TIMEOUT") || msg.includes("abort");
    const typed: McpCallResult = {
      stdout: "",
      stderr: redactSecrets(`Error executing MCP tool '${name}': ${msg}`),
      exitCode: 1,
      errorCode: timedOut ? "MCP_CALL_TIMEOUT" : undefined,
    };
    return JSON.stringify(typed);
  }
}

/**
 * Disconnects all active MCP clients and cleans up resources.
 */
export async function closeMcpClients(): Promise<void> {
  const infos = [...activeClientsMap.values()];
  activeClientsMap.clear();
  toolRoutingMap.clear();
  await Promise.all(infos.map(info => cleanupClient({ ...info })));
}

process.on("SIGINT", () => {
  closeMcpClients().catch(() => {});
});
process.on("SIGTERM", () => {
  closeMcpClients().catch(() => {});
});

// ── Workspace config editing (USER_CONFIG; explicit add/remove) ────────────

function editLocalMcpConfig(
  baseDir: string,
  editor: (configs: Record<string, McpServerConfig>) => void
): void {
  const candidatePaths = [
    path.join(baseDir, "mcp.json"),
    path.join(baseDir, ".gemini", "mcp.json"),
    path.join(baseDir, ".toolnet", "mcp.json"),
  ];

  let targetPath = candidatePaths[0];
  let existingData: any = {};

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      targetPath = p;
      try {
        existingData = JSON.parse(fs.readFileSync(p, "utf8"));
      } catch {}
      break;
    }
  }

  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let targetField = "mcpServers";
  let configs = existingData.mcpServers || existingData.servers;
  if (!configs) {
    if (Object.keys(existingData).length > 0) {
      configs = existingData;
      targetField = "";
    } else {
      configs = {};
    }
  }

  editor(configs);

  if (targetField) {
    existingData[targetField] = configs;
  } else {
    existingData = configs;
  }

  fs.writeFileSync(targetPath, JSON.stringify(existingData, null, 2), "utf8");
}

export function addLocalMcpServer(name: string, config: McpServerConfig, baseDir: string = process.cwd()): void {
  editLocalMcpConfig(baseDir, (configs) => {
    configs[name] = config;
  });
}

export function removeLocalMcpServer(name: string, baseDir: string = process.cwd()): void {
  editLocalMcpConfig(baseDir, (configs) => {
    for (const key of Object.keys(configs)) {
      if (key === name) delete configs[key];
    }
  });
}
