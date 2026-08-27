import { test, it, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { validatePluginManifest } from "../../lib/plugins/manifest";
import { PluginManager } from "../../lib/plugins/pluginManager";
import { setSandboxMode } from "../../lib/permissions";

function tmpDir(): string {
  const d = path.join(os.tmpdir(), "toolnet-plugin-test-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function cleanDir(d: string) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

describe("P4.11 - P4.13 & P4.24 — Plugin Architecture & Security", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    setSandboxMode("workspace");
  });

  afterEach(() => {
    cleanDir(dir);
  });

  it("22. plugin manifest validation accepts valid manifest", () => {
    const valid = {
      name: "toolnet-plugin-test",
      version: "1.0.0",
      description: "Test plugin",
      toolnet: {
        apiVersion: 1,
        entry: "index.js",
        capabilities: ["filesystem.read", "network"],
      },
    };

    const res = validatePluginManifest(valid);
    expect(res.valid).toBe(true);
    expect(res.manifest?.name).toBe("toolnet-plugin-test");
    expect(res.manifest?.toolnet.apiVersion).toBe(1);
    expect(res.manifest?.toolnet.capabilities).toContain("filesystem.read");
  });

  it("23. incompatible plugin API version is rejected with clear error", () => {
    const incompatible = {
      name: "ancient-plugin",
      version: "0.1.0",
      toolnet: {
        apiVersion: 999, // Future/incompatible version
        entry: "index.js",
      },
    };

    const res = validatePluginManifest(incompatible);
    expect(res.valid).toBe(false);
    expect(res.errorCode).toBe("PLUGIN_API_VERSION_INCOMPATIBLE");
    expect(res.error).toContain("PLUGIN_API_VERSION_INCOMPATIBLE");
  });

  it("24. plugin capability is denied by default if not granted", async () => {
    const manager = new PluginManager();

    // Create a mock plugin directory
    const pluginDir = path.join(dir, "my-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "test-plugin-cap",
        version: "1.0.0",
        toolnet: {
          apiVersion: 1,
          entry: "index.js",
          capabilities: ["filesystem.read"], // network not requested
        },
      })
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      `
      module.exports = {
        activate: (api) => {
          api.defineTool({
            name: "network_tool",
            description: "Fetches something",
            requiredCapabilities: ["network"],
            execute: async (args, ctx) => "fetched data",
          });
        }
      };
      `
    );

    const installRes = await manager.installPlugin(pluginDir, { grantCapabilities: ["filesystem.read"] });
    expect(installRes.ok).toBe(true);

    // Calling tool that requires 'network' capability should fail
    const execRes = await manager.executePluginTool("network_tool", {}, dir);
    expect(execRes.error).toContain("Permission Denied");
    expect(execRes.error).toContain("lacks required capability 'network'");
  });

  it("25. plugin cannot bypass sandbox permissions", async () => {
    setSandboxMode("workspace");
    const manager = new PluginManager();

    const pluginDir = path.join(dir, "bypass-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "bypass-plugin",
        version: "1.0.0",
        toolnet: { apiVersion: 1, entry: "index.js", capabilities: ["filesystem.read"] },
      })
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      `
      module.exports = {
        activate: (api) => {
          api.defineTool({
            name: "read_file",
            description: "Read a file",
            execute: async (args) => "read result",
          });
        }
      };
      `
    );

    await manager.installPlugin(pluginDir, { grantCapabilities: ["filesystem.read"] });

    // Attempting to read outside workspace through plugin tool
    const execRes = await manager.executePluginTool("read_file", { path: "/etc/passwd" }, dir);
    expect(execRes.error).toContain("Permission Denied");
  });

  it("26. plugin crash is isolated and does not crash CLI", async () => {
    const manager = new PluginManager();

    const pluginDir = path.join(dir, "crashing-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "crashing-plugin",
        version: "1.0.0",
        toolnet: { apiVersion: 1, entry: "index.js" },
      })
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      `
      module.exports = {
        activate: (api) => {
          api.defineTool({
            name: "explode",
            description: "Explodes",
            execute: () => { throw new Error("Catastrophic plugin failure"); },
          });
        }
      };
      `
    );

    await manager.installPlugin(pluginDir, { grantCapabilities: [] });

    // Execute crashing tool
    const res = await manager.executePluginTool("explode", {}, dir);
    expect(res.error).toContain("Plugin Error");
    expect(res.error).toContain("Catastrophic plugin failure");

    // The manager continues to function
    const pluginInfo = manager.getPlugin("crashing-plugin");
    expect(pluginInfo?.lastError).toContain("Catastrophic plugin failure");
  });
});
