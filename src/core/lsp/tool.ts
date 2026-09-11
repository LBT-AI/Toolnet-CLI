/**
 * Phase 74 — The canonical `lsp` tool.
 *
 * One tool, six operations, registered once in the canonical ToolRegistry so it
 * flows through the existing permission → execute → verify pipeline. There is
 * no second execution path: the tool talks to the workspace LSP manager, which
 * talks to the language server.
 *
 * When code intelligence is unavailable the tool returns an explicit
 * `available: false` notice — never an error that would stall the agent, and
 * never a fabricated success. The model then falls back to grep/read_file.
 */

import path from "node:path";
import type { ToolExecutionContext } from "../../lib/security/types";
import { formatDiagnosticsReport } from "./diagnostics";
import { managerForContext } from "./manager";
import type { DiagnosticItem, Location, LspOperation, SymbolInfo } from "./types";
import { LSP_OPERATIONS } from "./types";

export interface LspToolInput {
  operation: LspOperation;
  path?: string;
  /** 1-based, editor convention. */
  line?: number;
  /** 1-based, editor convention. */
  character?: number;
  query?: string;
}

/** JSON schema handed to the model by the registry. */
export const LSP_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: [...LSP_OPERATIONS],
      description: "The code-intelligence operation to perform.",
    },
    path: {
      type: "string",
      description: "File path (relative to the workspace) for file-scoped operations.",
    },
    line: {
      type: "number",
      description: "1-based line number, as shown in an editor. Required for definition/references/hover.",
    },
    character: {
      type: "number",
      description: "1-based character offset. Required for definition/references/hover.",
    },
    query: {
      type: "string",
      description: "Symbol search query for workspace_symbols. Empty string requests all symbols.",
    },
  },
  required: ["operation"],
} as const;

interface ToolEnvelope {
  stdout: string;
  stderr: string;
  exitCode: number;
  [key: string]: unknown;
}

function ok(operation: LspOperation, payload: Record<string, unknown>): string {
  return JSON.stringify({
    stdout: typeof payload.summary === "string" ? payload.summary : "",
    stderr: "",
    exitCode: 0,
    operation,
    available: true,
    ...payload,
  } satisfies ToolEnvelope);
}

function unavailable(operation: LspOperation, target: string, reason: string): string {
  const message =
    `LSP unavailable for ${target}: ${reason}. ` +
    `Fall back to grep/glob/read_file for this task.`;
  return JSON.stringify({
    stdout: message,
    stderr: "",
    exitCode: 0,
    operation,
    available: false,
    results: [],
    reason,
  } satisfies ToolEnvelope);
}

function invalid(operation: string, message: string): string {
  return JSON.stringify({
    stdout: "",
    stderr: message,
    exitCode: 1,
    operation,
    available: false,
    results: [],
    reason: message,
  } satisfies ToolEnvelope);
}

function resolveTargetPath(input: LspToolInput, ctx?: ToolExecutionContext): string {
  const raw = input.path ?? "";
  if (path.isAbsolute(raw)) return path.resolve(raw);
  const base = ctx?.cwd || ctx?.workspaceRoot || process.cwd();
  return path.resolve(base, raw);
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderLocations(locations: Location[]): string {
  if (locations.length === 0) return "No results found.";
  return locations.map((loc) => `${loc.path}:${loc.line}:${loc.character}`).join("\n");
}

function renderSymbols(symbols: SymbolInfo[]): string {
  if (symbols.length === 0) return "No symbols found.";
  return symbols
    .map((symbol) => {
      const container = symbol.containerName ? `${symbol.containerName}.` : "";
      return `${symbol.kind} ${container}${symbol.name} (${symbol.path}:${symbol.line}:${symbol.character})`;
    })
    .join("\n");
}

function renderDiagnostics(items: DiagnosticItem[]): string {
  if (items.length === 0) return "No diagnostics for this file.";
  return items
    .map((item) => `${item.path}:${item.line}:${item.character} ${item.severity.toUpperCase()} ${item.message}`)
    .join("\n");
}

// ── Operation dispatch ──────────────────────────────────────────────────────

/**
 * Execute one `lsp` request. Never throws: failures degrade to an
 * `available: false` / `exitCode: 1` envelope so the agent loop stays alive.
 */
export async function runLspOperation(
  input: LspToolInput,
  ctx?: ToolExecutionContext
): Promise<string> {
  const operation = input.operation;
  if (!LSP_OPERATIONS.includes(operation)) {
    return invalid(String(operation), `Unknown lsp operation "${operation}". Expected one of: ${LSP_OPERATIONS.join(", ")}.`);
  }

  try {
    return await dispatch(operation, input, ctx);
  } catch (error) {
    return invalid(operation, `LSP ${operation} failed: ${(error as Error).message}`);
  }
}

async function dispatch(
  operation: LspOperation,
  input: LspToolInput,
  ctx?: ToolExecutionContext
): Promise<string> {
  const manager = managerForContext(ctx);

  if (operation === "workspace_symbols") {
    const availability = manager.probeAvailability();
    if (!availability.available) {
      return unavailable(operation, "the workspace", availability.reason ?? "no language server");
    }
    const symbols = await manager.workspaceSymbols(input.query ?? "", { signal: ctx?.signal });
    return ok(operation, {
      summary: renderSymbols(symbols),
      results: symbols,
      count: symbols.length,
      serverId: availability.serverId,
    });
  }

  if (input.path === undefined || input.path === "") {
    return invalid(operation, `The "${operation}" operation requires a "path".`);
  }

  const filePath = resolveTargetPath(input, ctx);

  const availability = manager.availability(filePath);
  if (!availability.available) {
    return unavailable(operation, filePath, availability.reason ?? "no language server");
  }

  if (operation === "diagnostics") {
    const items = await manager.diagnostics(filePath, { signal: ctx?.signal });
    const report = formatDiagnosticsReport(filePath, items);
    return ok(operation, {
      summary: report || renderDiagnostics(items),
      results: items,
      count: items.length,
      serverId: availability.serverId,
    });
  }

  if (operation === "document_symbols") {
    const symbols = await manager.documentSymbols(filePath, { signal: ctx?.signal });
    return ok(operation, {
      summary: renderSymbols(symbols),
      results: symbols,
      count: symbols.length,
      serverId: availability.serverId,
    });
  }

  const line = Number(input.line);
  const character = Number(input.character);
  if (!Number.isFinite(line) || !Number.isFinite(character) || line < 1 || character < 1) {
    return invalid(operation, `The "${operation}" operation requires 1-based "line" and "character".`);
  }
  const position = { line: line - 1, character: character - 1 };

  if (operation === "definition" || operation === "references") {
    const locations =
      operation === "definition"
        ? await manager.definition(filePath, position, { signal: ctx?.signal })
        : await manager.references(filePath, position, { signal: ctx?.signal });
    return ok(operation, {
      summary: renderLocations(locations),
      results: locations,
      count: locations.length,
      serverId: availability.serverId,
    });
  }

  const hover = await manager.hover(filePath, position, { signal: ctx?.signal });
  if (!hover) {
    return ok(operation, { summary: "No hover information available.", results: [], count: 0, serverId: availability.serverId });
  }
  return ok(operation, {
    summary: hover.contents,
    results: [hover],
    count: 1,
    serverId: availability.serverId,
  });
}
