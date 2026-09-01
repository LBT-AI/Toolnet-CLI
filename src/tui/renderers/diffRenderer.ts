import { A } from "../../term";
import { truncate, stripAnsi } from "../layout";

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
