/**
 * Phase 74 — Diagnostics normalization.
 *
 * Diagnostics are a *supplementary* feedback layer: they never replace a
 * compiler, a typecheck or a test run. This module only turns LSP diagnostics
 * into a stable shape and renders a compact, model-readable block.
 */

import { toWorkspacePath, uriToAbsolutePath } from "./normalize";
import type { DiagnosticItem, DiagnosticSeverity } from "./types";

const SEVERITY_NAMES: Record<number, DiagnosticSeverity> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

export function severityName(severity: unknown): DiagnosticSeverity {
  if (typeof severity === "number") return SEVERITY_NAMES[severity] ?? "error";
  return "error";
}

function toItem(uri: unknown, raw: unknown, workspaceRoot: string): DiagnosticItem | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const message = typeof obj.message === "string" ? obj.message : "";
  if (!message) return undefined;
  const range = (obj.range ?? {}) as Record<string, unknown>;
  const start = (range.start ?? {}) as { line?: unknown; character?: unknown };
  const absolute = uriToAbsolutePath(uri);
  const code = obj.code;
  return {
    path: absolute ? toWorkspacePath(absolute, workspaceRoot) : String(uri ?? ""),
    line: typeof start.line === "number" ? start.line + 1 : 1,
    character: typeof start.character === "number" ? start.character + 1 : 1,
    severity: severityName(obj.severity),
    message,
    ...(typeof obj.source === "string" ? { source: obj.source } : {}),
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
  };
}

/**
 * Normalize one `publishDiagnostics` payload. Duplicate entries (same code,
 * message, range) are collapsed — some servers push the same problem twice.
 */
export function normalizeDiagnostics(
  uri: unknown,
  diagnostics: unknown,
  workspaceRoot: string
): DiagnosticItem[] {
  if (!Array.isArray(diagnostics)) return [];
  const seen = new Set<string>();
  const out: DiagnosticItem[] = [];
  for (const raw of diagnostics) {
    const item = toItem(uri, raw, workspaceRoot);
    if (!item) continue;
    const key = `${item.path}:${item.line}:${item.character}:${item.severity}:${item.code ?? ""}:${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function countBySeverity(items: DiagnosticItem[]): Record<DiagnosticSeverity, number> {
  const counts: Record<DiagnosticSeverity, number> = { error: 0, warning: 0, info: 0, hint: 0 };
  for (const item of items) counts[item.severity] += 1;
  return counts;
}

/** Compact one-line form, e.g. `ERROR [12:5] Cannot find name 'foo'. (ts(2304))`. */
export function formatDiagnostic(item: DiagnosticItem): string {
  const label = item.severity.toUpperCase();
  const code = item.code !== undefined ? ` (${item.code})` : "";
  return `${label} [${item.line}:${item.character}] ${item.message}${code}`;
}

/**
 * Render a `<diagnostics file="...">` block for the model. Only errors and
 * warnings are emitted by default — info/hint are noise during repair. Returns
 * an empty string when there is nothing actionable, so callers can append
 * unconditionally.
 */
export function formatDiagnosticsReport(
  filePath: string,
  items: DiagnosticItem[],
  options: { includeWarnings?: boolean; maxPerFile?: number } = {}
): string {
  const includeWarnings = options.includeWarnings ?? true;
  const maxPerFile = options.maxPerFile ?? 20;

  const relevant = items.filter((item) => item.severity === "error" || (includeWarnings && item.severity === "warning"));
  if (relevant.length === 0) return "";

  const limited = relevant.slice(0, maxPerFile);
  const more = relevant.length - limited.length;
  const suffix = more > 0 ? `\n... and ${more} more` : "";
  return `<diagnostics file="${filePath}">\n${limited.map(formatDiagnostic).join("\n")}${suffix}\n</diagnostics>`;
}
