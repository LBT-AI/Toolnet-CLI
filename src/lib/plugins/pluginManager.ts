import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  PluginManifest,
  PluginCapability,
  PluginToolDefinition,
  PluginCommandDefinition,
  InstalledPluginInfo,
  PluginApi,
} from "./types";
import { validatePluginManifest, loadPluginManifestFromDir } from "./manifest";
import { evaluatePermission, getSandboxMode } from "../permissions";
import { securityEngine } from "../security/securityEngine";
import { auditLogger } from "../security/auditLogger";

function getPluginsDir(): string {
  const base = process.env.DATA_DIR || path.join(os.homedir(), ".toolnet");
  return path.join(base, "plugins");
}

function getRegistryFile(): string {
  return path.join(getPluginsDir(), "registry.json");
}

export class PluginManager {
  private plugins: Map<string, InstalledPluginInfo> = new Map();
  private tools: Map<string, { pluginName: string; tool: PluginToolDefinition }> = new Map();
  private commands: Map<string, { pluginName: string; cmd: PluginCommandDefinition }> = new Map();
  private hooks: {
    onAgentStart: Array<(ctx: any) => void>;
    onAgentEnd: Array<(ctx: any) => void>;
    onToolCall: Array<(call: any) => void>;
  } = { onAgentStart: [], onAgentEnd: [], onToolCall: [] };

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
    this.saveRegistry();

    // Clean up tools from this plugin
    for (const [toolName, entry] of this.tools.entries()) {
      if (entry.pluginName === name) {
        this.tools.delete(toolName);
      }
    }
    return true;
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

      const api: PluginApi = {
        defineTool: (toolDef: PluginToolDefinition) => {
          this.tools.set(toolDef.name, { pluginName: info.name, tool: toolDef });
          securityEngine.registerPluginTool(toolDef.name);
        },
        defineCommand: (cmdDef: PluginCommandDefinition) => {
          this.commands.set(cmdDef.name, { pluginName: info.name, cmd: cmdDef });
        },
        onAgentStart: (handler) => this.hooks.onAgentStart.push(handler),
        onAgentEnd: (handler) => this.hooks.onAgentEnd.push(handler),
        onToolCall: (handler) => this.hooks.onToolCall.push(handler),
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

  async executePluginTool(toolName: string, args: any, cwd = process.cwd()): Promise<{ result?: any; error?: string }> {
    const entry = this.tools.get(toolName);
    if (!entry) {
      return { error: `Plugin tool '${toolName}' not found` };
    }

    const { pluginName, tool } = entry;
    const plugin = this.plugins.get(pluginName);

    if (!plugin || !plugin.enabled) {
      return { error: `Plugin '${pluginName}' is disabled or not available` };
    }

    // Capability check
    if (tool.requiredCapabilities) {
      for (const cap of tool.requiredCapabilities) {
        if (!plugin.grantedCapabilities.includes(cap)) {
          return { error: `Permission Denied: Plugin '${pluginName}' lacks required capability '${cap}' for tool '${toolName}'` };
        }
      }
    }

    // Permission engine & sandbox gate
    const sandboxMode = getSandboxMode();
    const perm = evaluatePermission(toolName, args, sandboxMode, cwd);
    if (!perm.allowed) {
      auditLogger.logEvent({
        action: `plugin_tool:${toolName}`,
        allowed: false,
        mode: sandboxMode,
        cwd,
        args,
        reason: perm.reason || "Blocked by sandbox policy",
      });
      return { error: `Permission Denied: ${perm.reason || "Sandbox policy violation"}` };
    }

    // Isolation & Timeout wrapper
    try {
      const timeoutMs = 30000;
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Plugin tool '${toolName}' timed out after ${timeoutMs}ms`)), timeoutMs)
      );

      const context = {
        cwd,
        hasCapability: (cap: PluginCapability) => plugin.grantedCapabilities.includes(cap),
      };

      const execPromise = Promise.resolve(tool.execute(args, context));
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
    }
  }

  // Hook runners
  triggerAgentStart(context: any): void {
    for (const fn of this.hooks.onAgentStart) {
      try { fn(context); } catch {}
    }
  }

  triggerAgentEnd(context: any): void {
    for (const fn of this.hooks.onAgentEnd) {
      try { fn(context); } catch {}
    }
  }

  triggerToolCall(call: any): void {
    for (const fn of this.hooks.onToolCall) {
      try { fn(call); } catch {}
    }
  }
}

export const pluginManager = new PluginManager();
