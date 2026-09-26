import { A, theme } from "../../term";
import { truncate, stripAnsi } from "../layout";
import { formatDuration } from "../../lib/tool-format";
import type { FileMutation, FileMutationLine } from "../../core/contracts";

export interface DiffStat {
  fileName: string;
  additions: number;
  deletions: number;
}

export function parseDiffStats(diffText: string): DiffStat[] {
  const stats: Map<string, { additions: number; deletions: number }> = new Map();
  let currentFile = "file";

  const lines = diffText.split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git") || line.startsWith("+++ b/")) {
      const match = line.match(/(?:b\/|^diff --git a\/.* b\/)(.+)$/);
      if (match) currentFile = match[1];
    } else if (line.startsWith("--- a/")) {
      const match = line.match(/--- a\/(.+)$/);
      if (match) currentFile = match[1];
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      const entry = stats.get(currentFile) || { additions: 0, deletions: 0 };
      entry.additions++;
      stats.set(currentFile, entry);
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      const entry = stats.get(currentFile) || { additions: 0, deletions: 0 };
      entry.deletions++;
      stats.set(currentFile, entry);
    }
  }

  return Array.from(stats.entries()).map(([fileName, { additions, deletions }]) => ({
    fileName,
    additions,
    deletions,
  }));
}

export function renderCompactDiffSummary(diffStat: DiffStat): string {
  const addStr = diffStat.additions > 0 ? A.fgGreen + `+${diffStat.additions}` + A.reset : "";
  const delStr = diffStat.deletions > 0 ? A.fgRed + `-${diffStat.deletions}` + A.reset : "";
  const spacer = addStr && delStr ? " " : "";
  return `${A.bold}${diffStat.fileName}${A.reset}  ${addStr}${spacer}${delStr}`;
}

/**
 * Renders a clean, beautifully formatted unified diff with syntax colors
 * for additions (+), deletions (-), hunks (@@), and file headers.
 */
export function renderUnifiedDiffLines(
  diffText: string,
  maxLines = 30,
  maxColWidth = 90
): string[] {
  if (!diffText.trim()) return [];

  const lines = diffText.trim().split("\n");
  const output: string[] = [];
  const limit = Math.min(lines.length, maxLines);

  for (let i = 0; i < limit; i++) {
    const rawLine = lines[i];
    const lineContent = truncate(rawLine, maxColWidth);
    let color = A.fgSubtext + A.dim;

    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      color = A.bold + A.fgGreen;
    } else if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      color = A.bold + A.fgRed;
    } else if (rawLine.startsWith("@@")) {
      color = A.bold + A.fgCyan;
    } else if (rawLine.startsWith("---") || rawLine.startsWith("+++") || rawLine.startsWith("diff --git")) {
      color = A.bold + A.fgSubtext;
    }

    output.push("    " + color + lineContent + A.reset);
  }

  if (lines.length > maxLines) {
    output.push("    " + A.fgSubtext + A.dim + `... (${lines.length - maxLines} more lines)` + A.reset);
  }

  return output;
}

// ── Structured file mutations ───────────────────────────────────────────────

/**
 * Diff lines rendered before a mutation block collapses. The FULL diff always
 * stays in the mutation payload — this bounds only what is drawn.
 */
export const FILE_MUTATION_MAX_LINES = 24;
const FILE_MUTATION_HEAD = 18;
const FILE_MUTATION_TAIL = 6;
const MUTATION_GUTTER = 4;

export type MutationRenderStatus = "running" | "success" | "error" | "cancelled";

export interface MutationRenderOptions {
  status?: MutationRenderStatus;
  durationMs?: number;
  maxLines?: number;
}

function mutationVerb(operation: FileMutation["operation"]): string {
  if (operation === "create") return "Wrote";
  if (operation === "delete") return "Deleted";
  return "Edited";
}

/**
 * Heading line for one mutation, e.g. `✓ Edited src/x.ts (+4 -1) · 1.2s`.
 * Uses the existing semantic write/edit palette (never a new one) and is
 * width-bounded so a long path cannot overflow a 52-col terminal.
 */
export function renderFileMutationHeading(
  mutation: FileMutation,
  status: MutationRenderStatus = "success",
  durationMs?: number,
  cols = 80,
): string {
  const icon = status === "cancelled" ? "■" : status === "error" ? "✗" : "✓";
  // Mutations are writes: create/delete use the write color, edits the edit
  // color — both owned by the theme.
  const color = mutation.operation === "update" ? theme.edit : theme.write;
  const elapsed = durationMs !== undefined ? ` ${A.dim}${A.fgMuted}· ${formatDuration(durationMs)}${A.reset}` : "";
  const hasDiff = mutation.hunks.length > 0;
  const stats = hasDiff
    ? ` ${A.dim}(${A.reset}${A.fgGreen}+${mutation.additions}${A.reset} ${A.fgRed}-${mutation.deletions}${A.reset}${A.dim})${A.reset}`
    : "";
  return truncate(`${color}${icon} ${mutationVerb(mutation.operation)} ${mutation.path}${A.reset}${stats}${elapsed}`, cols) + A.reset;
}

/** One diff row: dim line number, semantic sign, normal/ivory context. */
function renderMutationLine(line: FileMutationLine, cols: number, numberWidth: number): string {
  const lineNo = line.kind === "del" ? line.oldLine : line.newLine;
  const number = String(lineNo ?? 0).padStart(numberWidth, " ");
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  const color = line.kind === "add" ? A.fgGreen : line.kind === "del" ? A.fgRed : A.fgText;
  const textWidth = Math.max(1, cols - MUTATION_GUTTER - numberWidth - 2);
  const text = truncate(line.text, textWidth);
  return `${" ".repeat(MUTATION_GUTTER)}${A.dim}${A.fgMuted}${number}${A.reset} ${color}${sign}${text}${A.reset}`;
}

/** Bounded diff body across every hunk of one mutation. */
export function renderFileMutationBody(
  mutation: FileMutation,
  cols: number,
  maxLines = FILE_MUTATION_MAX_LINES,
): string[] {
  let maxLineNo = 1;
  for (const hunk of mutation.hunks) {
    maxLineNo = Math.max(maxLineNo, hunk.oldStart + hunk.oldCount, hunk.newStart + hunk.newCount);
    for (const line of hunk.lines) maxLineNo = Math.max(maxLineNo, line.oldLine ?? 0, line.newLine ?? 0);
  }
  const numberWidth = String(maxLineNo).length;

  const all: string[] = [];
  for (const hunk of mutation.hunks) {
    const header = `${A.dim}${A.fgSubtext}@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${A.reset}`;
    all.push(" ".repeat(MUTATION_GUTTER) + truncate(header, Math.max(1, cols - MUTATION_GUTTER)));
    for (const line of hunk.lines) all.push(renderMutationLine(line, cols, numberWidth));
  }

  if (all.length <= maxLines) return all;

  const head = all.slice(0, FILE_MUTATION_HEAD);
  const tail = all.slice(all.length - FILE_MUTATION_TAIL);
  const hidden = all.length - head.length - tail.length;
  const marker = `${A.dim}${A.fgMuted}[${hidden} lines hidden — full diff retained]${A.reset}`;
  return [...head, " ".repeat(MUTATION_GUTTER) + truncate(marker, Math.max(1, cols - MUTATION_GUTTER)), ...tail];
}

/** Heading + bounded body for one mutation, as a stable transcript block. */
export function renderFileMutation(
  mutation: FileMutation,
  cols: number,
  options: MutationRenderOptions = {},
): string[] {
  return [
    renderFileMutationHeading(mutation, options.status ?? "success", options.durationMs, cols),
    ...renderFileMutationBody(mutation, cols, options.maxLines),
  ];
}

/** Several mutations (e.g. one multi-file patch), each bounded independently. */
export function renderFileMutations(
  mutations: FileMutation[],
  cols: number,
  options: MutationRenderOptions = {},
): string[] {
  const out: string[] = [];
  for (const mutation of mutations) out.push(...renderFileMutation(mutation, cols, options));
  return out;
}
