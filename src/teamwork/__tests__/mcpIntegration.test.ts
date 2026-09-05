import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  initMcpClients,
  closeMcpClients,
  loadLocalMcpConfig,
  spawnMcpServer,
  getLocalMcpServers,
  mcpTrustManager,
  getMcpAgentTools,
} from "../../lib/mcpRunner";
import { getMergedAgentTools, executeTool } from "../../lib/agentTools";
import { setSandboxMode } from "../../lib/permissions";

/**
 * Layer 4 Phase 3 updated integration flow:
 *  - workspace mcp.json is DISCOVERED but NOT auto-spawned (untrusted);
 *  - explicit trust (enableServer) is required before spawn;
 *  - tools appear under canonical names mcp__<serverId>__<tool>;
 *  - execution routes through executeTool → ToolGateway (SecurityEngine).
 */
describe("MCP Integration Tests", () => {
  let tempDir: string;

  beforeEach(() => {
    setSandboxMode("workspace");
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-integration-test-"));
    const mockMcpPath = path.resolve(__dirname, "../../mock-mcp.ts");

    const mcpConfig = {
      mcpServers: {
        "mock-weather-server": {
          command: "bun",
          args: ["run", mockMcpPath],
        },
      },
    };

    fs.writeFileSync(
      path.join(tempDir, "mcp.json"),
      JSON.stringify(mcpConfig, null, 2),
      "utf8"
    );
  });

  afterEach(async () => {
    await closeMcpClients();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("a) Local mock MCP server can be spawned via mcpRunner.ts with temporary mcp.json", async () => {
    const configs = loadLocalMcpConfig(tempDir);
    expect(configs["mock-weather-server"]).toBeDefined();
    expect(configs["mock-weather-server"].command).toBe("bun");

    const child = spawnMcpServer("mock-weather-server", configs["mock-weather-server"], tempDir);
    expect(child).toBeDefined();
    expect(child.pid).toBeGreaterThan(0);
    child.kill();
  });

  test("a2) Workspace server discovered but NOT auto-spawned while untrusted", async () => {
    const servers = getLocalMcpServers(tempDir);
    expect(servers.length).toBe(1);
    expect(servers[0].sourceKind).toBe("USER_CONFIG");

    const status = await initMcpClients(tempDir);
    expect(status.connectedServers).toHaveLength(0);
    expect(status.skippedServers.map(s => s.name)).toContain("mock-weather-server");
    // No tools leak from an untrusted server.
    expect(getMcpAgentTools()).toHaveLength(0);
  });

  test("b) After explicit enable, tools are fetched under canonical namespace", async () => {
    const servers = getLocalMcpServers(tempDir);
    const server = servers[0];
    // Simulate the /mcp enable <name> user decision.
    mcpTrustManager.enableServer(server.serverId, server.config, server.sourceFile);

    const status = await initMcpClients(tempDir);
    expect(status.connectedServers).toContain("mock-weather-server");
    expect(status.totalTools).toBeGreaterThanOrEqual(1);
    expect(status.failedServers).toHaveLength(0);

    // Canonical namespaced tool name — raw name never exposed.
    const mergedTools = getMergedAgentTools();
    const weatherTool = mergedTools.find(
      (t: any) => t.function?.name === `mcp__${server.serverId}__get_weather`
    );
    expect(weatherTool).toBeDefined();
    expect(weatherTool.function.description.toLowerCase()).toContain("weather");
    // No raw-name tool leaks into the merged registry.
    expect(mergedTools.some((t: any) => t.function?.name === "get_weather")).toBe(false);
  });

  test("c) Calling executeTool('mcp__<id>__get_weather') routes through ToolGateway to the mock server", async () => {
    const servers = getLocalMcpServers(tempDir);
    const server = servers[0];
    mcpTrustManager.enableServer(server.serverId, server.config, server.sourceFile);
    await initMcpClients(tempDir);

    const canonical = `mcp__${server.serverId}__get_weather`;
    const rawResult = await executeTool(canonical, { location: "Hanoi" });
    expect(rawResult).toBeDefined();

    const parsedResult = JSON.parse(rawResult);
    expect(parsedResult.exitCode).toBe(0);
    expect(parsedResult.stderr).toBe("");

    const weatherData = JSON.parse(parsedResult.stdout);
    expect(weatherData.location).toBe("Hanoi");
    expect(weatherData.temperature).toBe("72°F");
    expect(weatherData.condition).toBe("Sunny");
  });

  test("d) Clean shutdown (closeMcpClients) terminates client and removes tools", async () => {
    const servers = getLocalMcpServers(tempDir);
    mcpTrustManager.enableServer(servers[0].serverId, servers[0].config, servers[0].sourceFile);
    await initMcpClients(tempDir);

    const canonical = `mcp__${servers[0].serverId}__get_weather`;
    let mergedTools = getMergedAgentTools();
    expect(mergedTools.some((t: any) => t.function?.name === canonical)).toBe(true);

    await closeMcpClients();
    mergedTools = getMergedAgentTools();
    expect(mergedTools.some((t: any) => t.function?.name === canonical)).toBe(false);
  });
});
