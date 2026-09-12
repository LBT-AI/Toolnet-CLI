import fs from "node:fs";
import path from "node:path";
import { getToolnetPluginsDir } from "../toolnetHome";
import type {
  PluginManifest,
  PluginCapability,
  PluginToolDefinition,
  PluginCommandDefinition,
  InstalledPluginInfo,
  PluginApi,
} from "./types";
import { validatePluginManifest, loadPluginManifestFromDir } from "./manifest";
import { getSandboxMode } from "../permissions";
import { securityEngine } from "../security/securityEngine";
import { auditLogger } from "../security/auditLogger";
import { hookRegistry } from "../../core/hooks";

function getPluginsDir(): string {
  // Phase 3: canonical global plugins dir (~/.toolnetcli/plugins).
  // DATA_DIR override still respected for tests/sandboxed installs.
  return process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, "plugins")
    : getToolnetPluginsDir();
}

function getRegistryFile(): string {
  return path.join(getPluginsDir(), "registry.json");
}

export class PluginManager {
  private plugins: Map<string, InstalledPluginInfo> = new Map();
  private tools: Map<string, { pluginName: string; tool: PluginToolDefinition }> = new Map();
  private commands: Map<string, { pluginName: string; cmd: PluginCommandDefinition }> = new Map();

  constructor() {
    this.loadRegistry();
  }

  private loadRegistry(): void {
    try {
      const regPath = getRegistryFile();
      if (fs.existsSync(regPath)) {
        const raw = JSON.parse(fs.readFileSync(regPath, "utf8"));
        if (Array.isArray(raw)) {
          for (const item of raw) {
            this.plugins.set(item.name, item);
          }
        }
      }
    } catch {}
  }

  private saveRegistry(): void {
    try {
      const dir = getPluginsDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const arr = Array.from(this.plugins.values());
      fs.writeFileSync(getRegistryFile(), JSON.stringify(arr, null, 2));
    } catch {}
  }

  listPlugins(): InstalledPluginInfo[] {
    return Array.from(this.plugins.values());
  }

  getPlugin(name: string): InstalledPluginInfo | undefined {
    return this.plugins.get(name);
  }

  async installPlugin(
    targetPathOrDir: string,
    options: { grantCapabilities?: PluginCapability[]; enabled?: boolean } = {}
  ): Promise<{ ok: boolean; info?: InstalledPluginInfo; error?: string }> {
    const pluginDir = path.resolve(targetPathOrDir);
    const val = loadPluginManifestFromDir(pluginDir);

    if (!val.valid || !val.manifest) {
      return { ok: false, error: val.error || "Invalid plugin manifest" };
    }

    const manifest = val.manifest;
    const requestedCaps = manifest.toolnet.capabilities || [];
    const granted = options.grantCapabilities || requestedCaps;

    const info: InstalledPluginInfo = {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      installPath: pluginDir,
      manifest,
      grantedCapabilities: granted,
      enabled: options.enabled ?? true,
      installedAt: Date.now(),
    };

    this.plugins.set(manifest.name, info);
    this.saveRegistry();

    // Try loading the plugin
    await this.loadPluginInstance(info);

    return { ok: true, info };
  }

  removePlugin(name: string): boolean {
    if (!this.plugins.has(name)) return false;
    this.plugins.delete(name);
    // Phase 77: legacy plugins register into the canonical hook registry, so
    // removal must drop their hooks too — otherwise a removed plugin keeps
    // observing the agent lifecycle.
    hookRegistry.unregisterOwner(this.hookOwner(name));
    this.saveRegistry();

    // Clean up tools from this plugin
    for (const [toolName, entry] of this.tools.entries()) {
      if (entry.pluginName === name) {
        this.tools.delete(toolName);
      }
    }
    return true;
  }

  /** Owner id used for this legacy plugin's canonical hook registrations. */
  private hookOwner(pluginName: string): string {
    return `plugin:${pluginName}`;
  }

  async loadAllPlugins(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.enabled) {
        await this.loadPluginInstance(plugin);
      }
    }
  }

  async loadPluginInstance(info: InstalledPluginInfo): Promise<boolean> {
    const entryFile = path.resolve(info.installPath, info.manifest.toolnet.entry);
    if (!fs.existsSync(entryFile)) {
      info.lastError = `Entry file not found: ${entryFile}`;
      info.enabled = false;
      this.saveRegistry();
      return false;
    }

    try {
      let mod: any;
      try {
        mod = require(entryFile);
      } catch {
        mod = await import(entryFile);
      }

      const registerFn =
        typeof mod === "function"
          ? mod
          : mod?.activate ||
            mod?.register ||
            mod?.default?.activate ||
            mod?.default?.register ||
            (typeof mod?.default === "function" ? mod.default : null);

      if (typeof registerFn !== "function") {
        info.lastError = `Plugin entry has no default, register, or activate function`;
        info.enabled = false;
        this.saveRegistry();
        return false;
      }

      const hasCapability = (cap: PluginCapability) => info.grantedCapabilities.includes(cap);

      const owner = this.hookOwner(info.name);

      // Phase 77.6/77.7: the legacy callback API is an ADAPTER onto the
      // canonical hook registry — there is one hook execution engine, so legacy
      // plugins and Phase 77 plugins share ordering and failure semantics.
      const api: PluginApi = {
        defineTool: (toolDef: PluginToolDefinition) => {
          this.tools.set(toolDef.name, { pluginName: info.name, tool: toolDef });
          securityEngine.registerPluginTool(toolDef.name);
        },
        defineCommand: (cmdDef: PluginCommandDefinition) => {
          this.commands.set(cmdDef.name, { pluginName: info.name, cmd: cmdDef });
        },
        onAgentStart: (handler) =>
          hookRegistry.register({
            name: "agent.start",
            owner,
            // A legacy observer must never take the agent down.
            failurePolicy: "warn",
            handler: (invocation) => {
              handler(invocation.input);
            },
          }),
        onAgentEnd: (handler) =>
          hookRegistry.register({
            name: "agent.end",
            owner,
            failurePolicy: "warn",
            handler: (invocation) => {
              handler(invocation.input);
            },
          }),
        onToolCall: (handler) =>
          hookRegistry.register({
            name: "tool.before",
            owner,
            failurePolicy: "warn",
            handler: (invocation) => {
              handler(invocation.input);
            },
          }),
      };

      await registerFn(api, { cwd: process.cwd(), hasCapability });
      info.lastError = undefined;
      return true;
    } catch (err: any) {
      info.lastError = `Crash during load: ${err.message}`;
      info.enabled = false;
      this.saveRegistry();
      return false;
    }
  }

  getRegisteredTools(): Array<{ type: "function"; function: { name: string; description: string; parameters?: any } }> {
    const res: Array<{ type: "function"; function: { name: string; description: string; parameters?: any } }> = [];
    for (const [name, { pluginName, tool }] of this.tools.entries()) {
      const plugin = this.plugins.get(pluginName);
      if (plugin && plugin.enabled) {
        res.push({
          type: "function",
          function: {
            name,
            description: `[Plugin: ${pluginName}] ${tool.description}`,
            parameters: tool.parameters || { type: "object", properties: {} },
          },
        });
      }
    }
    return res;
  }

  /**
   * Layer 4 Phase 1: plugin tool execution goes through the ToolGateway
   * (single SecurityEngine chokepoint). The plugin capability-grant model is
   * still enforced first; the gateway then evaluates the canonical policy
   * decision (ALLOW/ASK/DENY) and fail-closes headless ASK requests.
   * Callers that obtained explicit user approval may pass userApproved=true —
   * it is forwarded to the gateway and can NEVER override CRITICAL_DENY.
   */
  async executePluginTool(
    toolName: string,
    args: any,
    cwd = process.cwd(),
    options: { userApproved?: boolean } = {}
  ): Promise<{ result?: any; error?: string }> {
    const entry = this.tools.get(toolName);
    if (!entry) {
      return { error: `Plugin tool '${toolName}' not found` };
    }

    const { pluginName, tool } = entry;
    const plugin = this.plugins.get(pluginName);

    if (!plugin || !plugin.enabled) {
      return { error: `Plugin '${pluginName}' is disabled or not available` };
    }

    // Plugin capability check (plugin's own grant model)
    if (tool.requiredCapabilities) {
      for (const cap of tool.requiredCapabilities) {
        if (!plugin.grantedCapabilities.includes(cap)) {
          return { error: `Permission Denied: Plugin '${pluginName}' lacks required capability '${cap}' for tool '${toolName}'` };
        }
      }
    }

    const sandboxMode = getSandboxMode();

    // ── Single SecurityEngine chokepoint via ToolGateway ───────────────────
    const { ToolGateway } = await import("../security/toolGateway");
    const gatewayRes = await ToolGateway.execute(
      { name: toolName, args },
      {
        cwd,
        sandboxMode,
        userApproved: options.userApproved,
        source: "plugin",
      }
    );

    if (!gatewayRes.allowed) {
      const reason = gatewayRes.reason || "Sandbox policy violation";
      auditLogger.logEvent({
        action: `plugin_tool:${toolName}`,
        allowed: false,
        mode: sandboxMode,
        cwd,
        args,
        reason,
      });
      return { error: `Permission Denied: ${reason}` };
    }

    // Isolation & Timeout wrapper
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutMs = 30000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(
          () => reject(new Error(`Plugin tool '${toolName}' timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      });

      const context = {
        cwd,
        hasCapability: (cap: PluginCapability) => plugin.grantedCapabilities.includes(cap),
      };

      // A *synchronous* throw from `execute` used to skip `Promise.race`
      // entirely, orphaning `timeoutPromise`; its rejection then fired 30s later
      // as an unhandled error attributed to an unrelated task. Deferring the call
      // keeps the throw inside the race, and `finally` clears the timer once the
      // call settles either way.
      const execPromise = Promise.resolve().then(() => tool.execute(args, context));
      const res = await Promise.race([execPromise, timeoutPromise]);

      auditLogger.logEvent({
        action: `plugin_tool:${toolName}`,
        allowed: true,
        mode: sandboxMode,
        cwd,
        args,
      });

      return { result: res };
    } catch (err: any) {
      // Plugin crash isolation: record error, disable plugin if severe, return error without crashing CLI
      plugin.lastError = `Execution error in ${toolName}: ${err.message}`;
      auditLogger.logEvent({
        action: `plugin_tool:${toolName}`,
        allowed: false,
        mode: sandboxMode,
        cwd,
        args,
        reason: `Plugin execution crashed: ${err.message}`,
      });
      return { error: `Plugin Error in '${pluginName}/${toolName}': ${err.message}` };
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    }
  }

}

export const pluginManager = new PluginManager();
