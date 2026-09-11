/**
 * Phase 74 — LSP client.
 *
 * Owns one language-server session: the `initialize` handshake, document
 * synchronization, JSON-RPC request/response correlation with timeouts and
 * cancellation, diagnostics caching, and the six normalized operations the
 * agent tool exposes.
 *
 * The client talks only to an `LspTransport`, so production (stdio) and tests
 * (in-memory) share this exact code path.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { detectLanguageId } from "./languages";
import { normalizeDiagnostics } from "./diagnostics";
import {
  normalizeDocumentSymbols,
  normalizeHover,
  normalizeLocations,
  toUri,
  uriToAbsolutePath,
} from "./normalize";
import type {
  DiagnosticItem,
  HoverInfo,
  Location,
  LspTimeouts,
  LspTransport,
  Position,
  RequestOptions,
  SymbolInfo,
} from "./types";
import { DEFAULT_LSP_TIMEOUTS } from "./types";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

interface DiagnosticCacheEntry {
  items: DiagnosticItem[];
  at: number;
  version?: number;
}

export interface LspClientOptions {
  serverId: string;
  root: string;
  workspaceRoot: string;
  transport: LspTransport;
  initialization?: Record<string, unknown>;
  processId?: number;
  timeouts?: Partial<LspTimeouts>;
  now?: () => number;
  signal?: AbortSignal;
}

export class LspClient {
  readonly serverId: string;
  readonly root: string;
  readonly workspaceRoot: string;

  private readonly transport: LspTransport;
  private readonly initialization?: Record<string, unknown>;
  private readonly processId?: number;
  private readonly timeouts: LspTimeouts;
  private readonly now: () => number;
  private readonly signal?: AbortSignal;

  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly openDocuments = new Map<string, { version: number; text: string }>();
  private readonly diagnosticsCache = new Map<string, DiagnosticCacheEntry>();
  private readonly diagnosticsListeners = new Set<(absolutePath: string) => void>();
  private capabilities: Record<string, unknown> = {};
  private closed = false;
  private shuttingDown = false;
  private initialized = false;

  constructor(options: LspClientOptions) {
    this.serverId = options.serverId;
    this.root = path.resolve(options.root);
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.transport = options.transport;
    this.initialization = options.initialization;
    this.processId = options.processId;
    this.timeouts = { ...DEFAULT_LSP_TIMEOUTS, ...(options.timeouts ?? {}) };
    this.now = options.now ?? (() => Date.now());
    this.signal = options.signal;

    this.transport.onMessage((message) => this.handleMessage(message));
    this.transport.onClose((error) => this.handleClose(error));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get serverCapabilities(): Record<string, unknown> {
    return this.capabilities;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Perform the `initialize` / `initialized` handshake exactly once. */
  async start(): Promise<void> {
    if (this.initialized) return;

    const rootUri = toUri(this.root);
    const result = await this.request<{ capabilities?: Record<string, unknown> }>(
      "initialize",
      {
        processId: this.processId ?? process.pid,
        rootUri,
        workspaceFolders: [{ name: "workspace", uri: rootUri }],
        initializationOptions: { ...(this.initialization ?? {}) },
        capabilities: {
          window: { workDoneProgress: true },
          workspace: {
            configuration: true,
            workspaceFolders: true,
            didChangeWatchedFiles: { dynamicRegistration: true },
            diagnostics: { refreshSupport: false },
          },
          textDocument: {
            synchronization: { didOpen: true, didChange: true, dynamicRegistration: false },
            publishDiagnostics: { versionSupport: false },
            hover: { contentFormat: ["plaintext", "markdown"] },
            definition: { linkSupport: true },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            diagnostic: { dynamicRegistration: false },
          },
        },
      },
      { timeoutMs: this.timeouts.initializeMs, signal: this.signal }
    );

    this.capabilities = result?.capabilities ?? {};
    this.notify("initialized", {});
    if (this.initialization) {
      this.notify("workspace/didChangeConfiguration", { settings: this.initialization });
    }
    this.initialized = true;
  }

  /** Convenience: start (if needed) then resolve the client for a file. */
  async ready(): Promise<void> {
    if (this.closed) throw new Error(`LSP server "${this.serverId}" is closed`);
    await this.start();
  }

  /** Graceful `shutdown` → `exit`, then drop the transport. */
  async shutdown(): Promise<void> {
    if (this.closed || this.shuttingDown) return;
    // Mark "shutting down" rather than "closed": the shutdown request itself
    // must still be allowed to go out on the wire.
    this.shuttingDown = true;
    try {
      await this.request("shutdown", null, { timeoutMs: this.timeouts.shutdownMs });
      this.notify("exit", null);
    } catch {
      // A server that never answers shutdown is simply killed below.
    }
    this.closed = true;
    this.rejectAllPending(new Error(`LSP server "${this.serverId}" was shut down`));
    await this.transport.close();
  }

  // ── Document synchronization ──────────────────────────────────────────────

  /**
   * `didOpen` on first use, `didChange` (full text) when content differs.
   *
   * `changed` is true when a synchronization notification went out, which means
   * the server will publish a fresh diagnostics batch. When it is false the
   * document is already in sync and any cached diagnostics are still current —
   * callers must not wait for a publish that is never coming.
   */
  async openDocument(filePath: string): Promise<{ version: number; changed: boolean }> {
    const absolute = path.resolve(filePath);
    const uri = toUri(absolute);
    let text: string;
    try {
      text = await fsp.readFile(absolute, "utf8");
    } catch (error) {
      throw new Error(`Cannot read file for LSP: ${absolute} (${(error as Error).message})`);
    }

    const existing = this.openDocuments.get(uri);
    if (!existing) {
      const version = 1;
      this.openDocuments.set(uri, { version, text });
      this.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: detectLanguageId(absolute) ?? "plaintext",
          version,
          text,
        },
      });
      return { version, changed: true };
    }

    if (existing.text === text) return { version: existing.version, changed: false };

    const version = existing.version + 1;
    this.openDocuments.set(uri, { version, text });
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
    return { version, changed: true };
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────

  /**
   * Touch a file and return the diagnostics the server most recently published
   * for it. Resolves on timeout with whatever arrived, so a quiet server never
   * stalls the agent.
   */
  async diagnostics(filePath: string, options: RequestOptions = {}): Promise<DiagnosticItem[]> {
    const absolute = path.resolve(filePath);
    const after = this.now();
    const { version, changed } = await this.openDocument(absolute);

    // Document already in sync → no publish is pending, so return the cached
    // batch instead of waiting out the timeout.
    if (!changed) return this.diagnosticsCache.get(absolute)?.items ?? [];

    await this.waitForDiagnostics(absolute, {
      after,
      version,
      timeoutMs: options.timeoutMs ?? this.timeouts.diagnosticsMs,
      signal: options.signal,
    });
    return this.diagnosticsCache.get(absolute)?.items ?? [];
  }

  private waitForDiagnostics(
    absolutePath: string,
    options: { after: number; version?: number; timeoutMs: number; signal?: AbortSignal }
  ): Promise<void> {
    const cached = this.diagnosticsCache.get(absolutePath);
    if (cached && cached.at >= options.after) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.diagnosticsListeners.delete(listener);
        options.signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => finish();
      const listener = (changedPath: string) => {
        if (changedPath !== absolutePath) return;
        const entry = this.diagnosticsCache.get(absolutePath);
        if (!entry || entry.at < options.after) return;
        finish();
      };
      const timer = setTimeout(finish, Math.max(0, options.timeoutMs));
      this.diagnosticsListeners.add(listener);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ── Operations ────────────────────────────────────────────────────────────

  async definition(filePath: string, position: Position, options: RequestOptions = {}): Promise<Location[]> {
    await this.openDocument(filePath);
    const raw = await this.request(
      "textDocument/definition",
      { textDocument: { uri: toUri(filePath) }, position },
      options
    ).catch(() => null);
    return normalizeLocations(raw, this.workspaceRoot);
  }

  async references(filePath: string, position: Position, options: RequestOptions = {}): Promise<Location[]> {
    await this.openDocument(filePath);
    const raw = await this.request(
      "textDocument/references",
      {
        textDocument: { uri: toUri(filePath) },
        position,
        context: { includeDeclaration: true },
      },
      options
    ).catch(() => []);
    return normalizeLocations(raw, this.workspaceRoot);
  }

  async hover(filePath: string, position: Position, options: RequestOptions = {}): Promise<HoverInfo | undefined> {
    await this.openDocument(filePath);
    const raw = await this.request(
      "textDocument/hover",
      { textDocument: { uri: toUri(filePath) }, position },
      options
    ).catch(() => null);
    return normalizeHover(raw);
  }

  async documentSymbols(filePath: string, options: RequestOptions = {}): Promise<SymbolInfo[]> {
    const absolute = path.resolve(filePath);
    await this.openDocument(absolute);
    const raw = await this.request(
      "textDocument/documentSymbol",
      { textDocument: { uri: toUri(absolute) } },
      options
    ).catch(() => []);
    return normalizeDocumentSymbols(raw, absolute, this.workspaceRoot);
  }

  async workspaceSymbols(query: string, options: RequestOptions = {}): Promise<SymbolInfo[]> {
    const raw = await this.request("workspace/symbol", { query: query ?? "" }, options).catch(() => []);
    return normalizeDocumentSymbols(raw, this.root, this.workspaceRoot);
  }

  // ── JSON-RPC plumbing ─────────────────────────────────────────────────────

  private notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.transport.send({ jsonrpc: "2.0", method, params });
  }

  private request<T>(method: string, params: unknown, options: RequestOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`LSP server "${this.serverId}" is closed`));

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.timeouts.requestMs;

      const settle = (fn: () => void) => {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.signal?.removeEventListener("abort", entry.onAbort!);
        fn();
      };

      const entry: PendingRequest = {
        resolve: (value) => settle(() => resolve(value as T)),
        reject: (error) => settle(() => reject(error)),
        timer: setTimeout(() => {
          this.pending.delete(id);
          entry.signal?.removeEventListener("abort", entry.onAbort!);
          reject(new Error(`LSP request timed out after ${timeoutMs}ms: ${method}`));
        }, timeoutMs),
        signal: options.signal,
      };

      if (options.signal) {
        entry.onAbort = () => {
          this.pending.delete(id);
          clearTimeout(entry.timer);
          reject(new Error(`LSP request cancelled: ${method}`));
        };
        if (options.signal.aborted) return entry.onAbort();
        options.signal.addEventListener("abort", entry.onAbort, { once: true });
      }

      this.pending.set(id, entry);
      this.transport.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const msg = message as {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string };
    };

    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(Number(msg.id));
      if (!entry) return;
      if (msg.error) {
        entry.reject(new Error(msg.error.message ?? `LSP error (code ${msg.error.code ?? "?"})`));
        return;
      }
      entry.resolve(msg.result);
      return;
    }

    // Server → client notification.
    if (msg.method === "textDocument/publishDiagnostics") {
      this.handlePublishDiagnostics(msg.params);
      return;
    }

    // Server → client request; every one must be answered or the server stalls.
    if (msg.id !== undefined) this.respondToServerRequest(msg.id, msg.method ?? "", msg.params);
  }

  private respondToServerRequest(id: number | string, method: string, params: unknown): void {
    let result: unknown = null;
    switch (method) {
      case "workspace/configuration": {
        const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
        result = items.map(() => null);
        break;
      }
      case "workspace/workspaceFolders":
        result = [{ name: "workspace", uri: toUri(this.root) }];
        break;
      case "window/workDoneProgress/create":
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "workspace/diagnostic/refresh":
      default:
        result = null;
        break;
    }
    if (this.closed) return;
    this.transport.send({ jsonrpc: "2.0", id, result });
  }

  private handlePublishDiagnostics(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const payload = params as { uri?: unknown; diagnostics?: unknown; version?: unknown };
    const resolved = uriToAbsolutePath(payload.uri);
    if (!resolved) return;

    const items = normalizeDiagnostics(payload.uri, payload.diagnostics, this.workspaceRoot);
    this.diagnosticsCache.set(resolved, {
      items,
      at: this.now(),
      version: typeof payload.version === "number" ? payload.version : undefined,
    });
    for (const listener of [...this.diagnosticsListeners]) listener(resolved);
  }

  private handleClose(error?: Error): void {
    this.closed = true;
    this.rejectAllPending(error ?? new Error(`LSP server "${this.serverId}" connection closed`));
  }

  private rejectAllPending(error: Error): void {
    for (const [id, entry] of [...this.pending.entries()]) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.signal?.removeEventListener("abort", entry.onAbort!);
      entry.reject(error);
    }
  }
}
