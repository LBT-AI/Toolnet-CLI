/**
 * WorkspaceIndex — Lightweight multi-workspace code map.
 *
 * Provides awareness of entry points, key files, imports/exports,
 * functions/classes/interfaces, and cross-workspace dependency relationships.
 *
 * Strategy:
 *  - Regex-based lightweight scanning (no heavy AST deps)
 *  - Cached in .toolnet/index/
 *  - Incremental: only reindex changed files
 *  - Supports multiple workspace roots and cross-root mapping
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
  root: string;
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
  root?: string;
  file: string;
  line: number;
  kind: "function" | "class" | "interface" | "export" | "import";
  name: string;
}

export interface CrossWorkspaceDependency {
  fromRoot: string;
  toRoot: string;
  relationship: "package" | "tsconfig" | "import";
  detail?: string;
}

export interface CrossWorkspaceMap {
  roots: string[];
  packages: Array<{ name: string; root: string; version?: string }>;
  dependencies: CrossWorkspaceDependency[];
}

export interface MultiWorkspaceIndexData {
  roots: string[];
  indexes: Map<string, WorkspaceIndexData>;
  crossMap: CrossWorkspaceMap;
  totalFiles: number;
  lastBuilt: number;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

let cachedIndex: WorkspaceIndexData | null = null;
let cachedMultiIndex: MultiWorkspaceIndexData | null = null;

function getCacheDir(root: string): string {
  return path.join(root, ".toolnet", "index");
}

function getCachePath(root: string): string {
  return path.join(getCacheDir(root), "code-map.json");
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
    if (stat.size > 500_000) return null;
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
        /(?:import|from)\s+["'{]([^"'}]+)["']}/,
      );
      if (importMatch) imports.push(importMatch[1]);

      // Exports
      const exportMatch = trimmed.match(
        /export\s+(?:default\s+)?(?:const|function|class|interface|type|enum)\s+(\w+)/,
      );
      if (exportMatch) exports.push(exportMatch[1]);

      // Functions
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

    // Entry points
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
      root,
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

// ─── Single Workspace Index ──────────────────────────────────────────────────

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

  try {
    const cacheDir = getCacheDir(workspaceRoot);
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
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

// ─── Multi-Workspace & Cross-Workspace Mapping ───────────────────────────────

export function buildMultiWorkspaceIndex(roots: string[]): MultiWorkspaceIndexData {
  const indexes = new Map<string, WorkspaceIndexData>();
  let totalFiles = 0;

  for (const r of roots) {
    const absRoot = path.resolve(r);
    const idx = buildWorkspaceIndex(absRoot);
    indexes.set(absRoot, idx);
    totalFiles += idx.totalFiles;
  }

  const crossMap = analyzeCrossWorkspaceDependencies(roots, indexes);

  const multiIndex: MultiWorkspaceIndexData = {
    roots,
    indexes,
    crossMap,
    totalFiles,
    lastBuilt: Date.now(),
  };

  cachedMultiIndex = multiIndex;
  return multiIndex;
}

export function analyzeCrossWorkspaceDependencies(
  roots: string[],
  indexes: Map<string, WorkspaceIndexData>
): CrossWorkspaceMap {
  const packages: Array<{ name: string; root: string; version?: string }> = [];
  const dependencies: CrossWorkspaceDependency[] = [];

  // 1. Detect package.json per root
  for (const root of roots) {
    const pkgPath = path.join(root, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.name) {
          packages.push({ name: pkg.name, root, version: pkg.version });
        }
      } catch {}
    }
  }

  // 2. Detect package dependencies & tsconfig references across roots
  for (const fromRoot of roots) {
    // Package.json dependencies
    const pkgPath = path.join(fromRoot, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        const allDeps = {
          ...(pkg.dependencies || {}),
          ...(pkg.devDependencies || {}),
          ...(pkg.peerDependencies || {}),
        };

        for (const targetPkg of packages) {
          if (targetPkg.root !== fromRoot && allDeps[targetPkg.name]) {
            dependencies.push({
              fromRoot,
              toRoot: targetPkg.root,
              relationship: "package",
              detail: `Dependency on '${targetPkg.name}' (${allDeps[targetPkg.name]})`,
            });
          }
        }
      } catch {}
    }

    // tsconfig.json references
    const tsconfigPath = path.join(fromRoot, "tsconfig.json");
    if (fs.existsSync(tsconfigPath)) {
      try {
        const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
        if (Array.isArray(tsconfig.references)) {
          for (const ref of tsconfig.references) {
            if (ref.path) {
              const refAbs = path.resolve(fromRoot, ref.path);
              for (const toRoot of roots) {
                if (toRoot !== fromRoot && (refAbs === toRoot || refAbs.startsWith(toRoot))) {
                  dependencies.push({
                    fromRoot,
                    toRoot,
                    relationship: "tsconfig",
                    detail: `tsconfig project reference to '${ref.path}'`,
                  });
                }
              }
            }
          }
        }
      } catch {}
    }

    // 3. Scan imports for cross-root relative paths
    const idx = indexes.get(fromRoot);
    if (idx) {
      for (const [, file] of idx.files) {
        for (const imp of file.imports) {
          if (imp.startsWith(".")) {
            const resolvedImp = path.resolve(fromRoot, path.dirname(file.path), imp);
            for (const toRoot of roots) {
              if (toRoot !== fromRoot && resolvedImp.startsWith(toRoot)) {
                dependencies.push({
                  fromRoot,
                  toRoot,
                  relationship: "import",
                  detail: `File '${file.path}' imports from '${toRoot}' (${imp})`,
                });
              }
            }
          }
        }
      }
    }
  }

  return {
    roots,
    packages,
    dependencies,
  };
}

export function searchSymbols(query: string, rootOrRoots?: string | string[]): SymbolMatch[] {
  let roots: string[];
  if (Array.isArray(rootOrRoots)) {
    roots = rootOrRoots;
  } else if (typeof rootOrRoots === "string") {
    roots = [rootOrRoots];
  } else {
    try {
      const { getWorkspaceRoots } = require("./codingAgent");
      roots = getWorkspaceRoots();
    } catch {
      roots = [process.cwd()];
    }
  }

  const matches: SymbolMatch[] = [];
  const lower = query.toLowerCase();

  for (const root of roots) {
    const idx = (cachedIndex && cachedIndex.root === root) ? cachedIndex : buildWorkspaceIndex(root);
    for (const [, file] of idx.files) {
      for (const fn of file.functions) {
        if (fn.toLowerCase().includes(lower)) {
          matches.push({ root, file: file.path, line: 0, kind: "function", name: fn });
        }
      }
      for (const cls of file.classes) {
        if (cls.toLowerCase().includes(lower)) {
          matches.push({ root, file: file.path, line: 0, kind: "class", name: cls });
        }
      }
      for (const iface of file.interfaces) {
        if (iface.toLowerCase().includes(lower)) {
          matches.push({ root, file: file.path, line: 0, kind: "interface", name: iface });
        }
      }
    }
  }

  return matches;
}

export function findDefinition(symbolName: string, root?: string): SymbolMatch | null {
  const matches = searchSymbols(symbolName, root);
  for (const m of matches) {
    if (m.name === symbolName) return m;
  }
  return null;
}

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

export function getCrossWorkspaceCodeMap(roots?: string[]): CrossWorkspaceMap {
  const effectiveRoots = roots || (cachedMultiIndex ? cachedMultiIndex.roots : [process.cwd()]);
  const multi = cachedMultiIndex && cachedMultiIndex.roots === effectiveRoots
    ? cachedMultiIndex
    : buildMultiWorkspaceIndex(effectiveRoots);
  return multi.crossMap;
}

export function getWorkspaceIndex(root?: string): WorkspaceIndexData {
  if (cachedIndex && cachedIndex.root === (root || process.cwd())) return cachedIndex;
  return buildWorkspaceIndex(root);
}
