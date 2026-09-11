/**
 * Phase 77.3 — Plugin loader.
 *
 * The pipeline is deliberately staged so a failure is always attributable:
 *
 *   RESOLVE → COMPATIBILITY → IMPORT → VALIDATE EXPORT → (INIT by the runtime)
 *
 * No stage throws to its caller: each returns a discriminated failure carrying
 * the stage and a human reason. That is what lets the runtime skip one broken
 * plugin and keep the other nine working (§77.3 "missing package → báo rõ →
 * không crash CLI").
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { getVersion } from "../../lib/version";
import { satisfiesRange } from "./compat";
import type { PluginConfigEntry, PluginDefinition, PluginLoadFailure, PluginLoadStage } from "./types";

/** Entry filenames tried, in order, when a spec points at a directory. */
const DIRECTORY_ENTRIES = ["index.js", "index.mjs", "index.cjs", "index.ts", "index.tsx", "index.jsx"];

export interface ResolvedPlugin {
  entry: PluginConfigEntry;
  /** Absolute path to the importable module. */
  target: string;
  /** Absolute path to the plugin root (directory or the file itself). */
  root: string;
}

export type ResolveResult =
  | { ok: true; value: ResolvedPlugin }
  | { ok: false; stage: PluginLoadStage; reason: string };

export type ImportResult =
  | { ok: true; value: PluginDefinition }
  | { ok: false; stage: PluginLoadStage; reason: string };

function fail(stage: PluginLoadStage, reason: string): { ok: false; stage: PluginLoadStage; reason: string } {
  return { ok: false, stage, reason };
}

/** Pick an importable entry file for a directory spec. */
function resolveDirectoryEntry(dir: string): string | null {
  const manifestPath = path.join(dir, "package.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        main?: string;
        module?: string;
      };
      const declared = manifest.module ?? manifest.main;
      if (typeof declared === "string") {
        const candidate = path.resolve(dir, declared);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      // Malformed package.json falls through to the conventional entry names.
    }
  }

  for (const name of DIRECTORY_ENTRIES) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Resolve a file-based plugin spec against the workspace root. */
function resolveFilePlugin(entry: PluginConfigEntry, workspaceRoot: string): ResolveResult {
  const absolute = path.isAbsolute(entry.spec) ? entry.spec : path.resolve(workspaceRoot, entry.spec);
  if (!fs.existsSync(absolute)) {
    return fail("resolve", `plugin path does not exist: ${absolute}`);
  }

  const stat = fs.statSync(absolute);
  if (!stat.isDirectory()) {
    return { ok: true, value: { entry, target: absolute, root: path.dirname(absolute) } };
  }

  const target = resolveDirectoryEntry(absolute);
  if (!target) {
    return fail("resolve", `no plugin entry file found in ${absolute} (tried ${DIRECTORY_ENTRIES.join(", ")})`);
  }
  return { ok: true, value: { entry, target, root: absolute } };
}

/** Resolve an npm plugin spec from the workspace's module resolution roots. */
function resolveNpmPlugin(entry: PluginConfigEntry, workspaceRoot: string): ResolveResult {
  const requireFromWorkspace = createRequire(path.join(workspaceRoot, "package.json"));
  try {
    const target = requireFromWorkspace.resolve(entry.spec);
    return { ok: true, value: { entry, target, root: path.dirname(target) } };
  } catch {
    // Not installed. Phase 77 deliberately does NOT auto-install arbitrary
    // packages at runtime — report it so the user can install intentionally.
    return fail(
      "resolve",
      `package '${entry.spec}' is not installed in this workspace (run your package manager to install it)`,
    );
  }
}

/**
 * Resolve a config entry to an importable file. File plugins never hit the
 * compatibility gate (they are local development code).
 */
export function resolvePlugin(entry: PluginConfigEntry, workspaceRoot: string): ResolveResult {
  // File plugins never hit the compatibility gate (local development code).
  if (entry.sourceKind === "file") return resolveFilePlugin(entry, workspaceRoot);
  return resolveNpmPlugin(entry, workspaceRoot);
}

/**
 * Read `compatibleToolNet` from an installed package's `toolnet` field when the
 * plugin definition itself does not declare it. npm plugins may put the range
 * in package.json instead of the module export.
 */
function readPackageCompatibility(pluginRoot: string): string | undefined {
  const manifestPath = path.join(pluginRoot, "package.json");
  if (!fs.existsSync(manifestPath)) return undefined;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      toolnet?: { compatibleToolNet?: unknown; version?: unknown };
      engines?: Record<string, unknown>;
    };
    const declared = manifest.toolnet?.compatibleToolNet;
    if (typeof declared === "string" && declared.trim()) return declared;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Compatibility gate — npm plugins only. */
export function checkCompatibility(
  resolved: ResolvedPlugin,
  definition: PluginDefinition | null,
  runningVersion: string = getVersion(),
): { ok: true } | { ok: false; reason: string } {
  if (resolved.entry.sourceKind === "file") return { ok: true };

  const range = definition?.compatibleToolNet ?? readPackageCompatibility(resolved.root);
  if (!range) return { ok: true };

  if (satisfiesRange(runningVersion, range)) return { ok: true };
  return { ok: false, reason: `requires ToolNet ${range}, running ${runningVersion}` };
}

function isPluginDefinitionShaped(value: unknown): value is PluginDefinition {
  if (!value || typeof value !== "object") return false;
  return typeof (value as { setup?: unknown }).setup === "function";
}

/**
 * Accept the module shapes a plugin author may reasonably produce:
 *   - `export default { id, setup, dispose }`   (documented form)
 *   - `export const plugin = { ... }`
 *   - `export const activate = (ctx) => ...`    (function-as-setup)
 *   - `export default function setup(ctx) {}`
 */
export function validatePluginExport(mod: unknown, spec: string): ImportResult {
  if (!mod || typeof mod !== "object") {
    return fail("validate", `plugin '${spec}' module is empty`);
  }

  const record = mod as Record<string, unknown>;
  const candidates = [record.default, record.plugin, record.definition].filter(Boolean);

  for (const candidate of candidates) {
    if (isPluginDefinitionShaped(candidate)) {
      return { ok: true, value: candidate };
    }
    // A bare function export is treated as `setup`.
    if (typeof candidate === "function") {
      return { ok: true, value: { id: derivePluginId(spec), setup: candidate as PluginDefinition["setup"] } };
    }
  }

  if (typeof record.activate === "function") {
    return { ok: true, value: { id: derivePluginId(spec), setup: record.activate as PluginDefinition["setup"] } };
  }

  return fail("validate", `plugin '${spec}' does not export a setup function (default export, 'plugin', or 'activate')`);
}

/** Derive a stable plugin id from a spec when the module does not declare one. */
export function derivePluginId(spec: string): string {
  const base = spec.replace(/\\/g, "/").split("/").pop() ?? spec;
  const withoutExt = base.replace(/\.[cm]?[jt]sx?$/, "");
  const cleaned = withoutExt.replace(/^@/, "").replace(/[^A-Za-z0-9_.-]/g, "-");
  return cleaned || "plugin";
}

/** Dynamically import a resolved plugin and validate its export shape. */
export async function importPlugin(resolved: ResolvedPlugin): Promise<ImportResult> {
  try {
    const mod = await import(pathToFileURL(resolved.target).href);
    return validatePluginExport(mod, resolved.entry.spec);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("import", `failed to import ${resolved.target}: ${message}`);
  }
}

/**
 * Full pre-init pipeline. Returns either the importable definition (ready for
 * the runtime to call `setup`) or a typed failure.
 */
export async function loadPluginModule(
  entry: PluginConfigEntry,
  workspaceRoot: string,
): Promise<{ ok: true; resolved: ResolvedPlugin; definition: PluginDefinition } | PluginLoadFailure> {
  const resolved = resolvePlugin(entry, workspaceRoot);
  if (!resolved.ok) {
    return { spec: entry.spec, stage: resolved.stage, reason: resolved.reason };
  }

  const imported = await importPlugin(resolved.value);
  if (!imported.ok) {
    return { spec: entry.spec, stage: imported.stage, reason: imported.reason };
  }

  const compatibility = checkCompatibility(resolved.value, imported.value);
  if (!compatibility.ok) {
    return { spec: entry.spec, stage: "compatibility", reason: compatibility.reason };
  }

  return { ok: true, resolved: resolved.value, definition: imported.value };
}
