import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  initMcpClients,
  closeMcpClients,
  loadLocalMcpConfig,
  spawnMcpServer,
} from "../../lib/mcpRunner";
import { getMergedAgentTools, executeTool } from "../../lib/agentTools";

describe("MCP Integration Tests", () => {
  let tempDir: string;

  beforeEach(() => {
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

  test("b) Mock server tools (get_weather) are dynamically fetched via initMcpClients and appear in getMergedAgentTools()", async () => {
    const status = await initMcpClients(tempDir);
    expect(status.connectedServers).toContain("mock-weather-server");
    expect(status.totalTools).toBeGreaterThanOrEqual(1);
    expect(status.failedServers).toHaveLength(0);

    const mergedTools = getMergedAgentTools();
    const weatherTool = mergedTools.find(
      (t: any) => t.function?.name === "get_weather"
    );
    expect(weatherTool).toBeDefined();
    expect(weatherTool.function.description).toContain("weather");
  });

  test("c) Calling executeTool('get_weather', { location: 'Hanoi' }) successfully routes to mock MCP server", async () => {
    await initMcpClients(tempDir);

    const rawResult = await executeTool("get_weather", { location: "Hanoi" });
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
    await initMcpClients(tempDir);
    let mergedTools = getMergedAgentTools();
    expect(mergedTools.some((t: any) => t.function?.name === "get_weather")).toBe(true);

    await closeMcpClients();
    mergedTools = getMergedAgentTools();
    expect(mergedTools.some((t: any) => t.function?.name === "get_weather")).toBe(false);
  });
});
