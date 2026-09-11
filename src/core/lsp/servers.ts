/**
 * Phase 74 — Language-server registry and discovery.
 *
 * ToolNet never installs a language server. It only *finds* one that the user
 * already has (project-local `node_modules/.bin` first, then `PATH`). When
 * nothing is found the caller reports the capability as unavailable and the
 * agent falls back to grep/read_file — a missing server never fails a task.
 */

import fs from "node:fs";
import path from "node:path";
import { extensionOf } from "./languages";
import type { LspServerSpec } from "./types";

/** Built-in server definitions, richest language coverage first. */
export const LSP_SERVERS: LspServerSpec[] = [
  {
    id: "typescript",
    languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    extensions: [".ts", ".mts", ".cts", ".tsx", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".jsx"],
    binaries: ["typescript-language-server"],
    args: ["--stdio"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"],
  },
  {
    id: "pyright",
    languageIds: ["python"],
    extensions: [".py", ".pyi"],
    binaries: ["pyright-langserver", "basedpyright-langserver"],
    args: ["--stdio"],
    rootMarkers: ["pyproject.toml", "pyrightconfig.json", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "uv.lock", "poetry.lock"],
  },
  {
    id: "gopls",
    languageIds: ["go"],
    extensions: [".go"],
    binaries: ["gopls"],
    args: [],
    rootMarkers: ["go.mod", "go.work"],
  },
  {
    id: "rust-analyzer",
    languageIds: ["rust"],
    extensions: [".rs"],
    binaries: ["rust-analyzer"],
    args: [],
    rootMarkers: ["Cargo.toml"],
  },
  {
    id: "clangd",
    languageIds: ["c", "cpp"],
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx"],
    binaries: ["clangd"],
    args: [],
    rootMarkers: ["compile_commands.json", "CMakeLists.txt", "Makefile"],
  },
  {
    id: "jdtls",
    languageIds: ["java"],
    extensions: [".java"],
    binaries: ["jdtls"],
    args: [],
    rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle"],
  },
  {
    id: "intelephense",
    languageIds: ["php"],
    extensions: [".php"],
    binaries: ["intelephense"],
    args: ["--stdio"],
    rootMarkers: ["composer.json"],
  },
];

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function withWindowsExtensions(candidate: string): string[] {
  if (process.platform !== "win32") return [candidate];
  const pathext = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean);
  return [candidate, ...pathext.map((ext) => `${candidate}${ext.toLowerCase()}`)];
}

/** Walk from `start` up to `stop` (inclusive) looking for `dirName/name`. */
function findUp(start: string, stop: string, dirName: string, name: string): string | undefined {
  let current = path.resolve(start);
  const boundary = path.resolve(stop);
  while (true) {
    const candidate = path.join(current, dirName, ...withWindowsExtensions(name));
    if (isExecutableFile(candidate)) return candidate;
    if (current === boundary) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function findOnPath(name: string): string | undefined {
  const entries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, name);
    for (const variant of withWindowsExtensions(candidate)) {
      if (isExecutableFile(variant)) return variant;
    }
  }
  return undefined;
}

/**
 * Resolve the first available binary for a server. Project-local
 * `node_modules/.bin` wins over a global install; both are checked in the order
 * the spec lists its candidates.
 */
export function resolveServerBinary(
  spec: LspServerSpec,
  options: { root: string; workspaceRoot: string }
): string | undefined {
  for (const name of spec.binaries) {
    const local = findUp(options.root, options.workspaceRoot, path.join("node_modules", ".bin"), name);
    if (local) return local;
  }
  for (const name of spec.binaries) {
    const global = findOnPath(name);
    if (global) return global;
  }
  return undefined;
}

/** Pick the server whose extension set covers `filePath`. */
export function selectServerForFile(
  filePath: string,
  servers: LspServerSpec[] = LSP_SERVERS
): LspServerSpec | undefined {
  const ext = extensionOf(filePath);
  if (!ext) return undefined;
  return servers.find((spec) => spec.extensions.includes(ext));
}

/**
 * Nearest ancestor containing a project marker, clamped to the workspace root.
 * Falling back to the workspace root keeps servers usable in marker-less trees.
 */
export function findServerRoot(
  spec: LspServerSpec,
  filePath: string,
  workspaceRoot: string
): string {
  const boundary = path.resolve(workspaceRoot);
  let current = path.dirname(path.resolve(filePath));
  while (true) {
    for (const marker of spec.rootMarkers) {
      if (fs.existsSync(path.join(current, marker))) return current;
    }
    if (current === boundary) return boundary;
    const parent = path.dirname(current);
    if (parent === current) return boundary;
    if (!current.startsWith(boundary)) return boundary;
    current = parent;
  }
}

/**
 * Find a representative file so a workspace-scoped operation (e.g.
 * `workspace_symbols`) can choose a server without being given a path.
 * Best effort: scans the workspace root and its immediate children.
 */
export function pickProbeFile(workspaceRoot: string, servers: LspServerSpec[] = LSP_SERVERS): string | undefined {
  const extensions = new Set(servers.flatMap((spec) => spec.extensions));
  const skipDirs = new Set(["node_modules", ".git", "dist", "build", "out", "target", ".next", "vendor"]);

  const scan = (dir: string, depth: number): string | undefined => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (entry.isFile() && extensions.has(extensionOf(entry.name))) {
        return path.join(dir, entry.name);
      }
    }
    if (depth <= 0) return undefined;
    for (const entry of entries) {
      if (!entry.isDirectory() || skipDirs.has(entry.name) || entry.name.startsWith(".")) continue;
      const found = scan(path.join(dir, entry.name), depth - 1);
      if (found) return found;
    }
    return undefined;
  };

  return scan(path.resolve(workspaceRoot), 2);
}
