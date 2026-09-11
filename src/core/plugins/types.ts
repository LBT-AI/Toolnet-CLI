/**
 * Phase 77.1/77.2 — Canonical Plugin Contract
 *
 * A plugin is a small, explicit integration bundle: it declares what it can do
 * (capabilities), registers tools and hooks through the provided context, and
 * gets a `dispose` hook so nothing leaks.
 *
 * A plugin NEVER receives raw runtime internals. It can only:
 *   - register tools  → land in the canonical toolRegistry (never a side table)
 *   - register hooks  → land in the canonical hookRegistry
 * There is no direct provider, executor or permission access on the context.
 */

import type { HookFailurePolicy, HookHandler, HookName } from "../hooks";
import type { ToolRisk } from "../../lib/harness/toolRegistry";

export interface PluginCapabilities {
  tools?: boolean;
  hooks?: boolean;
  providers?: boolean;
  mcp?: boolean;
}

/** Context handed to a plugin during `setup`. Deliberately narrow + readonly. */
export interface PluginContext {
  /** Workspace the runtime was initialized for. */
  workspaceRoot: string;
  pluginId: string;
  /** Structured logger namespaced to the plugin id. */
  logger: PluginLogger;
  /** Per-plugin options from config (`{ package, options }`). Immutable. */
  config: Readonly<Record<string, unknown>>;
  /** Register a model-callable tool. Canonical name: `plugin__<id>__<name>`. */
  registerTool: (tool: PluginToolRegistration) => void;
  /** Register a lifecycle hook. */
  registerHook: (
    name: HookName,
    handler: HookHandler,
    options?: { failurePolicy?: HookFailurePolicy; priority?: number; timeoutMs?: number },
  ) => void;
}

export interface PluginLogger {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

/** What a plugin may return from `setup` instead of calling the context. */
export interface PluginHooks {
  tools?: PluginToolRegistration[];
  hooks?: Array<{
    name: HookName;
    handler: HookHandler;
    failurePolicy?: HookFailurePolicy;
    priority?: number;
    timeoutMs?: number;
  }>;
}

/** A tool contributed by a plugin. `name` is the BARE name, not namespaced. */
export interface PluginToolRegistration {
  /** Bare tool name; the runtime namespaces it to `plugin__<id>__<name>`. */
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  /** Risk tier used by the security engine. Defaults to "write". */
  risk?: ToolRisk;
  /** Return value is normalized to a tool-result JSON envelope. */
  execute: (input: Record<string, unknown>, context: PluginToolContext) => unknown | Promise<unknown>;
}

export interface PluginToolContext {
  workspaceRoot: string;
  cwd: string;
  pluginId: string;
  sessionId?: string;
  signal?: AbortSignal;
}

/**
 * The module shape a plugin entry file must export (default, or a named
 * `plugin` / `activate` export). Everything is explicit — no global patching.
 */
export interface PluginDefinition {
  id: string;
  name?: string;
  version?: string;
  /** Semver range checked against the running ToolNet version. */
  compatibleToolNet?: string;
  capabilities?: PluginCapabilities;
  setup: (context: PluginContext) => Promise<PluginHooks | void> | PluginHooks | void;
  dispose?: () => Promise<void> | void;
}

// ── Config ───────────────────────────────────────────────────────────────────

/** One normalized plugin declaration from `.toolnet/plugins.json`. */
export interface PluginConfigEntry {
  /** File path (relative to workspace) or npm package specifier. */
  spec: string;
  enabled: boolean;
  options: Record<string, unknown>;
  /** "file" entries are treated as local development code. */
  sourceKind: PluginSourceKind;
}

export type PluginSourceKind = "file" | "npm";

// ── Load pipeline results ────────────────────────────────────────────────────

export type PluginLoadStage = "config" | "resolve" | "compatibility" | "import" | "validate" | "init";

export interface PluginLoadFailure {
  spec: string;
  stage: PluginLoadStage;
  reason: string;
}

export interface LoadedPluginRecord {
  id: string;
  name: string;
  version?: string;
  spec: string;
  sourceKind: PluginSourceKind;
  resolvedPath?: string;
  /** Canonical tool names registered by this plugin. */
  toolNames: string[];
  /** Number of hooks registered by this plugin. */
  hookCount: number;
  loadedAt: number;
}

export interface PluginLoadReport {
  loaded: LoadedPluginRecord[];
  failures: PluginLoadFailure[];
}

/** Namespaced canonical tool name for a plugin tool. */
export function pluginToolName(pluginId: string, toolName: string): string {
  return `plugin__${sanitizeNamePart(pluginId)}__${sanitizeNamePart(toolName)}`;
}

/** Permission resource id for a plugin tool, e.g. `plugin:my-plugin/read_fixture`. */
export function pluginPermissionResource(pluginId: string, toolName: string): string {
  return `plugin:${pluginId}/${toolName}`;
}

/** Provider-legal charset (OpenAI function names allow [A-Za-z0-9_-]). */
export function sanitizeNamePart(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "x";
}
