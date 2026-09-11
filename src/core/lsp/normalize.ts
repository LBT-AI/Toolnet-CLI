/**
 * Phase 74 — Wire → normalized result adapters.
 *
 * Language servers return a handful of shapes for the same concept
 * (`Location`, `LocationLink`, `SymbolInformation`, flat or nested
 * `DocumentSymbol`). Everything funnels through here so the tool, the manager
 * and the tests only ever see `Location` / `SymbolInfo` / `HoverInfo`.
 */

import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { HoverInfo, Location, Position, SymbolInfo } from "./types";

/** LSP `SymbolKind` numeric enum → stable, human-readable name. */
export const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum-member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type-parameter",
};

export function kindName(kind: unknown): string {
  if (typeof kind === "number") return SYMBOL_KIND_NAMES[kind] ?? String(kind);
  if (typeof kind === "string") return kind.toLowerCase();
  return "unknown";
}

/** Absolute path → `file://` URI. */
export function toUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

/**
 * `file://` URI → absolute path. Returns undefined for non-file URIs and for
 * malformed input, so callers treat foreign schemes as "no location".
 */
export function uriToAbsolutePath(uri: unknown): string | undefined {
  if (typeof uri !== "string" || !uri.startsWith("file://")) return undefined;
  try {
    return path.resolve(fileURLToPath(uri));
  } catch {
    return undefined;
  }
}

/**
 * Convert an absolute path to a workspace-relative, forward-slashed path. Paths
 * outside the workspace fall back to their absolute form so nothing is hidden.
 */
export function toWorkspacePath(absolute: string, workspaceRoot: string): string {
  const rel = path.relative(workspaceRoot, absolute);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return absolute.replace(/\\/g, "/");
  }
  return rel.replace(/\\/g, "/");
}

function asPosition(value: unknown): Position | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as { line?: unknown; character?: unknown };
  if (typeof p.line !== "number" || typeof p.character !== "number") return undefined;
  return { line: p.line, character: p.character };
}

/** Accepts a `Location`, a `LocationLink`, or an array of either. */
export function normalizeLocations(
  raw: unknown,
  workspaceRoot: string
): Location[] {
  if (!Array.isArray(raw)) return [];
  const out: Location[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const uri = obj.uri ?? obj.targetUri;
    const absolute = uriToAbsolutePath(uri);
    if (!absolute) continue;
    // LocationLink exposes range/selectionRange; prefer the selection start.
    const range = (obj.selectionRange ?? obj.range ?? obj.targetSelectionRange ?? obj.targetRange) as
      | Record<string, unknown>
      | undefined;
    const start = asPosition(range?.start) ?? { line: 0, character: 0 };
    out.push({
      path: toWorkspacePath(absolute, workspaceRoot),
      line: start.line + 1,
      character: start.character + 1,
    });
  }
  return out;
}

/** Flatten `DocumentSymbol` trees and `SymbolInformation` lists into one shape. */
export function normalizeDocumentSymbols(
  raw: unknown,
  filePath: string,
  workspaceRoot: string
): SymbolInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: SymbolInfo[] = [];
  const visit = (items: unknown[], containerName?: string): void => {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const name = typeof obj.name === "string" ? obj.name : "";
      if (!name) continue;
      const range = (obj.selectionRange ?? obj.range ?? obj.location) as Record<string, unknown> | undefined;
      const nested = range && "range" in range ? (range.range as Record<string, unknown>) : range;
      const start = asPosition(nested?.start) ?? { line: 0, character: 0 };
      if (obj.location && typeof obj.location === "object") {
        const loc = obj.location as Record<string, unknown>;
        const absolute = uriToAbsolutePath(loc.uri);
        const locRange = (loc.range as Record<string, unknown>) ?? {};
        const locStart = asPosition(locRange.start) ?? { line: 0, character: 0 };
        out.push({
          name,
          kind: kindName(obj.kind),
          path: absolute ? toWorkspacePath(absolute, workspaceRoot) : toWorkspacePath(filePath, workspaceRoot),
          line: locStart.line + 1,
          character: locStart.character + 1,
          ...(typeof obj.containerName === "string" ? { containerName: obj.containerName } : {}),
        });
      } else {
        out.push({
          name,
          kind: kindName(obj.kind),
          path: toWorkspacePath(filePath, workspaceRoot),
          line: start.line + 1,
          character: start.character + 1,
          ...(containerName ? { containerName } : {}),
        });
      }
      if (Array.isArray(obj.children) && obj.children.length > 0) visit(obj.children, name);
    }
  };
  visit(raw);
  return out;
}

/** Extract plain text from a `Hover` / `MarkupContent` / `MarkedString` value. */
export function normalizeHover(raw: unknown): HoverInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const contents = obj.contents;

  if (typeof contents === "string") {
    return { contents: contents.trim() };
  }

  if (Array.isArray(contents)) {
    const parts = contents
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { value?: unknown }).value === "string") {
          return (part as { value: string }).value;
        }
        return "";
      })
      .filter(Boolean);
    const text = parts.join("\n\n").trim();
    if (!text) return undefined;
    return { contents: text, range: obj.range as HoverInfo["range"] };
  }

  if (contents && typeof contents === "object" && typeof (contents as { value?: unknown }).value === "string") {
    const text = (contents as { value: string }).value.trim();
    if (!text) return undefined;
    return { contents: text, range: obj.range as HoverInfo["range"] };
  }

  return undefined;
}
