/**
 * Phase 77.4 — Plugin configuration.
 *
 * ONE config source. The runtime reads plugin declarations from a single
 * canonical file and normalizes them into `PluginConfigEntry[]`; nothing else
 * in the codebase parses plugin config, so there is no second "plugin config"
 * table to drift out of sync.
 *
 * Lookup order (first file that exists wins; both are merged with the workspace
 * file taking precedence for duplicate specs):
 *   1. <workspace>/.toolnet/plugins.json
 *   2. <toolnet home>/plugins.json
 */

import fs from "node:fs";
import path from "node:path";
import type { PluginConfigEntry, PluginSourceKind } from "./types";

export interface PluginConfigLoadResult {
  entries: PluginConfigEntry[];
  /** Files that were read, in precedence order. */
  files: string[];
  /** Non-fatal problems (malformed entries, unreadable JSON). */
  warnings: string[];
}

/** Decide whether a spec points at local code or an installed package. */
export function classifyPluginSpec(spec: string): PluginSourceKind {
  const trimmed = spec.trim();
  if (trimmed.startsWith(".") || trimmed.startsWith("/") || trimmed.startsWith("~")) return "file";
  // Windows absolute path (C:\... or C:/...).
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return "file";
  return "npm";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Normalize a single raw entry. Returns null for entries that cannot be
 * interpreted — the caller records a warning rather than throwing, so one bad
 * line never disables every other plugin.
 */
export function normalizePluginEntry(raw: unknown): PluginConfigEntry | null {
  if (typeof raw === "string") {
    const spec = raw.trim();
    if (!spec) return null;
    return { spec, enabled: true, options: {}, sourceKind: classifyPluginSpec(spec) };
  }

  const record = asRecord(raw);
  if (!record) return null;

  const specCandidate = record.package ?? record.path ?? record.spec ?? record.module;
  if (typeof specCandidate !== "string" || !specCandidate.trim()) return null;
  const spec = specCandidate.trim();

  return {
    spec,
    enabled: record.enabled === undefined ? true : Boolean(record.enabled),
    options: asRecord(record.options) ?? {},
    // An explicit `path` field forces the file interpretation.
    sourceKind: record.path !== undefined ? "file" : classifyPluginSpec(spec),
  };
}

/**
 * Extract entries from a parsed config document. Supports both the documented
 * `{ "plugins": [...] }` shape and a bare array.
 */
export function extractPluginEntries(doc: unknown): { entries: PluginConfigEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  let rawList: unknown;

  if (Array.isArray(doc)) {
    rawList = doc;
  } else {
    const record = asRecord(doc);
    if (!record) {
      return { entries: [], warnings: ["plugins config is not an object or array"] };
    }
    rawList = record.plugins ?? record.extensions ?? [];
  }

  if (!Array.isArray(rawList)) {
    return { entries: [], warnings: ["'plugins' must be an array"] };
  }

  const entries: PluginConfigEntry[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const normalized = normalizePluginEntry(rawList[i]);
    if (!normalized) {
      warnings.push(`plugins[${i}] is not a valid plugin declaration — skipped`);
      continue;
    }
    entries.push(normalized);
  }
  return { entries, warnings };
}

/** Read and normalize one config file. Missing file is not an error. */
function readConfigFile(file: string): PluginConfigLoadResult {
  const result: PluginConfigLoadResult = { entries: [], files: [], warnings: [] };
  if (!fs.existsSync(file)) return result;

  result.files.push(file);
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    result.warnings.push(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    return result;
  }

  const extracted = extractPluginEntries(doc);
  result.entries = extracted.entries;
  result.warnings.push(...extracted.warnings.map((w) => `${file}: ${w}`));
  return result;
}

export interface LoadPluginConfigOptions {
  workspaceRoot: string;
  /** Overrides the global config location (used by tests). */
  globalConfigPath?: string;
}

/**
 * Load plugin config from the canonical locations.
 *
 * Duplicate specs collapse to one entry: the workspace declaration wins, which
 * keeps a project able to pin/disable a globally configured plugin.
 */
export function loadPluginConfig(options: LoadPluginConfigOptions): PluginConfigLoadResult {
  const workspaceRoot = options.workspaceRoot || process.cwd();
  const candidates = [path.join(workspaceRoot, ".toolnet", "plugins.json")];
  if (options.globalConfigPath) candidates.push(options.globalConfigPath);

  const merged: PluginConfigLoadResult = { entries: [], files: [], warnings: [] };
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const loaded = readConfigFile(candidate);
    merged.files.push(...loaded.files);
    merged.warnings.push(...loaded.warnings);
    for (const entry of loaded.entries) {
      const key = entry.spec.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.entries.push(entry);
    }
  }

  return merged;
}
