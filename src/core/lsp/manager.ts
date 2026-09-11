/**
 * Phase 74 — Canonical LSP manager.
 *
 * One manager per workspace. It is the only component that spawns language
 * servers, and it does so lazily: a server starts the first time code
 * intelligence is requested for a file it covers, is reused for every later
 * call, and is shut down when the workspace/session ends.
 *
 * Guarantees that matter to the agent:
 *   - a missing or crashing server is recorded as "broken" and never retried in
 *     a tight loop;
 *   - every call is bounded by a timeout and honours an `AbortSignal`;
 *   - no failure here ever throws into the agent loop — callers get an empty
 *     result plus an availability reason and fall back to grep/read_file.
 */

import type { ToolExecutionContext } from "../../lib/security/types";
import { extensionOf } from "./languages";
import { LspClient } from "./client";
import { LSP_SERVERS, findServerRoot, resolveServerBinary, selectServerForFile, pickProbeFile } from "./servers";
import { spawnStdioServer } from "./transport";
import type {
  Availability,
  DiagnosticItem,
  HoverInfo,
  Location,
  LspLogger,
  LspServerSpec,
  LspTimeouts,
  Position,
  RequestOptions,
  SpawnedServer,
  SymbolInfo,
} from "./types";
import { DEFAULT_LSP_TIMEOUTS } from "./types";

const noopLogger: LspLogger = { debug() {}, warn() {} };

export type SpawnServerFn = (
  spec: LspServerSpec,
  root: string
) => Promise<SpawnedServer | undefined> | SpawnedServer | undefined;

export interface LspManagerOptions {
  workspaceRoot: string;
  cwd?: string;
  servers?: LspServerSpec[];
  timeouts?: Partial<LspTimeouts>;
  logger?: LspLogger;
  /** Test seam: replaces the stdio launch with an in-memory server. */
  spawnServer?: SpawnServerFn;
  /** Test seam: overrides binary discovery. */
  resolveBinary?: (spec: LspServerSpec, root: string) => string | undefined;
  /** Test seam: deterministic clock. */
  now?: () => number;
  signal?: AbortSignal;
  /** Symbol query cache TTL (ms). */
  symbolCacheTtlMs?: number;
}

export class LspManager {
  private readonly workspaceRoot: string;
  private readonly cwd: string;
  private readonly servers: LspServerSpec[];
  private readonly timeouts: LspTimeouts;
  private readonly logger: LspLogger;
  private readonly now: () => number;
  private readonly signal?: AbortSignal;
  private readonly symbolCacheTtlMs: number;

  private readonly resolveBinary: (spec: LspServerSpec, root: string) => string | undefined;
  private readonly spawnServer: SpawnServerFn;
  /** True when a test seam replaced the stdio launcher. */
  private readonly hasCustomSpawn: boolean;

  private readonly clients = new Map<string, LspClient>();
  private readonly spawning = new Map<string, Promise<LspClient | undefined>>();
  private readonly broken = new Set<string>();
  private readonly symbolCache = new Map<string, { expiresAt: number; value: SymbolInfo[] }>();
  /**
   * Set by `shutdown()`. A disposed workspace must not silently respawn a
   * language server: a late tool call would otherwise leak a process after the
   * session it belonged to is gone.
   */
  private disposed = false;

  constructor(options: LspManagerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.cwd = options.cwd ?? options.workspaceRoot;
    this.servers = options.servers ?? LSP_SERVERS;
    this.timeouts = { ...DEFAULT_LSP_TIMEOUTS, ...(options.timeouts ?? {}) };
    this.logger = options.logger ?? noopLogger;
    this.now = options.now ?? (() => Date.now());
    this.signal = options.signal;
    this.symbolCacheTtlMs = options.symbolCacheTtlMs ?? 15000;

    this.hasCustomSpawn = typeof options.spawnServer === "function";
    this.resolveBinary =
      options.resolveBinary ??
      ((spec, root) => resolveServerBinary(spec, { root, workspaceRoot: this.workspaceRoot }));
    this.spawnServer =
      options.spawnServer ??
      ((spec, root) => {
        const binary = this.resolveBinary(spec, root);
        if (!binary) return undefined;
        return spawnStdioServer(binary, spec.args, { cwd: root });
      });
  }

  // ── Discovery ─────────────────────────────────────────────────────────────

  /** Whether code intelligence is available for a file, without spawning. */
  availability(filePath: string): Availability {
    const spec = selectServerForFile(filePath, this.servers);
    if (!spec) {
      const ext = extensionOf(filePath);
      return { available: false, reason: `No language server configured for "${ext || filePath}"` };
    }

    const root = findServerRoot(spec, filePath, this.workspaceRoot);
    const key = this.clientKey(spec, root);

    if (this.broken.has(key)) {
      return { available: false, serverId: spec.id, reason: `Language server "${spec.id}" failed to start` };
    }

    const client = this.clients.get(key);
    if (client && !client.isClosed) return { available: true, serverId: spec.id };

    if (this.hasCustomSpawn) return { available: true, serverId: spec.id };

    const binary = this.resolveBinary(spec, root);
    if (!binary) {
      return {
        available: false,
        serverId: spec.id,
        reason: `Language server binary not found (tried: ${spec.binaries.join(", ")})`,
      };
    }

    return { available: true, serverId: spec.id };
  }

  /** True when a client is already running for this file — never spawns. */
  hasActiveClient(filePath: string): boolean {
    const spec = selectServerForFile(filePath, this.servers);
    if (!spec) return false;
    const root = findServerRoot(spec, filePath, this.workspaceRoot);
    const client = this.clients.get(this.clientKey(spec, root));
    return Boolean(client && !client.isClosed);
  }

  activeClients(): Array<{ serverId: string; root: string }> {
    return [...this.clients.values()]
      .filter((client) => !client.isClosed)
      .map((client) => ({ serverId: client.serverId, root: client.root }));
  }

  // ── Operations ────────────────────────────────────────────────────────────

  async definition(filePath: string, position: Position, options: RequestOptions = {}): Promise<Location[]> {
    const client = await this.getClient(filePath);
    if (!client) return [];
    return client.definition(filePath, position, this.withDefaults(options));
  }

  async references(filePath: string, position: Position, options: RequestOptions = {}): Promise<Location[]> {
    const client = await this.getClient(filePath);
    if (!client) return [];
    return client.references(filePath, position, this.withDefaults(options));
  }

  async hover(filePath: string, position: Position, options: RequestOptions = {}): Promise<HoverInfo | undefined> {
    const client = await this.getClient(filePath);
    if (!client) return undefined;
    return client.hover(filePath, position, this.withDefaults(options));
  }

  async documentSymbols(filePath: string, options: RequestOptions = {}): Promise<SymbolInfo[]> {
    const cacheKey = `doc::${filePath}`;
    const cached = this.readCache(cacheKey);
    if (cached) return cached;

    const client = await this.getClient(filePath);
    if (!client) return [];
    const symbols = await client.documentSymbols(filePath, this.withDefaults(options));
    this.writeCache(cacheKey, symbols);
    return symbols;
  }

  async workspaceSymbols(query: string, options: RequestOptions = {}): Promise<SymbolInfo[]> {
    const cacheKey = `ws::${query}`;
    const cached = this.readCache(cacheKey);
    if (cached) return cached;

    const clients = await this.ensureClients();
    const results = await Promise.all(
      clients.map((client) => client.workspaceSymbols(query, this.withDefaults(options)))
    );
    const symbols = results.flat();
    this.writeCache(cacheKey, symbols);
    return symbols;
  }

  async diagnostics(filePath: string, options: RequestOptions = {}): Promise<DiagnosticItem[]> {
    const client = await this.getClient(filePath);
    if (!client) return [];
    return client.diagnostics(filePath, this.withDefaults(options));
  }

  /**
   * Drop cached symbol results. Called after a mutation so a rename is not
   * answered from a stale index.
   */
  invalidate(filePath?: string): void {
    if (filePath) this.symbolCache.delete(`doc::${filePath}`);
    for (const key of [...this.symbolCache.keys()]) {
      if (key.startsWith("ws::")) this.symbolCache.delete(key);
    }
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.spawning.clear();
    this.symbolCache.clear();
    await Promise.all(
      clients.map(async (client) => {
        try {
          await client.shutdown();
        } catch {
          // Shutdown is best effort; the process is killed by the transport.
        }
      })
    );
  }

  /**
   * Availability for a workspace-scoped query (no explicit file). Uses an
   * active client when one exists, otherwise probes for a representative file.
   */
  probeAvailability(): Availability {
    const active = this.activeClients();
    if (active.length > 0) return { available: true, serverId: active[0].serverId };
    const probe = pickProbeFile(this.workspaceRoot, this.servers);
    if (!probe) return { available: false, reason: "No supported source files found in the workspace" };
    return this.availability(probe);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private clientKey(spec: LspServerSpec, root: string): string {
    return `${root}::${spec.id}`;
  }

  private withDefaults(options: RequestOptions): RequestOptions {
    return {
      timeoutMs: options.timeoutMs ?? this.timeouts.requestMs,
      signal: options.signal ?? this.signal,
    };
  }

  private async getClient(filePath: string): Promise<LspClient | undefined> {
    if (this.disposed) return undefined;
    const spec = selectServerForFile(filePath, this.servers);
    if (!spec) return undefined;

    const root = findServerRoot(spec, filePath, this.workspaceRoot);
    const key = this.clientKey(spec, root);

    const existing = this.clients.get(key);
    if (existing && !existing.isClosed) return existing;
    if (this.broken.has(key)) return undefined;

    const inflight = this.spawning.get(key);
    if (inflight) return inflight;

    const task = this.startClient(spec, root, key);
    this.spawning.set(key, task);
    void task.finally(() => {
      if (this.spawning.get(key) === task) this.spawning.delete(key);
    });
    return task;
  }

  private async startClient(spec: LspServerSpec, root: string, key: string): Promise<LspClient | undefined> {
    try {
      const spawned = await this.spawnServer(spec, root);
      if (!spawned) {
        this.broken.add(key);
        this.logger.warn("lsp.binary_missing", { serverId: spec.id, root });
        return undefined;
      }

      const client = new LspClient({
        serverId: spec.id,
        root,
        workspaceRoot: this.workspaceRoot,
        transport: spawned.transport,
        initialization: spawned.initialization,
        processId: spawned.processId,
        timeouts: this.timeouts,
        now: this.now,
        signal: this.signal,
      });

      await client.start();
      this.clients.set(key, client);
      this.logger.debug("lsp.started", { serverId: spec.id, root });
      return client;
    } catch (error) {
      this.broken.add(key);
      this.logger.warn("lsp.start_failed", { serverId: spec.id, error: (error as Error).message });
      return undefined;
    }
  }

  /** Clients for a workspace-scoped query; probes the workspace when idle. */
  private async ensureClients(): Promise<LspClient[]> {
    const active = [...this.clients.values()].filter((client) => !client.isClosed);
    if (active.length > 0) return active;

    const probe = pickProbeFile(this.workspaceRoot, this.servers);
    if (!probe) return [];

    const client = await this.getClient(probe);
    return client ? [client] : [];
  }

  private readCache(key: string): SymbolInfo[] | undefined {
    const entry = this.symbolCache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.symbolCache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  private writeCache(key: string, value: SymbolInfo[]): void {
    this.symbolCache.set(key, { expiresAt: this.now() + this.symbolCacheTtlMs, value });
  }
}

// ── Workspace-scoped singleton ──────────────────────────────────────────────

const managers = new Map<string, LspManager>();

export function getLspManager(options: {
  workspaceRoot: string;
  cwd?: string;
  logger?: LspLogger;
}): LspManager {
  const key = options.workspaceRoot;
  const existing = managers.get(key);
  if (existing) return existing;
  const manager = new LspManager({ workspaceRoot: options.workspaceRoot, cwd: options.cwd, logger: options.logger });
  managers.set(key, manager);
  return manager;
}

/** Resolve the manager for a tool call without leaking core globals to callers. */
export function managerForContext(ctx: ToolExecutionContext | undefined): LspManager {
  const workspaceRoot = ctx?.workspaceRoot || ctx?.cwd || process.cwd();
  return getLspManager({ workspaceRoot, cwd: ctx?.cwd });
}

/** Shut every manager down — called on session/workspace teardown. */
export async function shutdownLspManagers(): Promise<void> {
  const all = [...managers.values()];
  managers.clear();
  await Promise.all(all.map((manager) => manager.shutdown().catch(() => {})));
}

export function resetLspManagers(): void {
  managers.clear();
}

/**
 * Test seam: register a pre-built manager (with an in-memory server) for a
 * workspace so the `lsp` tool's real dispatch path can be exercised without a
 * language-server binary.
 */
export function setLspManagerForTesting(workspaceRoot: string, manager: LspManager): void {
  managers.set(workspaceRoot, manager);
}
