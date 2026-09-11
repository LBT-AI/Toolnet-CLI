/**
 * Deterministic in-memory language server used by the Phase 74 tests.
 *
 * It speaks the same JSON-RPC the real servers do, over the in-memory transport,
 * so the production `LspClient`/`LspManager` code paths are exercised without a
 * language-server binary in CI.
 *
 * Handlers are written in the *normalized* shape (1-based positions, workspace
 * or file-relative paths). The server converts them to LSP wire shapes, exactly
 * like a real server would, which keeps the tests focused on intent.
 */

import path from "node:path";
import { toUri } from "../../../core/lsp/normalize";
import { createMemoryTransportPair } from "../../../core/lsp/transport";
import type { DiagnosticItem, LspTransport, SpawnedServer, SymbolInfo } from "../../../core/lsp/types";

interface RequestRecord {
  method: string;
  params: any;
}

/** 1-based location handed back by a test handler. */
export interface TestLocation {
  path: string;
  line: number;
  character: number;
}

export interface FakeLspHandlers {
  definition?: (absoluteFile: string, position: { line: number; character: number }) => TestLocation[] | undefined;
  references?: (absoluteFile: string, position: { line: number; character: number }) => TestLocation[] | undefined;
  hover?: (absoluteFile: string, position: { line: number; character: number }) => string | undefined;
  documentSymbols?: (absoluteFile: string) => SymbolInfo[];
  workspaceSymbols?: (query: string) => SymbolInfo[];
}

export interface FakeLspServerOptions {
  /** Used to resolve relative paths returned by symbol handlers. */
  workspaceRoot?: string;
  handlers?: FakeLspHandlers;
  /** Diagnostics to publish (keyed by absolute path) when a file is opened/changed. */
  diagnosticsByPath?: Record<string, DiagnosticItem[]>;
  /** Dynamic variant of `diagnosticsByPath`, for tests that change state mid-flow. */
  diagnosticsFor?: (absolutePath: string) => DiagnosticItem[];
  /** Never reply — exercises request timeouts. */
  silent?: boolean;
  /** Reply to `initialize` with an error — exercises start failure. */
  failInitialize?: boolean;
  /** Delay every reply by this many ms. */
  replyDelayMs?: number;
  capabilities?: Record<string, unknown>;
}

export interface FakeLspServer {
  /** Pass to `LspManagerOptions.spawnServer`. */
  spawn: (spec: { id: string }, root: string) => SpawnedServer;
  requests: RequestRecord[];
  openedDocuments: string[];
  shutdownCalled: boolean;
  /** Simulate the server pushing an updated diagnostics batch. */
  publishDiagnostics: (absolutePath: string, items: DiagnosticItem[]) => void;
  close: () => void;
}

const KIND_NUMBERS: Record<string, number> = {
  file: 1,
  module: 2,
  namespace: 3,
  package: 4,
  class: 5,
  method: 6,
  property: 7,
  field: 8,
  constructor: 9,
  enum: 10,
  interface: 11,
  function: 12,
  variable: 13,
  constant: 14,
  struct: 23,
  "enum-member": 22,
  "type-parameter": 26,
};

function toAbsolute(loc: string, baseDir: string): string {
  return path.isAbsolute(loc) ? loc : path.resolve(baseDir, loc);
}

function toWireLocation(loc: TestLocation, baseDir: string) {
  const absolute = toAbsolute(loc.path, baseDir);
  const line = Math.max(0, loc.line - 1);
  const character = Math.max(0, loc.character - 1);
  return {
    uri: toUri(absolute),
    range: { start: { line, character }, end: { line, character: character + 1 } },
  };
}

function toWireSymbol(symbol: SymbolInfo, baseDir: string) {
  const absolute = toAbsolute(symbol.path, baseDir);
  const line = Math.max(0, symbol.line - 1);
  const character = Math.max(0, symbol.character - 1);
  return {
    name: symbol.name,
    kind: KIND_NUMBERS[symbol.kind] ?? 13,
    containerName: symbol.containerName,
    location: {
      uri: toUri(absolute),
      range: { start: { line, character }, end: { line, character: character + 1 } },
    },
  };
}

function toWireDiagnostic(item: DiagnosticItem) {
  const severity = { error: 1, warning: 2, info: 3, hint: 4 }[item.severity];
  return {
    severity,
    message: item.message,
    ...(item.source ? { source: item.source } : {}),
    ...(item.code !== undefined ? { code: item.code } : {}),
    range: {
      start: { line: Math.max(0, item.line - 1), character: Math.max(0, item.character - 1) },
      end: { line: Math.max(0, item.line - 1), character: Math.max(0, item.character) },
    },
  };
}

function uriToFile(uri: unknown): string | undefined {
  if (typeof uri !== "string" || !uri.startsWith("file://")) return undefined;
  try {
    return path.resolve(decodeURIComponent(uri.replace("file://", "")));
  } catch {
    return undefined;
  }
}

export function createFakeLspServer(options: FakeLspServerOptions = {}): FakeLspServer {
  const handlers = options.handlers ?? {};
  const workspaceRoot = path.resolve(options.workspaceRoot ?? "/");
  const pair = createMemoryTransportPair({ silent: options.silent });
  const requests: RequestRecord[] = [];
  const openedDocuments: string[] = [];
  const server = pair.server;
  let shutdownCalled = false;

  const send = (message: unknown) => {
    if (options.replyDelayMs) {
      setTimeout(() => server.send(message), options.replyDelayMs);
      return;
    }
    server.send(message);
  };
  const reply = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });

  const respondToRequest = (method: string, params: any): unknown => {
    const file = uriToFile(params?.textDocument?.uri);
    // Handlers return workspace-relative (or absolute) paths, matching how a
    // real server reports URIs for locations inside the workspace.
    const baseDir = workspaceRoot;

    switch (method) {
      case "textDocument/definition":
        if (!file) return [];
        return (handlers.definition?.(file, params.position) ?? []).map((loc) => toWireLocation(loc, baseDir));
      case "textDocument/references":
        if (!file) return [];
        return (handlers.references?.(file, params.position) ?? []).map((loc) => toWireLocation(loc, baseDir));
      case "textDocument/hover": {
        if (!file) return null;
        const text = handlers.hover?.(file, params.position);
        return text ? { contents: { kind: "plaintext", value: text } } : null;
      }
      case "textDocument/documentSymbol":
        if (!file) return [];
        return (handlers.documentSymbols?.(file) ?? []).map((symbol) => toWireSymbol(symbol, baseDir));
      case "workspace/symbol":
        return (handlers.workspaceSymbols?.(params.query ?? "") ?? []).map((symbol) =>
          toWireSymbol(symbol, workspaceRoot)
        );
      case "shutdown":
        shutdownCalled = true;
        return null;
      default:
        return null;
    }
  };

  server.onMessage((raw) => {
    const message = raw as { id?: unknown; method?: string; params?: any };
    if (message.method === "initialize") {
      if (options.failInitialize) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "initialize refused" } });
        return;
      }
      reply(message.id, { capabilities: options.capabilities ?? {} });
      return;
    }
    if (message.method === "initialized" || message.method === "workspace/didChangeConfiguration") return;
    if (message.method === "exit") return;

    if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {
      const uri = message.params?.textDocument?.uri ?? "";
      const absolute = uriToFile(uri);
      if (absolute && !openedDocuments.includes(absolute)) openedDocuments.push(absolute);
      const seeded = absolute
        ? (options.diagnosticsFor?.(absolute) ?? options.diagnosticsByPath?.[absolute])
        : undefined;
      if (absolute && seeded && seeded.length > 0) {
        send({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: { uri, diagnostics: seeded.map(toWireDiagnostic) },
        });
      }
      return;
    }

    if (message.id !== undefined) {
      requests.push({ method: message.method ?? "", params: message.params });
      reply(message.id, respondToRequest(message.method ?? "", message.params));
    }
  });

  const publishDiagnostics = (absolutePath: string, items: DiagnosticItem[]) => {
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri: toUri(absolutePath), diagnostics: items.map(toWireDiagnostic) },
    });
  };

  return {
    // A silent server is modelled as a dead transport: nothing ever replies.
    spawn: () => ({ transport: options.silent ? deadTransport() : pair.client }),
    requests,
    openedDocuments,
    get shutdownCalled() {
      return shutdownCalled;
    },
    publishDiagnostics,
    close: () => pair.client.close?.(),
  };
}

/** A transport whose peer never replies (renders as a hung server). */
function deadTransport(): LspTransport {
  return {
    send() {},
    onMessage() {},
    onClose() {},
    close() {},
  };
}
