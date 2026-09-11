import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeMcpClients,
  getLocalMcpServers,
  mcpTrustManager,
} from "../../lib/mcpRunner";
import { executeTool } from "../../lib/agentTools";
import { setSandboxMode } from "../../lib/permissions";
import { toolRegistry } from "../../lib/harness/toolRegistry";
import { hookRegistry } from "../../core/hooks";
import { securityEngine } from "../../lib/security/securityEngine";
import { McpManager } from "../../core/mcp/manager";
import { PluginRuntime } from "../../core/plugins/runtime";
import { canonicalMcpToolName } from "../../core/mcp/adapter";
import { pluginToolName } from "../../core/plugins/types";
import { deriveSubagentPermission } from "../../core/agent/agents/permissions";
import { BackgroundJobService } from "../../core/background/service";

/**
 * Phase 77.27–77.33 — live acceptance.
 *
 * The MCP path here spawns a REAL server process and performs a REAL
 * initialize/tools-list/call sequence. Nothing about the manager or the
 * transport is mocked, so a registration or dispatch regression cannot hide.
 */

const FIXTURE_SERVER = path.resolve(__dirname, "helpers/fakePhase77McpServer.ts");

let workspace: string;
let configDir: string;

function writeWorkspaceFile(relative: string, content: string): string {
  const target = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

/** Trust + connect the single configured fixture server and return its id. */
async function connectFixture(manager: McpManager): Promise<string> {
  const server = getLocalMcpServers(workspace)[0]!;
  mcpTrustManager.enableServer(server.serverId, server.config, server.sourceFile);
  const report = await manager.sync(workspace);
  expect(report.failed).toEqual([]);
  expect(report.connected.map((s) => s.serverId)).toContain(server.serverId);
  return server.serverId;
}

beforeEach(() => {
  setSandboxMode("workspace");
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-phase77-"));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-phase77-home-"));
  process.env.TOOLNETCLI_CONFIG_DIR = configDir;
  toolRegistry.clearDynamic();
  hookRegistry.reset();
});

afterEach(async () => {
  await closeMcpClients();
  toolRegistry.clearDynamic();
  hookRegistry.reset();
  delete process.env.TOOLNETCLI_CONFIG_DIR;
  for (const dir of [workspace, configDir]) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("MCP live E2E — real stdio server process", () => {
  /**
   * ONE live server serves every live assertion, because each spawn is a cold
   * Bun process and the suite must stay cheap enough not to disturb the
   * wall-clock tests that run alongside it.
   */
  test("connect → discover → register → call → deny → reuse → withdraw", async () => {
    const callLog = path.join(workspace, "mcp-calls.log");
    writeWorkspaceFile("mcp.json", JSON.stringify({
      mcpServers: {
        fixture: {
          command: "bun",
          args: ["run", FIXTURE_SERVER],
          env: { MCP_FIXTURE_ROOT: workspace, MCP_CALL_LOG: callLog },
        },
      },
    }));

    const manager = new McpManager();
    const serverId = await connectFixture(manager);

    // 77.15 — canonical, collision-safe names in the ONE registry.
    const canonical = canonicalMcpToolName(serverId, "read_fixture");
    expect(toolRegistry.has(canonical)).toBe(true);
    expect(toolRegistry.ownerOf(canonical)).toBe(`mcp:${serverId}`);
    expect(toolRegistry.schemas().some((s) => s.function.name === canonical)).toBe(true);

    // Tool metadata is normalized (untrusted schema bounded) before exposure.
    const readTool = manager.listTools(serverId).find((t) => t.originalName === "read_fixture")!;
    expect(readTool.canonicalName).toBe(canonical);
    expect(readTool.permissionResource).toBe(`mcp:${serverId}/read_fixture`);
    expect(readTool.risk).toBe("read");

    // The server really got the request: call it through the full pipeline.
    writeWorkspaceFile("fixture.txt", "hello-from-fixture");
    const viaGateway = JSON.parse(
      await executeTool(canonical, { name: "fixture.txt" }, {
        cwd: workspace,
        workspaceRoot: workspace,
        sandboxMode: "workspace",
        sessionId: "sess-mcp-live",
      }),
    );
    expect(viaGateway.exitCode).toBe(0);
    expect(viaGateway.stdout).toBe("hello-from-fixture");
    expect(viaGateway.stderr).toBe("");

    // A failing tool returns a normalized error, and the session survives.
    const failed = JSON.parse(await manager.callTool(serverId, "fail_tool", {}));
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toContain("fixture failure");
    expect(manager.status(serverId)).toBe("connected");

    // Process reuse: repeated calls do not spawn a second server.
    expect(JSON.parse(await manager.callTool(serverId, "echo", { text: "a" })).stdout).toBe("a");
    expect(JSON.parse(await manager.callTool(serverId, "echo", { text: "b" })).stdout).toBe("b");
    const { getActiveMcpClients } = await import("../../lib/mcpRunner");
    expect(getActiveMcpClients()).toHaveLength(1);

    // ── 77.28 permission: deny must stop the call BEFORE the server sees it ──
    fs.writeFileSync(callLog, "", "utf8");
    const dangerous = canonicalMcpToolName(serverId, "dangerous_write");
    expect(toolRegistry.has(dangerous)).toBe(true);

    const target = path.join(workspace, "should-not-exist.txt");
    const denied = JSON.parse(
      await executeTool(dangerous, { path: target, content: "pwned" }, {
        cwd: workspace,
        workspaceRoot: workspace,
        sandboxMode: "workspace",
        sessionId: "sess-mcp-deny",
      }),
    );
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr.toLowerCase()).toContain("denied");
    // The side effect did not happen, and the server was never asked for it.
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(callLog, "utf8")).not.toContain("dangerous_write");

    // Disconnect withdraws the server's tools from the registry.
    expect(toolRegistry.namesByOwner(`mcp:${serverId}`).length).toBeGreaterThan(0);
    await manager.disconnect(serverId);
    expect(toolRegistry.namesByOwner(`mcp:${serverId}`)).toEqual([]);
    expect(manager.status(serverId)).toBe("unavailable");
  }, 30_000);

  test("an untrusted server is skipped — discovery never becomes execution", async () => {
    writeWorkspaceFile(".toolnet/mcp.json", JSON.stringify({
      mcpServers: {
        untrusted: {
          command: "bun",
          args: ["run", FIXTURE_SERVER],
          env: { MCP_FIXTURE_ROOT: workspace },
        },
      },
    }));

    const manager = new McpManager();
    const report = await manager.sync(workspace);

    expect(report.connected).toEqual([]);
    expect(report.skipped[0]!.status).toBe("untrusted");
    expect(toolRegistry.list().filter((t) => t.name.startsWith("mcp__"))).toEqual([]);
    await manager.dispose();
  }, 30_000);
});

describe("MCP permission E2E — scoped delegation", () => {
  test("a subagent cannot escalate to an MCP tool the parent denies", () => {
    const mcpName = "mcp__github__dangerous_write";
    const scope = deriveSubagentPermission({
      parentPermission: { defaultDecision: "allow", tools: { [mcpName]: "deny" } },
      agentDefinition: {
        id: "coder",
        name: "coder",
        description: "coder",
        mode: "subagent",
        allowedTools: [mcpName],
      } as never,
    });

    // Parent deny always wins — registration grants nothing.
    expect(scope.tools[mcpName]).toBe("deny");
  });
});

describe("Plugin E2E — one registry, one dispatch path", () => {
  test("a real plugin tool executes through ToolGateway, not a private path", async () => {
    const pluginDir = path.join(workspace, "plugins");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "reverse.ts"),
      `export default {
        id: "text-tools",
        setup(ctx) {
          ctx.registerTool({
            name: "reverse_text",
            description: "Reverse a string",
            risk: "read",
            execute: (input) => String(input.text ?? "").split("").reverse().join(""),
          });
        },
      };`,
      "utf8",
    );
    writeWorkspaceFile(".toolnet/plugins.json", JSON.stringify({ plugins: ["./plugins/reverse.ts"] }));

    const runtime = new PluginRuntime();
    const report = await runtime.loadAll(workspace);
    expect(report.failures).toEqual([]);

    const canonical = pluginToolName("text-tools", "reverse_text");
    expect(toolRegistry.has(canonical)).toBe(true);
    // Visible to the model in the same schema set as built-ins.
    expect(toolRegistry.schemas().some((s) => s.function.name === canonical)).toBe(true);

    const raw = await executeTool(canonical, { text: "abc" }, {
      cwd: workspace,
      workspaceRoot: workspace,
      sandboxMode: "workspace",
      sessionId: "sess-plugin",
    });
    expect(JSON.parse(raw)).toEqual({ stdout: "cba", stderr: "", exitCode: 0 });

    await runtime.dispose();
    expect(toolRegistry.has(canonical)).toBe(false);
  }, 30_000);

  test("a mutating plugin tool requires approval — registration grants no privilege", async () => {
    const pluginDir = path.join(workspace, "plugins");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "writer.ts"),
      `export default {
        id: "writer",
        setup(ctx) {
          ctx.registerTool({ name: "write_thing", description: "w", risk: "write", execute: () => "wrote" });
        },
      };`,
      "utf8",
    );
    writeWorkspaceFile(".toolnet/plugins.json", JSON.stringify({ plugins: ["./plugins/writer.ts"] }));

    const runtime = new PluginRuntime();
    await runtime.loadAll(workspace);
    const canonical = pluginToolName("writer", "write_thing");

    const denied = JSON.parse(
      await executeTool(canonical, {}, {
        cwd: workspace,
        workspaceRoot: workspace,
        sandboxMode: "workspace",
        sessionId: "sess-plugin-ask",
      }),
    );
    expect(denied.needsApproval).toBe(true);
    expect(denied.stdout).toBe("");

    // With an explicit approval the same call executes.
    const approved = JSON.parse(
      await executeTool(canonical, {}, {
        cwd: workspace,
        workspaceRoot: workspace,
        sandboxMode: "workspace",
        sessionId: "sess-plugin-ask",
        userApproved: true,
      }),
    );
    expect(approved.stdout).toBe("wrote");

    await runtime.dispose();
  }, 30_000);
});

describe("Hook E2E — ordering, error routing and blocking", () => {
  test("tool.before → execute → tool.after fires in order for a successful call", async () => {
    const target = writeWorkspaceFile("order.txt", "content");
    const events: string[] = [];

    hookRegistry.register({
      name: "tool.before",
      owner: "plugin:probe",
      failurePolicy: "warn",
      handler: () => void events.push("before"),
    });
    hookRegistry.register({
      name: "tool.after",
      owner: "plugin:probe",
      handler: () => void events.push("after"),
    });

    const raw = await executeTool("read_file", { path: target }, {
      cwd: workspace,
      workspaceRoot: workspace,
      sandboxMode: "workspace",
      sessionId: `sess-hooks-ok-${Date.now()}`,
    });
    expect(JSON.parse(raw).exitCode).toBe(0);
    expect(events).toEqual(["before", "after"]);
  });

  test("a failed execution routes to tool.error instead of tool.after", async () => {
    const events: string[] = [];

    hookRegistry.register({
      name: "tool.before",
      owner: "plugin:probe",
      failurePolicy: "warn",
      handler: () => void events.push("before"),
    });
    hookRegistry.register({ name: "tool.after", owner: "plugin:probe", handler: () => void events.push("after") });
    hookRegistry.register({ name: "tool.error", owner: "plugin:probe", handler: () => void events.push("error") });

    const raw = await executeTool("read_file", { path: path.join(workspace, "missing.txt") }, {
      cwd: workspace,
      workspaceRoot: workspace,
      sandboxMode: "workspace",
      sessionId: `sess-hooks-err-${Date.now()}`,
    });
    expect(JSON.parse(raw).exitCode).toBe(1);
    expect(events).toEqual(["before", "error"]);
    expect(events).not.toContain("after");
  });

  test("multiple plugins observe in load order", async () => {
    const events: string[] = [];
    hookRegistry.register({ name: "tool.before", owner: "plugin:a", failurePolicy: "warn", handler: () => void events.push("a") });
    hookRegistry.register({ name: "tool.before", owner: "plugin:b", failurePolicy: "warn", handler: () => void events.push("b") });
    hookRegistry.register({ name: "tool.before", owner: "plugin:c", failurePolicy: "warn", handler: () => void events.push("c") });

    const target = writeWorkspaceFile("order2.txt", "x");
    await executeTool("read_file", { path: target }, {
      cwd: workspace,
      workspaceRoot: workspace,
      sandboxMode: "workspace",
      sessionId: `sess-order-${Date.now()}`,
    });
    expect(events).toEqual(["a", "b", "c"]);
  });

  test("a blocking hook prevents the shell process from ever running", async () => {
    const marker = path.join(workspace, "blocked.txt");

    hookRegistry.register({
      name: "tool.before",
      owner: "plugin:deny-shell",
      handler: (invocation) => {
        const tool = (invocation.input as { tool?: string }).tool;
        if (tool !== "shell") return;
        return { action: "deny", reason: "shell is disabled by policy plugin" };
      },
    });

    const raw = await executeTool("shell", { command: `touch ${marker}` }, {
      cwd: workspace,
      workspaceRoot: workspace,
      sandboxMode: "workspace",
      sessionId: `sess-block-${Date.now()}`,
    });

    const parsed = JSON.parse(raw);
    expect(parsed.exitCode).toBe(1);
    expect(parsed.stderr).toContain("shell is disabled by policy plugin");
    // No process ran, so no file exists — the veto is real, not cosmetic.
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("a transform hook rewrites the arguments the tool actually receives", async () => {
    const real = writeWorkspaceFile("real.txt", "real-content");

    hookRegistry.register({
      name: "tool.before",
      owner: "plugin:redirect",
      handler: (invocation) => {
        const tool = (invocation.input as { tool?: string }).tool;
        if (tool !== "read_file") return;
        return { action: "transform", args: { path: real } };
      },
    });

    const raw = await executeTool("read_file", { path: path.join(workspace, "redirected-away.txt") }, {
      cwd: workspace,
      workspaceRoot: workspace,
      sandboxMode: "workspace",
      sessionId: `sess-transform-${Date.now()}`,
    });

    const parsed = JSON.parse(raw);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toBe("real-content");
  });

  test("a broken blocking hook fails closed", async () => {
    hookRegistry.register({
      name: "tool.before",
      owner: "plugin:broken-guard",
      handler: () => {
        throw new Error("guard unavailable");
      },
    });

    const raw = await executeTool("read_file", { path: path.join(workspace, "anything.txt") }, {
      cwd: workspace,
      workspaceRoot: workspace,
      sandboxMode: "workspace",
      sessionId: `sess-failclosed-${Date.now()}`,
    });

    expect(JSON.parse(raw).exitCode).toBe(1);
  });

  test("background job lifecycle fires both observer edges", async () => {
    const events: string[] = [];
    hookRegistry.register({
      name: "background.started",
      owner: "plugin:jobs",
      handler: (invocation) => {
        const payload = invocation.output as { jobId: string };
        events.push(`started:${payload.jobId}`);
      },
    });
    hookRegistry.register({
      name: "background.completed",
      owner: "plugin:jobs",
      handler: (invocation) => {
        const payload = invocation.output as { jobId: string; status: string };
        events.push(`completed:${payload.status}`);
      },
    });

    const jobs = new BackgroundJobService({ persistPath: null, recoverOnInit: false });
    const job = jobs.start({ type: "tool", title: "hook probe", run: async () => "ok" });
    const settled = await jobs.wait(job.id, 2_000);
    expect(settled?.job.status).toBe("completed");

    // The observer edges are detached; yield once so they are observed.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual([`started:${job.id}`, "completed:completed"]);
  });

  test("a throwing background hook cannot affect job settlement", async () => {
    hookRegistry.register({
      name: "background.completed",
      owner: "plugin:broken-jobs",
      handler: () => {
        throw new Error("job hook exploded");
      },
    });

    const jobs = new BackgroundJobService({ persistPath: null, recoverOnInit: false });
    const job = jobs.start({ type: "tool", title: "still fine", run: async () => "ok" });
    const settled = await jobs.wait(job.id, 2_000);
    expect(settled?.job.status).toBe("completed");
    expect(settled?.job.result).toBe("ok");
  });

  test("withdrawing a plugin's hooks stops its policy from applying", async () => {
    const marker = path.join(workspace, "after-removal.txt");
    hookRegistry.register({
      name: "tool.before",
      owner: "plugin:temporary",
      handler: () => ({ action: "deny", reason: "temporary block" }),
    });

    const blocked = JSON.parse(
      await executeTool("shell", { command: `touch ${marker}` }, {
        cwd: workspace,
        workspaceRoot: workspace,
        sandboxMode: "workspace",
        sessionId: `sess-remove-1-${Date.now()}`,
      }),
    );
    expect(blocked.exitCode).toBe(1);

    expect(hookRegistry.unregisterOwner("plugin:temporary")).toBe(1);

    const allowed = JSON.parse(
      await executeTool("shell", { command: `touch ${marker}` }, {
        cwd: workspace,
        workspaceRoot: workspace,
        sandboxMode: "workspace",
        sessionId: `sess-remove-2-${Date.now()}`,
      }),
    );
    expect(allowed.exitCode).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
  });
});

describe("Shipped example plugins — loaded from examples/ live", () => {
  const EXAMPLES = path.resolve(__dirname, "../../../examples/plugins");

  function installExample(name: string): string {
    const source = fs.readFileSync(path.join(EXAMPLES, `${name}.ts`), "utf8");
    const target = path.join(workspace, "plugins", `${name}.ts`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, "utf8");
    return `./plugins/${name}.ts`;
  }

  test("both example plugins load and register exactly one hook each", async () => {
    const specs = [installExample("format-after-write"), installExample("deny-secret-files")];
    writeWorkspaceFile(".toolnet/plugins.json", JSON.stringify({ plugins: specs }));

    const runtime = new PluginRuntime();
    const report = await runtime.loadAll(workspace);

    expect(report.failures).toEqual([]);
    expect(report.loaded.map((r) => r.id).sort()).toEqual(["deny-secret-files", "format-after-write"]);
    expect(report.loaded.every((r) => r.hookCount === 1)).toBe(true);
    // Neither example contributes a tool — they are policy/observer plugins.
    expect(report.loaded.every((r) => r.toolNames.length === 0)).toBe(true);

    await runtime.dispose();
    expect(hookRegistry.list()).toHaveLength(0);
  });

  test("deny-secret-files blocks credential reads before any access", async () => {
    const spec = installExample("deny-secret-files");
    writeWorkspaceFile(".toolnet/plugins.json", JSON.stringify({ plugins: [spec] }));
    writeWorkspaceFile(".env", "SECRET=hunter2");

    const runtime = new PluginRuntime();
    const report = await runtime.loadAll(workspace);
    expect(report.failures).toEqual([]);

    const denied = JSON.parse(
      await executeTool("read_file", { path: ".env" }, {
        cwd: workspace,
        workspaceRoot: workspace,
        sandboxMode: "workspace",
        sessionId: "sess-example-deny",
      }),
    );
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toContain("deny-secret-files policy plugin");
    expect(denied.stdout).toBe("");

    // Ordinary files still pass.
    const allowed = JSON.parse(
      await executeTool("read_file", { path: "notes.txt" }, {
        cwd: workspace,
        workspaceRoot: workspace,
        sandboxMode: "full-access",
        sessionId: "sess-example-allow",
      }),
    );
    expect(allowed.exitCode).toBe(1); // missing file, but NOT blocked by the hook
    expect(allowed.stderr).not.toContain("policy plugin");

    await runtime.dispose();
  });

  test("format-after-write never breaks a write and never installs a formatter", async () => {
    const spec = installExample("format-after-write");
    writeWorkspaceFile(".toolnet/plugins.json", JSON.stringify({ plugins: [spec] }));

    const runtime = new PluginRuntime();
    const report = await runtime.loadAll(workspace);
    expect(report.failures).toEqual([]);

    // No package.json and no formatter anywhere: the hook must degrade to a
    // no-op warning, not fail the write.
    const written = JSON.parse(
      await executeTool("write_file", { path: "src/thing.ts", content: "export const x = 1;\n" }, {
        cwd: workspace,
        workspaceRoot: workspace,
        sandboxMode: "full-access",
        sessionId: "sess-example-format",
      }),
    );
    expect(written.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(workspace, "src/thing.ts"), "utf8")).toBe("export const x = 1;\n");

    await runtime.dispose();
  });
});

describe("Security engine — external tool classification", () => {
  test("permission resources are derived from canonical external names", () => {
    expect(securityEngine.toolPermissionResource("mcp__github__search_code")).toBe("mcp:github/search_code");
    expect(securityEngine.toolPermissionResource("plugin__fmt__run")).toBe("plugin:fmt/run");
    expect(securityEngine.toolPermissionResource("read_file")).toBeUndefined();
  });
});

/**
 * Phase 77.12/77.39 — structural guards.
 *
 * These read the source rather than behaviour: a future change that gives
 * plugins or MCP their own model loop, provider call or executor would still
 * pass every functional test above, but must not be allowed to land silently.
 */
describe("Architecture guard — one kernel, one registry", () => {
  const readSource = (relative: string): string =>
    fs.readFileSync(path.resolve(__dirname, "../..", relative), "utf8");

  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

  test("extension modules never call a provider or the tool gateway directly", () => {
    const files = [
      "core/plugins/runtime.ts",
      "core/plugins/loader.ts",
      "core/mcp/manager.ts",
      "core/mcp/adapter.ts",
    ];

    for (const file of files) {
      const source = stripComments(readSource(file));
      // A second model path or a re-entrant gateway call would be a duplicate
      // execution path.
      expect(source).not.toMatch(/provider\.(chat|stream)\s*\(/);
      expect(source).not.toMatch(/ToolGateway\.execute\s*\(/);
      expect(source).not.toMatch(/executeToolBatch\s*\(/);
      expect(source).not.toMatch(/for await\s*\(/);
    }
  });

  test("extension tools enter the canonical registry by name, not a side table", () => {
    const pluginSource = stripComments(readSource("core/plugins/runtime.ts"));
    const mcpSource = stripComments(readSource("core/mcp/adapter.ts"));

    expect(pluginSource).toContain("toolRegistry.register(");
    expect(mcpSource).toContain("toolRegistry.register(");
    // Dynamic registrations are owner-scoped so they can be withdrawn atomically.
    expect(pluginSource).toContain("toolRegistry.unregisterOwner(");
    expect(mcpSource).toContain("unregisterOwner(");
  });

  test("plugin and MCP hooks are registered through the sole hook registry", () => {
    const pluginSource = stripComments(readSource("core/plugins/runtime.ts"));
    expect(pluginSource).toContain("hookRegistry.register(");
    expect(pluginSource).toContain("hookRegistry.unregisterOwner(");

    // The tool chokepoint is the ONLY place tool hooks fire.
    const gatewaySource = stripComments(readSource("lib/security/toolGateway.ts"));
    for (const hook of ["tool.before", "tool.after", "tool.error", "shell.before"]) {
      expect(gatewaySource).toContain(`"${hook}"`);
    }
  });

  test("the TUI assembles its schema set from the registry alone", () => {
    const wiring = stripComments(readSource("tui/events/agentWiring.ts"));
    // No concatenation of a second tool source (the old plugin-tool list).
    expect(wiring).not.toMatch(/toolRegistry\.schemas\(\),\s*\.\.\./);
    expect(wiring).not.toContain("getRegisteredTools");
    expect(wiring).toContain("toolRegistry.schemas()");
  });
});
