/**
 * Structured file mutations + a deterministic line diff.
 *
 * The tool layer (write/edit/replace/patch) already knows the before and after
 * bytes of every mutation. This module turns that into ONE structured payload
 * (`FileMutation`) with real, line-numbered hunks — computed here, never parsed
 * back out of rendered text or assistant prose.
 *
 * The diff is a proper LCS alignment, not a positional walk, so an insertion is
 * reported as `+new` (not `-old +new`), and multiple distant edits come out as
 * multiple hunks. It is fully deterministic: same inputs, same hunks.
 */

import type {
  FileMutation,
  FileMutationHunk,
  FileMutationLine,
  FileMutationOperation,
} from "../core/contracts";

/** Context lines kept around each change, matching a standard unified diff. */
export const DIFF_CONTEXT_LINES = 3;

/** Above this many DP cells we fall back to a coarse (still deterministic) diff. */
const MAX_LCS_CELLS = 4_000_000;

interface RawOp {
  kind: "context" | "add" | "del";
  text: string;
}

/** Split content into diff lines, normalizing CRLF and dropping the trailing newline. */
export function splitDiffLines(content: string | null | undefined): string[] {
  if (!content) return [];
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Longest-common-subsequence op list. Pre/suffix trimming keeps the DP small. */
function lcsOps(oldLines: string[], newLines: string[]): RawOp[] {
  let start = 0;
  const maxStart = Math.min(oldLines.length, newLines.length);
  while (start < maxStart && oldLines[start] === newLines[start]) start++;

  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--;
    endNew--;
  }

  const ops: RawOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: "context", text: oldLines[i] });

  const midOld = oldLines.slice(start, endOld);
  const midNew = newLines.slice(start, endNew);
  ops.push(...middleOps(midOld, midNew));

  // Suffix context: identical lines, aligned on the post-image.
  for (let i = endOld; i < oldLines.length; i++) ops.push({ kind: "context", text: oldLines[i] });
  return ops;
}

function middleOps(a: string[], b: string[]): RawOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ kind: "add" as const, text }));
  if (m === 0) return a.map((text) => ({ kind: "del" as const, text }));

  // Coarse fallback: all deletions then all additions. Deterministic, keeps
  // insert/delete/replace semantics even for pathological inputs.
  if (n * m > MAX_LCS_CELLS) {
    return [
      ...a.map((text) => ({ kind: "del" as const, text })),
      ...b.map((text) => ({ kind: "add" as const, text })),
    ];
  }

  // dp[i][j] = LCS length of a[i..] and b[j..], flattened into one array.
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }

  const ops: RawOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "context", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push({ kind: "del", text: a[i] });
      i++;
    } else {
      ops.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++] });
  while (j < m) ops.push({ kind: "add", text: b[j++] });
  return ops;
}

/** Assign 1-based pre/post-image line numbers while walking the op list. */
function numberOps(ops: RawOp[]): FileMutationLine[] {
  let oldLine = 1;
  let newLine = 1;
  return ops.map((op) => {
    if (op.kind === "context") {
      return { kind: op.kind, text: op.text, oldLine: oldLine++, newLine: newLine++ };
    }
    if (op.kind === "add") {
      return { kind: op.kind, text: op.text, newLine: newLine++ };
    }
    return { kind: op.kind, text: op.text, oldLine: oldLine++ };
  });
}

/** Group numbered lines into hunks, each wrapped in DIFF_CONTEXT_LINES of context. */
function groupHunks(lines: FileMutationLine[]): FileMutationHunk[] {
  const changeIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== "context") changeIndices.push(i);
  }
  if (changeIndices.length === 0) return [];

  const windows: Array<[number, number]> = [];
  for (const idx of changeIndices) {
    const start = Math.max(0, idx - DIFF_CONTEXT_LINES);
    const end = Math.min(lines.length - 1, idx + DIFF_CONTEXT_LINES);
    const last = windows[windows.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      windows.push([start, end]);
    }
  }

  return windows.map(([start, end]) => {
    const slice = lines.slice(start, end + 1);
    const firstOld = slice.find((line) => line.oldLine !== undefined)?.oldLine;
    const firstNew = slice.find((line) => line.newLine !== undefined)?.newLine;
    return {
      oldStart: firstOld ?? 1,
      oldCount: slice.filter((line) => line.kind !== "add").length,
      newStart: firstNew ?? 1,
      newCount: slice.filter((line) => line.kind !== "del").length,
      lines: slice,
    };
  });
}

/**
 * Build the structured mutation for one file. `before` is null/"" for a created
 * file and `after` is null/"" for a deleted file.
 */
export function buildFileMutation(
  path: string,
  operation: FileMutationOperation,
  before: string | null | undefined,
  after: string | null | undefined,
): FileMutation {
  const numbered = numberOps(lcsOps(splitDiffLines(before), splitDiffLines(after)));
  const hunks = groupHunks(numbered);
  return {
    path,
    operation,
    additions: numbered.filter((line) => line.kind === "add").length,
    deletions: numbered.filter((line) => line.kind === "del").length,
    hunks,
  };
}

/** Render structured hunks back into a unified-diff string (human/legacy view). */
export function unifiedDiffFromMutation(mutation: FileMutation): string {
  if (mutation.hunks.length === 0) return "";
  const out: string[] = [`--- a/${mutation.path}`, `+++ b/${mutation.path}`];
  for (const hunk of mutation.hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (const line of hunk.lines) {
      const prefix = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
      out.push(prefix + line.text);
    }
  }
  return out.join("\n");
}
