/**
 * Phase 77.1/77.10/77.11/77.25 — The one PluginRuntime.
 *
 * Responsibilities are narrow and explicit:
 *   - load configured plugins through the staged loader
 *   - call `setup` with a narrow context and collect what it registered
 *   - put tools into the CANONICAL toolRegistry (namespaced `plugin__<id>__<t>`)
 *   - put hooks into the CANONICAL hookRegistry, in plugin load order
 *   - execute a plugin tool on behalf of the gateway (no second permission path)
 *   - dispose everything on shutdown
 *
 * A plugin never gets an execution path of its own: the model calls a plugin
 * tool exactly like any built-in, and the gateway has already made the
 * permission decision by the time `executeRegisteredTool` runs.
 */

import path from "node:path";
import { toolRegistry, type ToolDefinition, type ToolRisk } from "../../lib/harness/toolRegistry";
import { securityEngine } from "../../lib/security/securityEngine";
import { hookRegistry } from "../hooks";
import type { HookFailurePolicy, HookHandler, HookName } from "../hooks";
import { loadPluginConfig } from "./config";
import { derivePluginId, loadPluginModule } from "./loader";
import {
  pluginToolName,
  type LoadedPluginRecord,
  type PluginConfigEntry,
  type PluginContext,
  type PluginDefinition,
  type PluginHooks,
  type PluginLoadReport,
  type PluginLogger,
  type PluginToolContext,
  type PluginToolRegistration,
} from "./types";

const DEFAULT_PLUGIN_TOOL_TIMEOUT_MS = 30_000;

/** Environment variable that lets tests/CLI point the runtime at a workspace. */
export const TOOLNET_PLUGIN_ROOT_ENV = "TOOLNET_PLUGIN_ROOT";

interface RegisteredPlugin {
  id: string;
  definition: PluginDefinition;
  owner: string;
  toolNames: string[];
  hookCount: number;
}

interface RegisteredTool {
  pluginId: string;
  owner: string;
  canonicalName: string;
  registration: PluginToolRegistration;
  risk: ToolRisk;
}

/** Mutable accumulator for the plugin currently being set up. */
interface LoadAccumulator {
  report: PluginLoadReport;
  spec: string;
  toolNames: string[];
  hookCount: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Structured, namespaced logger that never leaks plugin options/secrets. */
function createLogger(pluginId: string, sink?: PluginRuntimeOptions["onLog"]): PluginLogger {
  const emit = (level: "debug" | "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => {
    try {
      sink?.(level, pluginId, message, meta);
    } catch {
      // A broken log sink must not break a plugin.
    }
  };
  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
  };
}

/**
 * Normalize whatever a plugin returned into the standard tool-result envelope
 * the agent loop expects. A bare string becomes stdout; an object that already
 * looks like `{ stdout, stderr, exitCode }` is passed through.
 */
export function normalizePluginToolOutput(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify({ stdout: value, stderr: "", exitCode: 0 });
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const looksLikeEnvelope =
      typeof record.stdout === "string" ||
      typeof record.stderr === "string" ||
      typeof record.exitCode === "number";
    if (looksLikeEnvelope) {
      return JSON.stringify({
        stdout: typeof record.stdout === "string" ? record.stdout : "",
        stderr: typeof record.stderr === "string" ? record.stderr : "",
        exitCode: typeof record.exitCode === "number" ? record.exitCode : 0,
      });
    }
    return JSON.stringify({ stdout: JSON.stringify(value), stderr: "", exitCode: 0 });
  }
  return JSON.stringify({ stdout: String(value ?? ""), stderr: "", exitCode: 0 });
}

function raceWithTimeout<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export interface PluginRuntimeOptions {
  onLog?: (
    level: "debug" | "info" | "warn" | "error",
    pluginId: string,
    message: string,
    meta?: Record<string, unknown>,
  ) => void;
  /** Tool execution timeout. */
  toolTimeoutMs?: number;
}

export class PluginRuntime {
  private readonly plugins = new Map<string, RegisteredPlugin>();
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly options: PluginRuntimeOptions;
  private workspaceRoot: string;
  private lastReport: PluginLoadReport = { loaded: [], failures: [] };

  constructor(options: PluginRuntimeOptions = {}) {
    this.options = options;
    this.workspaceRoot = resolvePluginWorkspaceRoot();
  }

  /** Records from the most recent `loadAll`. */
  getReport(): PluginLoadReport {
    return this.lastReport;
  }

  /** Currently loaded plugins. */
  list(): LoadedPluginRecord[] {
    return this.lastReport.loaded;
  }

  loadedPluginIds(): string[] {
    return [...this.plugins.keys()];
  }

  /** Canonical tool names contributed by a plugin. */
  toolsOf(pluginId: string): string[] {
    return this.plugins.get(pluginId)?.toolNames ?? [];
  }

  /** True when a canonical name belongs to a loaded plugin tool. */
  isPluginTool(canonicalName: string): boolean {
    return this.tools.has(canonicalName);
  }

  /**
   * Load every enabled plugin from config.
   *
   * Idempotent: calling it again disposes the previous generation first, so a
   * restart never leaves two registrations of the same plugin behind.
   */
  async loadAll(workspaceRoot: string = resolvePluginWorkspaceRoot()): Promise<PluginLoadReport> {
    this.workspaceRoot = workspaceRoot;
    await this.dispose();

    const config = loadPluginConfig({ workspaceRoot });
    const report: PluginLoadReport = { loaded: [], failures: [] };

    for (const warning of config.warnings) {
      this.options.onLog?.("warn", "runtime", warning);
    }

    for (const entry of config.entries) {
      if (!entry.enabled) continue;
      await this.loadOne(entry, report);
    }

    this.lastReport = report;
    return report;
  }

  /** Load one already-normalized config entry. Failures are recorded, not thrown. */
  async loadOne(entry: PluginConfigEntry, report: PluginLoadReport): Promise<void> {
    const loaded = await loadPluginModule(entry, this.workspaceRoot);
    if (!("ok" in loaded)) {
      report.failures.push({ spec: loaded.spec, stage: loaded.stage, reason: loaded.reason });
      this.options.onLog?.("warn", "runtime", `skipped plugin ${loaded.spec} at ${loaded.stage}: ${loaded.reason}`);
      return;
    }

    const pluginId = loaded.definition.id || derivePluginId(entry.spec);
    const owner = `plugin:${pluginId}`;

    // Duplicate ids are rejected rather than merged: two plugins sharing an id
    // would make hook order and tool ownership ambiguous.
    if (this.plugins.has(pluginId)) {
      report.failures.push({
        spec: entry.spec,
        stage: "validate",
        reason: `duplicate plugin id '${pluginId}' is already loaded`,
      });
      return;
    }

    const accumulator: LoadAccumulator = {
      report,
      spec: entry.spec,
      toolNames: [],
      hookCount: 0,
    };

    const context = this.createContext(pluginId, entry, accumulator);

    try {
      const returned = await loaded.definition.setup(context);
      // Tools/hooks may be registered imperatively OR returned. Both land in
      // the same registration helpers, so there is only one code path.
      for (const tool of returned?.tools ?? []) {
        this.registerTool(pluginId, owner, tool, accumulator);
      }
      for (const hook of returned?.hooks ?? []) {
        this.registerHook(owner, pluginId, hook, accumulator);
      }
    } catch (error) {
      // A plugin whose setup throws contributes nothing; roll back anything it
      // managed to register before failing.
      this.rollbackOwner(owner);
      report.failures.push({
        spec: entry.spec,
        stage: "init",
        reason: `setup() threw: ${messageOf(error)}`,
      });
      return;
    }

    this.plugins.set(pluginId, {
      id: pluginId,
      definition: loaded.definition,
      owner,
      toolNames: [...accumulator.toolNames],
      hookCount: accumulator.hookCount,
    });

    report.loaded.push({
      id: pluginId,
      name: loaded.definition.name ?? pluginId,
      version: loaded.definition.version,
      spec: entry.spec,
      sourceKind: entry.sourceKind,
      resolvedPath: loaded.resolved.target,
      toolNames: [...accumulator.toolNames],
      hookCount: accumulator.hookCount,
      loadedAt: Date.now(),
    });

    this.options.onLog?.("info", pluginId, `loaded (${accumulator.toolNames.length} tools)`);
  }

  private createContext(
    pluginId: string,
    entry: PluginConfigEntry,
    accumulator: LoadAccumulator,
  ): PluginContext {
    const owner = `plugin:${pluginId}`;
    return {
      workspaceRoot: this.workspaceRoot,
      pluginId,
      logger: createLogger(pluginId, this.options.onLog),
      config: Object.freeze({ ...entry.options }),
      registerTool: (tool) => this.registerTool(pluginId, owner, tool, accumulator),
      registerHook: (name, handler, options) =>
        this.registerHook(
          owner,
          pluginId,
          { name, handler, failurePolicy: options?.failurePolicy, priority: options?.priority, timeoutMs: options?.timeoutMs },
          accumulator,
        ),
    };
  }

  /** Register one plugin tool into the canonical registry + security engine. */
  private registerTool(
    pluginId: string,
    owner: string,
    tool: PluginToolRegistration,
    accumulator: LoadAccumulator,
  ): void {
    if (!tool || typeof tool.name !== "string" || !tool.name.trim()) {
      accumulator.report.failures.push({
        spec: accumulator.spec,
        stage: "validate",
        reason: "plugin tool is missing a name",
      });
      return;
    }
    if (typeof tool.execute !== "function") {
      accumulator.report.failures.push({
        spec: accumulator.spec,
        stage: "validate",
        reason: `plugin tool '${tool.name}' has no execute function`,
      });
      return;
    }

    const canonicalName = pluginToolName(pluginId, tool.name);
    const risk: ToolRisk = tool.risk ?? "write";

    const definition: ToolDefinition = {
      name: canonicalName,
      description: tool.description || `${tool.name} (plugin: ${pluginId})`,
      parameters: tool.parameters ?? { type: "object", properties: {}, required: [] },
      risk,
      category: "Plugin",
      execute: (input) => this.executeRegisteredTool(canonicalName, input as Record<string, unknown>),
    };

    // Duplicate canonical ids are rejected by the registry, not overwritten.
    if (!toolRegistry.register(definition, owner)) {
      accumulator.report.failures.push({
        spec: accumulator.spec,
        stage: "validate",
        reason: `tool id '${canonicalName}' is already registered (reserved built-in or taken by another plugin)`,
      });
      return;
    }

    this.tools.set(canonicalName, { pluginId, owner, canonicalName, registration: tool, risk });
    securityEngine.registerPluginTool(canonicalName, risk);
    accumulator.toolNames.push(canonicalName);
  }

  private registerHook(
    owner: string,
    pluginId: string,
    hook: { name: HookName; handler: HookHandler; failurePolicy?: HookFailurePolicy; priority?: number; timeoutMs?: number },
    accumulator: LoadAccumulator,
  ): void {
    try {
      hookRegistry.register({
        name: hook.name,
        handler: hook.handler,
        owner,
        failurePolicy: hook.failurePolicy,
        priority: hook.priority,
        timeoutMs: hook.timeoutMs,
      });
      accumulator.hookCount++;
    } catch (error) {
      accumulator.report.failures.push({
        spec: accumulator.spec,
        stage: "validate",
        reason: `hook '${String(hook.name)}' rejected: ${messageOf(error)}`,
      });
      this.options.onLog?.("warn", pluginId, `hook '${String(hook.name)}' rejected: ${messageOf(error)}`);
    }
  }

  /**
   * Execute a plugin tool. Called by the registry entry — i.e. AFTER the
   * gateway already allowed the call — so this method must not re-gate. It only
   * enforces plugin-local concerns: liveness and crash isolation.
   */
  async executeRegisteredTool(canonicalName: string, input: Record<string, unknown>): Promise<string> {
    const entry = this.tools.get(canonicalName);
    if (!entry) {
      return JSON.stringify({ stdout: "", stderr: `Unknown plugin tool: ${canonicalName}`, exitCode: 1 });
    }

    if (!this.plugins.has(entry.pluginId)) {
      return JSON.stringify({ stdout: "", stderr: `Plugin '${entry.pluginId}' is not loaded`, exitCode: 1 });
    }

    const timeoutMs = this.options.toolTimeoutMs ?? DEFAULT_PLUGIN_TOOL_TIMEOUT_MS;
    const context: PluginToolContext = {
      workspaceRoot: this.workspaceRoot,
      cwd: this.workspaceRoot,
      pluginId: entry.pluginId,
    };

    try {
      const result = await raceWithTimeout(
        Promise.resolve(entry.registration.execute(input ?? {}, context)),
        timeoutMs,
        () => new Error(`plugin tool '${canonicalName}' timed out after ${timeoutMs}ms`),
      );
      return normalizePluginToolOutput(result);
    } catch (error) {
      // Crash isolation: the CLI keeps running and the model gets a real error.
      this.options.onLog?.("error", entry.pluginId, `tool '${canonicalName}' failed: ${messageOf(error)}`);
      return JSON.stringify({
        stdout: "",
        stderr: `Plugin Error in '${canonicalName}': ${messageOf(error)}`,
        exitCode: 1,
      });
    }
  }

  /** Remove everything an owner registered (tools + hooks). */
  private rollbackOwner(owner: string): void {
    toolRegistry.unregisterOwner(owner);
    hookRegistry.unregisterOwner(owner);
    for (const [name, entry] of this.tools.entries()) {
      if (entry.owner !== owner) continue;
      this.tools.delete(name);
      securityEngine.unregisterPluginTool(name);
    }
  }

  /**
   * Dispose every plugin: unregister tools/hooks first so a late tool call can
   * never hit a torn-down handler, then run each plugin's own `dispose`.
   * Safe to call repeatedly (idempotent shutdown).
   */
  async dispose(): Promise<void> {
    for (const id of [...this.plugins.keys()]) {
      const plugin = this.plugins.get(id);
      if (!plugin) continue;
      this.rollbackOwner(plugin.owner);
      this.plugins.delete(id);
      try {
        await plugin.definition.dispose?.();
      } catch (error) {
        this.options.onLog?.("warn", id, `dispose() threw: ${messageOf(error)}`);
      }
    }
    this.tools.clear();
    this.lastReport = { loaded: [], failures: [] };
  }
}

/** Resolve the workspace a runtime should load plugins for. */
export function resolvePluginWorkspaceRoot(explicit?: string): string {
  return explicit || process.env[TOOLNET_PLUGIN_ROOT_ENV] || path.resolve(process.cwd());
}

/**
 * Process-wide runtime — the single instance every front-end uses. Tests may
 * construct their own `PluginRuntime` for isolation.
 */
export const pluginRuntime = new PluginRuntime({
  onLog: (level, pluginId, message, meta) => {
    if (level !== "error" && level !== "warn") return;
    // Never log plugin options or args — only the namespaced message.
    console.error(`[plugin:${pluginId}] ${message}`, meta ?? "");
  },
});
