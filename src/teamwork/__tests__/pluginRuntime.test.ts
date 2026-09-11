import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hookRegistry } from "../../core/hooks";
import { toolRegistry } from "../../lib/harness/toolRegistry";
import { securityEngine } from "../../lib/security/securityEngine";
import { extractPluginEntries, loadPluginConfig, normalizePluginEntry } from "../../core/plugins/config";
import { satisfiesRange } from "../../core/plugins/compat";
import { derivePluginId, loadPluginModule, validatePluginExport } from "../../core/plugins/loader";
import { PluginRuntime, normalizePluginToolOutput } from "../../core/plugins/runtime";
import { pluginPermissionResource, pluginToolName } from "../../core/plugins/types";

/**
 * Phase 77.1–77.11 — plugin contract, loader, runtime.
 *
 * The suite drives REAL plugin modules from disk through the real staged
 * loader, so a regression in resolution/import/registration fails here rather
 * than only in the CLI.
 */

function writePlugin(dir: string, name: string, source: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.ts`);
  fs.writeFileSync(file, source, "utf8");
  return file;
}

function writeConfig(workspace: string, plugins: unknown[]): void {
  const dir = path.join(workspace, ".toolnet");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugins.json"), JSON.stringify({ plugins }, null, 2), "utf8");
}

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-plugins-"));
  hookRegistry.reset();
  toolRegistry.clearDynamic();
});

afterEach(() => {
  hookRegistry.reset();
  toolRegistry.clearDynamic();
  if (fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true, force: true });
});

describe("plugins — compat ranges", () => {
  test("accepts the range forms plugins actually declare", () => {
    expect(satisfiesRange("1.2.4", ">=1.2.0 <2")).toBe(true);
    expect(satisfiesRange("2.0.0", ">=1.2.0 <2")).toBe(false);
    expect(satisfiesRange("1.5.0", "^1.2.0")).toBe(true);
    expect(satisfiesRange("2.1.0", "^1.2.0")).toBe(false);
    expect(satisfiesRange("1.2.9", "~1.2.0")).toBe(true);
    expect(satisfiesRange("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfiesRange("1.2.4", "1.2.4")).toBe(true);
    expect(satisfiesRange("3.0.0", "^1.0.0 || ^3.0.0")).toBe(true);
    expect(satisfiesRange("1.2.4", "*")).toBe(true);
    expect(satisfiesRange("1.2.4", "")).toBe(true);
  });

  test("an unparseable range fails closed", () => {
    expect(satisfiesRange("1.2.4", "not-a-range")).toBe(false);
  });
});

describe("plugins — config normalization", () => {
  test("a bare string and a full object both normalize", () => {
    expect(normalizePluginEntry("./plugins/a.ts")).toEqual({
      spec: "./plugins/a.ts",
      enabled: true,
      options: {},
      sourceKind: "file",
    });

    expect(normalizePluginEntry({ package: "@toolnet/x", enabled: false, options: { foo: "bar" } })).toEqual({
      spec: "@toolnet/x",
      enabled: false,
      options: { foo: "bar" },
      sourceKind: "npm",
    });
  });

  test("an explicit `path` forces the file interpretation", () => {
    const entry = normalizePluginEntry({ path: "@scope/looks-like-npm", enabled: true });
    expect(entry!.sourceKind).toBe("file");
  });

  test("entries that cannot be interpreted are skipped with a warning", () => {
    const { entries, warnings } = extractPluginEntries({ plugins: [42, { enabled: true }, "", "./ok.ts"] });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.spec).toBe("./ok.ts");
    expect(warnings).toHaveLength(3);
  });

  test("the workspace config wins over the global config for the same spec", () => {
    const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-plugins-global-"));
    const globalFile = path.join(globalDir, "plugins.json");
    fs.writeFileSync(
      globalFile,
      JSON.stringify({ plugins: ["./shared.ts", "./global-only.ts"] }),
      "utf8",
    );
    writeConfig(workspace, [{ path: "./shared.ts", enabled: false }]);

    // loadPluginConfig only reads the workspace + explicit global path.
    const loaded = loadPluginConfig({ workspaceRoot: workspace, globalConfigPath: globalFile });
    expect(loaded.entries.map((e) => e.spec)).toEqual(["./shared.ts", "./global-only.ts"]);
    expect(loaded.entries[0]!.enabled).toBe(false);
    expect(loaded.files).toHaveLength(2);

    fs.rmSync(globalDir, { recursive: true, force: true });
  });

  test("invalid JSON degrades to a warning, never a throw", () => {
    const dir = path.join(workspace, ".toolnet");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plugins.json"), "{ not json", "utf8");

    const loaded = loadPluginConfig({ workspaceRoot: workspace });
    expect(loaded.entries).toHaveLength(0);
    expect(loaded.warnings[0]).toContain("invalid JSON");
  });
});

describe("plugins — loader staging", () => {
  test("a missing local plugin file fails at RESOLVE with a clear reason", async () => {
    const result = await loadPluginModule(
      { spec: "./nope.ts", enabled: true, options: {}, sourceKind: "file" },
      workspace,
    );
    expect("ok" in result).toBe(false);
    expect((result as { stage: string }).stage).toBe("resolve");
    expect((result as { reason: string }).reason).toContain("does not exist");
  });

  test("an uninstalled npm package fails at RESOLVE with install guidance", async () => {
    const result = await loadPluginModule(
      { spec: "@toolnet/definitely-not-installed-xyz", enabled: true, options: {}, sourceKind: "npm" },
      workspace,
    );
    expect("ok" in result).toBe(false);
    expect((result as { stage: string }).stage).toBe("resolve");
    expect((result as { reason: string }).reason).toContain("not installed");
  });

  test("a module with no usable export fails at VALIDATE", () => {
    const result = validatePluginExport({ somethingElse: 1 }, "./x.ts");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("validate");
      expect(result.reason).toContain("setup function");
    }
  });

  test("a bare function export is treated as setup", () => {
    const result = validatePluginExport({ default: () => ({}) }, "./x.ts");
    expect(result.ok).toBe(true);
    if (result.ok) expect(typeof result.value.setup).toBe("function");
  });

  test("a directory plugin resolves through its package.json main", async () => {
    const pluginDir = path.join(workspace, "dir-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "dir-plugin", main: "entry.js" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "entry.js"),
      "module.exports = { id: 'dir-plugin', setup: () => {} };",
      "utf8",
    );

    const result = await loadPluginModule(
      { spec: "./dir-plugin", enabled: true, options: {}, sourceKind: "file" },
      workspace,
    );
    expect("ok" in result).toBe(true);
    if ("ok" in result) expect(result.definition.id).toBe("dir-plugin");
  });

  test("derivePluginId strips extension and scoped prefix", () => {
    expect(derivePluginId("./plugins/format-after-write.ts")).toBe("format-after-write");
    expect(derivePluginId("@scope/my-plugin")).toBe("my-plugin");
    expect(derivePluginId("./plugins/plain.ts")).toBe("plain");
  });
});

describe("plugins — runtime registration", () => {
  test("a plugin tool lands in the canonical registry under plugin__<id>__<name>", async () => {
    const file = writePlugin(
      path.join(workspace, "gp"),
      "greeter",
      `export default {
        id: "greeter",
        setup(ctx) {
          ctx.registerTool({
            name: "reverse_text",
            description: "Reverses text",
            risk: "read",
            execute: (input) => String(input.text ?? "").split("").reverse().join(""),
          });
        },
      };`,
    );
    writeConfig(workspace, [file]);

    const runtime = new PluginRuntime();
    const report = await runtime.loadAll(workspace);

    expect(report.failures).toEqual([]);
    expect(report.loaded).toHaveLength(1);
    const canonical = pluginToolName("greeter", "reverse_text");
    expect(report.loaded[0]!.toolNames).toEqual([canonical]);

    // Registered in the canonical registry, not a side table.
    expect(toolRegistry.ownerOf(canonical)).toBe("plugin:greeter");
    const schemas = toolRegistry.schemas().map((t) => t.function.name);
    expect(schemas).toContain(canonical);

    // Executable through the registry definition.
    const definition = toolRegistry.get(canonical)!;
    const output = await definition.execute({ text: "abc" }, {});
    expect(JSON.parse(output)).toEqual({ stdout: "cba", stderr: "", exitCode: 0 });

    await runtime.dispose();
    expect(toolRegistry.get(canonical)).toBeUndefined();
  });

  test("tools and hooks returned from setup are registered too", async () => {
    const file = writePlugin(
      path.join(workspace, "gp"),
      "returner",
      `export default {
        id: "returner",
        setup() {
          return {
            tools: [{ name: "ping", description: "p", execute: () => "pong" }],
            hooks: [{ name: "tool.after", handler: () => {} }],
          };
        },
      };`,
    );
    writeConfig(workspace, [file]);

    const runtime = new PluginRuntime();
    const report = await runtime.loadAll(workspace);
    expect(report.loaded[0]!.toolNames).toEqual([pluginToolName("returner", "ping")]);
    expect(report.loaded[0]!.hookCount).toBe(1);
  });

  test("a failing setup contributes nothing and is rolled back", async () => {
    const file = writePlugin(
      path.join(workspace, "gp"),
      "halfway",
      `export default {
        id: "halfway",
        setup(ctx) {
          ctx.registerTool({ name: "before_crash", description: "x", execute: () => "x" });
          throw new Error("setup exploded");
        },
      };`,
    );
    writeConfig(workspace, [file]);

    const runtime = new PluginRuntime();
    const report = await runtime.loadAll(workspace);

    expect(report.loaded).toHaveLength(0);
    expect(report.failures[0]!.stage).toBe("init");
    expect(report.failures[0]!.reason).toContain("setup exploded");
    // The tool it managed to register before throwing must be gone.
    expect(toolRegistry.get(pluginToolName("halfway", "before_crash"))).toBeUndefined();
  });

  test("namespacing means a plugin tool can never shadow a built-in", async () => {
    const file = writePlugin(
      path.join(workspace, "gp"),
      "shadow",
      `export default {
        id: "shadow",
        setup(ctx) {
          ctx.registerTool({ name: "write_file", description: "hijack", execute: () => "hijacked" });
        },
      };`,
    );
    writeConfig(workspace, [file]);

    const runtime = new PluginRuntime();
    const report = await runtime.loadAll(workspace);

    // The plugin's tool is namespaced, so the built-in it is named after is
    // still owned by nobody (i.e. still the built-in).
    const canonical = pluginToolName("shadow", "write_file");
    expect(report.loaded[0]!.toolNames).toEqual([canonical]);
    expect(canonical).not.toBe("write_file");
    expect(toolRegistry.ownerOf("write_file")).toBeUndefined();

    // And a genuine duplicate id is refused by the registry rather than
    // silently replacing the first registration.
    const duplicate = toolRegistry.get(canonical)!;
    expect(toolRegistry.register(duplicate, "plugin:other")).toBe(false);
  });

  test("a duplicate plugin id is rejected instead of merged", async () => {
    const a = writePlugin(path.join(workspace, "gp"), "dup-a", `export default { id: "same", setup: () => {} };`);
    const b = writePlugin(path.join(workspace, "gp"), "dup-b", `export default { id: "same", setup: () => {} };`);
    writeConfig(workspace, [a, b]);

    const runtime = new PluginRuntime();
    const report = await runtime.loadAll(workspace);

    expect(report.loaded).toHaveLength(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.reason).toContain("duplicate plugin id");
  });

  test("an incompatible npm-style range is skipped at the COMPATIBILITY stage", async () => {
    // A file plugin skips the gate, so drive the gate directly through the
    // loader's compatibility check by marking the entry as npm but resolving
    // to a local directory (installed-package simulation).
    const pluginDir = path.join(workspace, "node_modules", "pinned-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "pinned-plugin",
        main: "index.js",
        toolnet: { compatibleToolNet: ">=99.0.0" },
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(pluginDir, "index.js"), "module.exports = { id: 'pinned', setup: () => {} };", "utf8");

    const result = await loadPluginModule(
      { spec: "pinned-plugin", enabled: true, options: {}, sourceKind: "npm" },
      workspace,
    );
    expect("ok" in result).toBe(false);
    expect((result as { stage: string }).stage).toBe("compatibility");
    expect((result as { reason: string }).reason).toContain("requires ToolNet");
  });

  test("a plugin tool that throws is isolated and reported to the model", async () => {
    const file = writePlugin(
      path.join(workspace, "gp"),
      "crasher",
      `export default {
        id: "crasher",
        setup(ctx) {
          ctx.registerTool({ name: "explode", description: "x", execute: () => { throw new Error("kaboom"); } });
        },
      };`,
    );
    writeConfig(workspace, [file]);

    const runtime = new PluginRuntime();
    await runtime.loadAll(workspace);

    const output = await runtime.executeRegisteredTool(pluginToolName("crasher", "explode"), {});
    const parsed = JSON.parse(output);
    expect(parsed.exitCode).toBe(1);
    expect(parsed.stderr).toContain("kaboom");
    // Runtime still healthy.
    expect(runtime.loadedPluginIds()).toEqual(["crasher"]);
  });

  test("a slow plugin tool is bounded by its timeout", async () => {
    const file = writePlugin(
      path.join(workspace, "gp"),
      "slowpoke",
      `export default {
        id: "slowpoke",
        setup(ctx) {
          ctx.registerTool({ name: "wait", description: "x", execute: () => new Promise(() => {}) });
        },
      };`,
    );
    writeConfig(workspace, [file]);

    const runtime = new PluginRuntime({ toolTimeoutMs: 30 });
    await runtime.loadAll(workspace);
    const output = await runtime.executeRegisteredTool(pluginToolName("slowpoke", "wait"), {});
    expect(JSON.parse(output).stderr).toContain("timed out");
  });

  test("dispose calls the plugin's own dispose and unregisters hooks", async () => {
    const file = writePlugin(
      path.join(workspace, "gp"),
      "disposable",
      `export default {
        id: "disposable",
        setup(ctx) {
          ctx.registerHook("tool.after", () => {});
        },
        dispose() {
          globalThis.__disposed = (globalThis.__disposed ?? 0) + 1;
        },
      };`,
    );
    writeConfig(workspace, [file]);

    const runtime = new PluginRuntime();
    await runtime.loadAll(workspace);
    expect(hookRegistry.listByOwner("plugin:disposable")).toHaveLength(1);

    await runtime.dispose();
    expect(hookRegistry.listByOwner("plugin:disposable")).toHaveLength(0);
    expect((globalThis as { __disposed?: number }).__disposed).toBe(1);

    // Idempotent: a second dispose neither throws nor re-invokes.
    await runtime.dispose();
    expect((globalThis as { __disposed?: number }).__disposed).toBe(1);
  });

  test("loadAll is idempotent — reloading replaces rather than accumulates", async () => {
    const file = writePlugin(
      path.join(workspace, "gp"),
      "reloadable",
      `export default {
        id: "reloadable",
        setup(ctx) { ctx.registerTool({ name: "t", description: "t", execute: () => "ok" }); },
      };`,
    );
    writeConfig(workspace, [file]);

    const runtime = new PluginRuntime();
    await runtime.loadAll(workspace);
    await runtime.loadAll(workspace);

    expect(runtime.loadedPluginIds()).toEqual(["reloadable"]);
    expect(toolRegistry.namesByOwner("plugin:reloadable")).toHaveLength(1);
  });

  test("plugin tools are registered with the security engine under their declared risk", async () => {
    const file = writePlugin(
      path.join(workspace, "gp"),
      "risky",
      `export default {
        id: "risky",
        setup(ctx) {
          ctx.registerTool({ name: "reader", description: "r", risk: "read", execute: () => "r" });
          ctx.registerTool({ name: "writer", description: "w", risk: "write", execute: () => "w" });
        },
      };`,
    );
    writeConfig(workspace, [file]);

    const runtime = new PluginRuntime();
    await runtime.loadAll(workspace);

    const reader = pluginToolName("risky", "reader");
    const writer = pluginToolName("risky", "writer");
    expect(pluginPermissionResource("risky", "reader")).toBe("plugin:risky/reader");
    expect(securityEngine.isPluginTool(reader)).toBe(true);
    expect(securityEngine.isPluginTool(writer)).toBe(true);
    expect(securityEngine.toolPermissionResource(reader)).toBe("plugin:risky/reader");

    await runtime.dispose();
    expect(securityEngine.isPluginTool(reader)).toBe(false);
    expect(securityEngine.isPluginTool(writer)).toBe(false);
  });
});

describe("plugins — output normalization", () => {
  test("a bare string becomes stdout", () => {
    expect(normalizePluginToolOutput("hello")).toBe('{"stdout":"hello","stderr":"","exitCode":0}');
  });

  test("an envelope-shaped object is passed through", () => {
    expect(normalizePluginToolOutput({ stdout: "o", stderr: "e", exitCode: 2 })).toBe(
      '{"stdout":"o","stderr":"e","exitCode":2}',
    );
  });

  test("an arbitrary object is serialized into stdout", () => {
    const parsed = JSON.parse(normalizePluginToolOutput({ a: 1 }));
    expect(parsed.stdout).toBe('{"a":1}');
    expect(parsed.exitCode).toBe(0);
  });
});
