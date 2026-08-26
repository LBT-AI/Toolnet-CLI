/**
 * WorkspaceIndex — Lightweight workspace code map.
 *
 * Provides awareness of entry points, key files, imports/exports,
 * functions/classes/interfaces, and dependency relationships.
 *
 * Strategy:
 *  - Regex-based lightweight scanning (no heavy AST deps)
 *  - Cached in .toolnet/index/
 *  - Incremental: only reindex changed files
 *  - Skips node_modules, dist, build, .git, binary/media
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ─── Config ──────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", ".git", ".toolnet", "dist-bin",
  "__pycache__", ".next", ".nuxt", "coverage", ".cache",
]);

const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2",
  ".ttf", ".eot", ".mp3", ".mp4", ".webm", ".zip", ".tar", ".gz",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".lock",
]);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FileIndex {
  path: string;
  hash: string;
  lastModified: number;
  size: number;
  imports: string[];
  exports: string[];
  functions: string[];
  classes: string[];
  interfaces: string[];
  isEntry: boolean;
}

export interface WorkspaceIndexData {
  root: string;
  files: Map<string, FileIndex>;
  entryPoints: string[];
  lastBuilt: number;
  totalFiles: number;
}

export interface SymbolMatch {
  file: string;
  line: number;
  kind: "function" | "class" | "interface" | "export" | "import";
  name: string;
}

// ─── Index ───────────────────────────────────────────────────────────────────

let cachedIndex: WorkspaceIndexData | null = null;

function getCacheDir(root: string): string {
  return path.join(root, ".toolnet", "index");
}

function getCachePath(root: string): string {
  return path.join(getCacheDir(root), "code-map.json");
}

function hashFile(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return crypto.createHash("md5").update(content).digest("hex");
  } catch {
    return "";
  }
}

function shouldSkip(dir: string): boolean {
  const base = path.basename(dir);
  return SKIP_DIRS.has(base) || base.startsWith(".");
}

function shouldSkipFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SKIP_EXTENSIONS.has(ext);
}

function isSourceFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext);
}

// ─── File Scanning ───────────────────────────────────────────────────────────

function scanFile(filePath: string, root: string): FileIndex | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 500_000) return null; // skip huge files
    const content = fs.readFileSync(filePath, "utf8");
    const hash = crypto.createHash("md5").update(content).digest("hex");
    const relPath = path.relative(root, filePath);

    const imports: string[] = [];
    const exports: string[] = [];
    const functions: string[] = [];
    const classes: string[] = [];
    const interfaces: string[] = [];

    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();

      // Imports
      const importMatch = trimmed.match(
        /(?:import|from)\s+["'{]([^"'}]+)["'}]/,
      );
      if (importMatch) imports.push(importMatch[1]);

      // Exports
      const exportMatch = trimmed.match(
        /export\s+(?:default\s+)?(?:const|function|class|interface|type|enum)\s+(\w+)/,
      );
      if (exportMatch) exports.push(exportMatch[1]);

      // Functions (const/let/var arrow, or function keyword)
      const fnMatch = trimmed.match(
        /(?:(?:export|async)\s+)*function\s+(\w+)/,
      );
      if (fnMatch && !functions.includes(fnMatch[1])) functions.push(fnMatch[1]);

      const arrowFn = trimmed.match(
        /(?:export|const|let|var)\s+(?:async\s+)?(\w+)\s*(?::\s*\w+)?\s*=\s*(?:async\s*)?\(/,
      );
      if (arrowFn && !functions.includes(arrowFn[1])) functions.push(arrowFn[1]);

      // Classes
      const classMatch = trimmed.match(/class\s+(\w+)/);
      if (classMatch && !classes.includes(classMatch[1])) classes.push(classMatch[1]);

      // Interfaces
      const ifaceMatch = trimmed.match(/interface\s+(\w+)/);
      if (ifaceMatch && !interfaces.includes(ifaceMatch[1])) interfaces.push(ifaceMatch[1]);
    }

    // Entry point detection
    const isEntry =
      relPath === "src/index.tsx" ||
      relPath === "src/index.ts" ||
      relPath === "src/main.ts" ||
      relPath === "src/main.tsx" ||
      relPath === "src/app.ts" ||
      relPath === "src/app.tsx" ||
      relPath.endsWith("/index.ts") ||
      relPath.endsWith("/index.tsx");

    return {
      path: relPath,
      hash,
      lastModified: stat.mtimeMs,
      size: stat.size,
      imports,
      exports,
      functions,
      classes,
      interfaces,
      isEntry,
    };
  } catch {
    return null;
  }
}

function walkDir(dir: string, root: string, results: string[]): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkip(entry.name)) walkDir(fullPath, root, results);
      } else if (entry.isFile() && isSourceFile(fullPath) && !shouldSkipFile(fullPath)) {
        results.push(fullPath);
      }
    }
  } catch {}
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build a fresh workspace index. Scans all source files recursively.
 */
export function buildWorkspaceIndex(root?: string): WorkspaceIndexData {
  const workspaceRoot = root || process.cwd();
  const files = new Map<string, FileIndex>();
  const entryPoints: string[] = [];

  const sourceFiles: string[] = [];
  walkDir(workspaceRoot, workspaceRoot, sourceFiles);

  for (const filePath of sourceFiles) {
    const idx = scanFile(filePath, workspaceRoot);
    if (idx) {
      files.set(idx.path, idx);
      if (idx.isEntry) entryPoints.push(idx.path);
    }
  }

  const index: WorkspaceIndexData = {
    root: workspaceRoot,
    files,
    entryPoints,
    lastBuilt: Date.now(),
    totalFiles: files.size,
  };

  cachedIndex = index;

  // Persist to disk
  try {
    const cacheDir = getCacheDir(workspaceRoot);
    fs.mkdirSync(cacheDir, { recursive: true });
    const serializable = {
      ...index,
      files: Object.fromEntries(index.files),
    };
    fs.writeFileSync(getCachePath(workspaceRoot), JSON.stringify(serializable, null, 2));
  } catch {}

  return index;
}

/**
 * Update index for a single file. Called when a file is modified.
 */
export function updateFileIndex(filePath: string, root?: string): FileIndex | null {
  const workspaceRoot = root || process.cwd();
  const relPath = path.relative(workspaceRoot, filePath);

  if (!isSourceFile(filePath)) return null;

  const idx = scanFile(filePath, workspaceRoot);
  if (!idx) return null;

  if (!cachedIndex || cachedIndex.root !== workspaceRoot) {
    cachedIndex = buildWorkspaceIndex(workspaceRoot);
  }

  cachedIndex.files.set(relPath, idx);
  return idx;
}

/**
 * Search for symbols (functions, classes, interfaces) by name.
 */
export function searchSymbols(query: string, root?: string): SymbolMatch[] {
  const index = cachedIndex || buildWorkspaceIndex(root);
  const matches: SymbolMatch[] = [];
  const lower = query.toLowerCase();

  for (const [, file] of index.files) {
    for (const fn of file.functions) {
      if (fn.toLowerCase().includes(lower)) {
        matches.push({ file: file.path, line: 0, kind: "function", name: fn });
      }
    }
    for (const cls of file.classes) {
      if (cls.toLowerCase().includes(lower)) {
        matches.push({ file: file.path, line: 0, kind: "class", name: cls });
      }
    }
    for (const iface of file.interfaces) {
      if (iface.toLowerCase().includes(lower)) {
        matches.push({ file: file.path, line: 0, kind: "interface", name: iface });
      }
    }
  }

  return matches;
}

/**
 * Find where a symbol is defined (exported from).
 */
export function findDefinition(symbolName: string, root?: string): SymbolMatch | null {
  const index = cachedIndex || buildWorkspaceIndex(root);

  for (const [, file] of index.files) {
    if (file.exports.includes(symbolName)) {
      const kind = file.functions.includes(symbolName)
        ? "function"
        : file.classes.includes(symbolName)
        ? "class"
        : file.interfaces.includes(symbolName)
        ? "interface"
        : "export";
      return { file: file.path, line: 0, kind, name: symbolName };
    }
  }
  return null;
}

/**
 * Find files that reference a symbol (via imports).
 */
export function findReferences(symbolName: string, root?: string): string[] {
  const index = cachedIndex || buildWorkspaceIndex(root);
  const refs: string[] = [];

  for (const [, file] of index.files) {
    if (file.imports.some((imp) => imp.includes(symbolName))) {
      refs.push(file.path);
    }
  }
  return refs;
}

/**
 * Get the full code map as a structured object.
 */
export function getCodeMap(root?: string): {
  entryPoints: string[];
  totalFiles: number;
  files: Array<{ path: string; functions: string[]; classes: string[]; interfaces: string[] }>;
} {
  const index = cachedIndex || buildWorkspaceIndex(root);
  return {
    entryPoints: index.entryPoints,
    totalFiles: index.totalFiles,
    files: Array.from(index.files.values()).map((f) => ({
      path: f.path,
      functions: f.functions,
      classes: f.classes,
      interfaces: f.interfaces,
    })),
  };
}

/**
 * Get cached index or build fresh.
 */
export function getWorkspaceIndex(root?: string): WorkspaceIndexData {
  if (cachedIndex && cachedIndex.root === (root || process.cwd())) return cachedIndex;
  return buildWorkspaceIndex(root);
}
