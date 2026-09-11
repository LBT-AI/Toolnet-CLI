/**
 * Phase 74 — LSP / Code Intelligence: normalized contracts.
 *
 * These types are deliberately server-independent. Every language server
 * (tsserver, pyright, gopls, …) is adapted into this shape by `client.ts`, so
 * the agent tool, the manager and the tests never see an LSP wire object.
 *
 * Positions from LSP are 0-based; the normalized `Location` / `DiagnosticItem`
 * exposed to the model are 1-based (editor conventions) with workspace-relative
 * paths.
 */

/** The operations a model may request from the `lsp` tool. */
export type LspOperation =
  | "definition"
  | "references"
  | "diagnostics"
  | "document_symbols"
  | "workspace_symbols"
  | "hover";

export const LSP_OPERATIONS: readonly LspOperation[] = [
  "definition",
  "references",
  "diagnostics",
  "document_symbols",
  "workspace_symbols",
  "hover",
];

/** 0-based LSP position. */
export interface Position {
  line: number;
  character: number;
}

/** 0-based LSP range. */
export interface Range {
  start: Position;
  end: Position;
}

/** Normalized, 1-based, workspace-relative location. */
export interface Location {
  path: string;
  line: number;
  character: number;
}

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export interface DiagnosticItem {
  path: string;
  /** 1-based */
  line: number;
  /** 1-based */
  character: number;
  severity: DiagnosticSeverity;
  message: string;
  source?: string;
  code?: string | number;
}

export interface SymbolInfo {
  name: string;
  kind: string;
  path: string;
  /** 1-based */
  line: number;
  /** 1-based */
  character: number;
  containerName?: string;
}

export interface HoverInfo {
  contents: string;
  range?: Range;
}

/** Result of probing whether code intelligence is available for a file. */
export interface Availability {
  available: boolean;
  serverId?: string;
  reason?: string;
}

export interface LspTimeouts {
  initializeMs: number;
  requestMs: number;
  diagnosticsMs: number;
  shutdownMs: number;
}

export const DEFAULT_LSP_TIMEOUTS: LspTimeouts = {
  initializeMs: 45000,
  requestMs: 10000,
  diagnosticsMs: 5000,
  shutdownMs: 2000,
};

/** Minimal JSON-RPC transport contract — stdio in production, memory in tests. */
export interface LspTransport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: (error?: Error) => void): void;
  close(): void | Promise<void>;
}

/** A live language-server endpoint plus its initialization payload. */
export interface SpawnedServer {
  transport: LspTransport;
  initialization?: Record<string, unknown>;
  processId?: number;
}

/** Structured, secret-free logger the manager accepts. */
export interface LspLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

/** A language-server definition used for selection + launch. */
export interface LspServerSpec {
  id: string;
  languageIds: string[];
  extensions: string[];
  /** Candidate executables, most preferred first. */
  binaries: string[];
  args: string[];
  /** Project markers used to pick the server root (nearest ancestor). */
  rootMarkers: string[];
}

/** Request options shared by every client operation. */
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
