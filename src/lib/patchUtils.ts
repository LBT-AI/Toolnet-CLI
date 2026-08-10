import fs from "node:fs";
import path from "node:path";
import { pushSnapshot, commitSnapshot } from "./history";
import { isPathInsideWorkspace, evaluatePermission } from "./permissions";
import type { ToolResult } from "./codingAgent";

export interface Hunk {
  oldStart: number;
  oldLinesCount: number;
  newStart: number;
  newLinesCount: number;
  lines: string[];
}

export interface FilePatch {
  oldPath: string;
  newPath: string;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

export function parseUnifiedDiff(diffText: string): FilePatch[] {
  const patches: FilePatch[] = [];
  const lines = diffText.split(/\r?\n/);
  let currentPatch: FilePatch | null = null;
  let currentHunk: Hunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("--- ")) {
      const rawPath = line.slice(4).trim();
      let cleanPath = rawPath.replace(/^[ab]\//, "");
      if (cleanPath === "/dev/null") cleanPath = "";

      if (!currentPatch) {
        currentPatch = {
          oldPath: cleanPath,
          newPath: "",
          isNew: cleanPath === "",
          isDeleted: false,
          hunks: [],
        };
      } else {
        currentPatch.oldPath = cleanPath;
      }
    } else if (line.startsWith("+++ ")) {
      const rawPath = line.slice(4).trim();
      let cleanPath = rawPath.replace(/^[ab]\//, "");
      if (cleanPath === "/dev/null") cleanPath = "";

      if (!currentPatch) {
        currentPatch = {
          oldPath: "",
          newPath: cleanPath,
          isNew: false,
          isDeleted: cleanPath === "",
          hunks: [],
        };
      } else {
        currentPatch.newPath = cleanPath;
        if (cleanPath === "") currentPatch.isDeleted = true;
        if (currentPatch.oldPath === "") currentPatch.isNew = true;
      }
    } else if (line.startsWith("@@ ")) {
      if (!currentPatch) {
        currentPatch = { oldPath: "", newPath: "", isNew: false, isDeleted: false, hunks: [] };
      }
      const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      if (match) {
        currentHunk = {
          oldStart: parseInt(match[1], 10),
          oldLinesCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
          newStart: parseInt(match[3], 10),
          newLinesCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
          lines: [],
        };
        currentPatch.hunks.push(currentHunk);
      }
    } else if (currentHunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "")) {
      if (line !== "*** End Patch ***" && !line.startsWith("diff --git")) {
        currentHunk.lines.push(line);
      }
    } else if (line.startsWith("diff --git")) {
      if (currentPatch && (currentPatch.hunks.length > 0 || currentPatch.newPath || currentPatch.oldPath)) {
        patches.push(currentPatch);
      }
      currentPatch = null;
      currentHunk = null;
    }
  }

  if (currentPatch && (currentPatch.hunks.length > 0 || currentPatch.newPath || currentPatch.oldPath)) {
    patches.push(currentPatch);
  }

  return patches;
}

export function applyHunksToContent(originalContent: string, hunks: Hunk[]): { success: boolean; content?: string; error?: string } {
  let lines = originalContent ? originalContent.split("\n") : [];
  
  for (const hunk of hunks) {
    const patchLines = hunk.lines;
    const oldLines: string[] = [];
    const newLines: string[] = [];

    for (const pl of patchLines) {
      if (pl.startsWith("-")) {
        oldLines.push(pl.slice(1));
      } else if (pl.startsWith("+")) {
        newLines.push(pl.slice(1));
      } else if (pl.startsWith(" ")) {
        oldLines.push(pl.slice(1));
        newLines.push(pl.slice(1));
      }
    }

    if (oldLines.length === 0 && newLines.length > 0) {
      const targetIdx = Math.max(0, Math.min(lines.length, hunk.newStart - 1));
      lines.splice(targetIdx, 0, ...newLines);
      continue;
    }

    let startIdx = Math.max(0, hunk.oldStart - 1);
    let matchIdx = -1;

    const searchRange = Math.max(lines.length, 50);
    for (let offset = 0; offset < searchRange; offset++) {
      const checkIndices = [startIdx + offset, startIdx - offset].filter(i => i >= 0 && i <= lines.length - oldLines.length);
      for (const idx of checkIndices) {
        let isMatch = true;
        for (let i = 0; i < oldLines.length; i++) {
          if (lines[idx + i] !== oldLines[i]) {
            isMatch = false;
            break;
          }
        }
        if (isMatch) {
          matchIdx = idx;
          break;
        }
      }
      if (matchIdx >= 0) break;
    }

    if (matchIdx < 0) {
      return {
        success: false,
        error: `Failed to locate matching patch context at line ${hunk.oldStart}. Expected pattern:\n${oldLines.slice(0, 5).join("\n")}`
      };
    }

    lines.splice(matchIdx, oldLines.length, ...newLines);
  }

  return { success: true, content: lines.join("\n") };
}

export function generateDiff(oldContent: string, newContent: string, fileName = "file"): string {
  const oldLines = oldContent ? oldContent.split("\n") : [];
  const newLines = newContent ? newContent.split("\n") : [];

  if (oldContent === newContent) return "";

  const diffOutput: string[] = [];
  diffOutput.push(`--- a/${fileName}`);
  diffOutput.push(`+++ b/${fileName}`);
  diffOutput.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);

  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      diffOutput.push(` ${oldLines[i]}`);
      i++;
      j++;
    } else {
      if (i < oldLines.length) {
        diffOutput.push(`-${oldLines[i]}`);
        i++;
      }
      if (j < newLines.length) {
        diffOutput.push(`+${newLines[j]}`);
        j++;
      }
    }
  }

  return diffOutput.join("\n");
}

export function applyStructuredPatch(patchText: string, cwd: string): ToolResult {
  if (!patchText || !patchText.trim()) {
    return { success: false, error: "Empty patch provided." };
  }

  const patches = parseUnifiedDiff(patchText);
  if (patches.length === 0) {
    return { success: false, error: "No valid unified diff hunks found in patch." };
  }

  const results: string[] = [];

  for (const p of patches) {
    const targetFile = p.newPath || p.oldPath;
    if (!targetFile) continue;

    const absPath = path.isAbsolute(targetFile) ? path.normalize(targetFile) : path.resolve(cwd, targetFile);
    const pathCheck = isPathInsideWorkspace(absPath, cwd, cwd);

    if (!pathCheck.isInside) {
      return { success: false, error: `Patch target path "${targetFile}" is outside workspace.` };
    }

    let oldContent = "";
    if (fs.existsSync(absPath)) {
      try {
        oldContent = fs.readFileSync(absPath, "utf8");
      } catch (err: any) {
        return { success: false, error: `Failed to read file ${targetFile}: ${err.message}` };
      }
    }

    const res = applyHunksToContent(oldContent, p.hunks);
    if (!res.success || res.content === undefined) {
      return { success: false, error: `Failed applying patch to ${targetFile}: ${res.error}` };
    }

    // Push snapshot before writing to history so /undo works 100%
    pushSnapshot(absPath, `apply_patch on ${targetFile}`);

    try {
      const parentDir = path.dirname(absPath);
      if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
      fs.writeFileSync(absPath, res.content, "utf8");
      commitSnapshot(absPath);

      const diffPreview = generateDiff(oldContent, res.content, targetFile);
      results.push(`Applied patch to ${targetFile}:\n${diffPreview}`);
    } catch (err: any) {
      return { success: false, error: `Failed writing patch to ${targetFile}: ${err.message}` };
    }
  }

  return {
    success: true,
    data: results.join("\n\n")
  };
}
