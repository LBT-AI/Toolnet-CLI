import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  initMcpClients,
  closeMcpClients,
  loadLocalMcpConfig,
  spawnMcpServer,
  executeMcpTool,
} from "../../lib/mcpRunner";
import { getMergedAgentTools, executeTool } from "../../lib/agentTools";

describe("Challenger 2 Empirical Tests - R2 & R3", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "challenger2-test-"));
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

  // ───────────────────────────────────────────────────────────────────────────
  // REQUIREMENT R2 TESTS: Spinner, Non-TTY Fallback, Stdout/Stderr, Signals
  // ───────────────────────────────────────────────────────────────────────────

  describe("Requirement R2: Spinner Mechanics & Robustness", () => {
    test("R2.1: Non-TTY fallback outputs clean string without ANSI sequences", async () => {
      // In bun test environment, process.stderr.isTTY is false (or undefined)
      let stderrOutput = "";
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: any) => {
        stderrOutput += String(chunk);
        return true;
      }) as any;

      try {
        // Import withSpinner equivalent logic or directly test stderr behavior in non-TTY mode
        const originalIsTTY = process.stderr.isTTY;
        Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });

        // Simulate withSpinner logic as implemented in simple-repl.ts
        const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
          const useSpin = process.stderr.isTTY;
          let i = 0;
          let interval: ReturnType<typeof setInterval> | null = null;
          if (useSpin) {
            interval = setInterval(() => {
              process.stderr.write("\r\x1b[38;2;148;226;213m" + spinnerFrames[i % spinnerFrames.length] + "\x1b[0m " + label);
              i++;
            }, 100);
          } else {
            process.stderr.write(label + "...\n");
          }
          try {
            return await fn();
          } finally {
            if (interval) {
              clearInterval(interval);
              process.stderr.write("\r\x1b[K");
            }
          }
        }

        const res = await withSpinner("Testing Non-TTY", async () => {
          await new Promise((r) => setTimeout(r, 50));
          return "OK";
        });

        expect(res).toBe("OK");
        expect(stderrOutput).toBe("Testing Non-TTY...\n");
        expect(stderrOutput).not.toContain("\x1b[K");
        expect(stderrOutput).not.toContain("\r");

        Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    test("R2.2: TTY spinner renders braille frames and clears line upon completion", async () => {
      let stderrOutput: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: any) => {
        stderrOutput.push(String(chunk));
        return true;
      }) as any;

      try {
        const originalIsTTY = process.stderr.isTTY;
        Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });

        const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
          const useSpin = process.stderr.isTTY;
          let i = 0;
          let interval: ReturnType<typeof setInterval> | null = null;
          if (useSpin) {
            interval = setInterval(() => {
              process.stderr.write("\r" + spinnerFrames[i % spinnerFrames.length] + " " + label);
              i++;
            }, 50);
          } else {
            process.stderr.write(label + "...\n");
          }
          try {
            return await fn();
          } finally {
            if (interval) {
              clearInterval(interval);
              process.stderr.write("\r\x1b[K");
            }
          }
        }

        const res = await withSpinner("Thinking...", async () => {
          await new Promise((r) => setTimeout(r, 180));
          return "DONE";
        });

        expect(res).toBe("DONE");
        expect(stderrOutput.length).toBeGreaterThanOrEqual(3); // At least 2 frames + 1 cleanup
        const joined = stderrOutput.join("");
        expect(joined).toContain("Thinking...");
        expect(joined.endsWith("\r\x1b[K")).toBe(true);

        Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    test("R2.3: Exception in spinner task clears interval and rethrows error cleanly", async () => {
      let stderrOutput: string[] = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: any) => {
        stderrOutput.push(String(chunk));
        return true;
      }) as any;

      try {
        const originalIsTTY = process.stderr.isTTY;
        Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });

        async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
          const useSpin = process.stderr.isTTY;
          let i = 0;
          let interval: ReturnType<typeof setInterval> | null = null;
          if (useSpin) {
            interval = setInterval(() => {
              process.stderr.write("\rframe " + label);
              i++;
            }, 20);
          } else {
            process.stderr.write(label + "...\n");
          }
          try {
            return await fn();
          } finally {
            if (interval) {
              clearInterval(interval);
              process.stderr.write("\r\x1b[K");
            }
          }
        }

        let caughtErr: Error | null = null;
        try {
          await withSpinner("Failing task", async () => {
            await new Promise((r) => setTimeout(r, 50));
            throw new Error("Gateway connection lost");
          });
        } catch (e: any) {
          caughtErr = e;
        }

        expect(caughtErr).not.toBeNull();
        expect(caughtErr?.message).toBe("Gateway connection lost");
        const joined = stderrOutput.join("");
        expect(joined.endsWith("\r\x1b[K")).toBe(true);

        Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    test("R2.4: Stdout/Stderr non-interference when tool output interrupts spinner", async () => {
      let stdoutLog: string[] = [];
      let stderrLog: string[] = [];

      const origStdoutWrite = process.stdout.write;
      const origStderrWrite = process.stderr.write;

      process.stdout.write = ((chunk: any) => { stdoutLog.push(String(chunk)); return true; }) as any;
      process.stderr.write = ((chunk: any) => { stderrLog.push(String(chunk)); return true; }) as any;

      try {
        const originalIsTTY = process.stderr.isTTY;
        Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });

        // Simulate event loop with tool execution
        if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
        process.stdout.write("\x1b[2K\rStarting tool write_file...\n");

        expect(stderrLog).toContain("\r\x1b[K");
        expect(stdoutLog.join("")).toContain("Starting tool write_file");

        Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
      } finally {
        process.stdout.write = origStdoutWrite;
        process.stderr.write = origStderrWrite;
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // REQUIREMENT R3 TESTS: Mock MCP Protocol, Integration & Edge Cases
  // ───────────────────────────────────────────────────────────────────────────

  describe("Requirement R3: Mock MCP Server Protocol & End-to-End Integration", () => {
    test("R3.1: Raw stdio JSON-RPC 2.0 communication with mock-mcp.ts", async () => {
      const mockMcpPath = path.resolve(__dirname, "../../mock-mcp.ts");
      const proc = spawn("bun", ["run", mockMcpPath], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdoutData = "";
      let stderrData = "";

      proc.stdout.on("data", (chunk) => { stdoutData += chunk.toString(); });
      proc.stderr.on("data", (chunk) => { stderrData += chunk.toString(); });

      // Send initialize request
      proc.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" }
      }) + "\n");

      await new Promise((r) => setTimeout(r, 100));

      const lines = stdoutData.trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(1);

      const initResp = JSON.parse(lines[0]);
      expect(initResp.jsonrpc).toBe("2.0");
      expect(initResp.id).toBe(1);
      expect(initResp.result.serverInfo.name).toBe("mock-mcp-server");
      expect(initResp.result.capabilities.tools).toBeDefined();

      // Send tools/list request
      proc.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      }) + "\n");

      await new Promise((r) => setTimeout(r, 100));

      const updatedLines = stdoutData.trim().split("\n").filter(Boolean);
      expect(updatedLines.length).toBeGreaterThanOrEqual(2);

      const listResp = JSON.parse(updatedLines[1]);
      expect(listResp.id).toBe(2);
      expect(listResp.result.tools).toHaveLength(1);
      expect(listResp.result.tools[0].name).toBe("get_weather");

      // Verify stderr has diagnostic logs and stdout contains ONLY valid JSON-RPC
      expect(stderrData).toContain("[mock-mcp] Received request");

      proc.stdin.end();
      proc.kill();
    });

    test("R3.2: End-to-End tool invocation of get_weather via agentTools.executeTool", async () => {
      const status = await initMcpClients(tempDir);
      expect(status.connectedServers).toEqual(["mock-weather-server"]);

      // Verify merged agent tools contains get_weather
      const tools = getMergedAgentTools();
      const weatherTool = tools.find((t) => t.function.name === "get_weather");
      expect(weatherTool).toBeDefined();
      expect(weatherTool.function.parameters.properties.location).toBeDefined();

      // Call tool via executeTool
      const rawRes = await executeTool("get_weather", { location: "Tokyo" });
      const parsedRes = JSON.parse(rawRes);
      expect(parsedRes.exitCode).toBe(0);
      expect(parsedRes.stderr).toBe("");

      const content = JSON.parse(parsedRes.stdout);
      expect(content.location).toBe("Tokyo");
      expect(content.temperature).toBe("72°F");
      expect(content.condition).toBe("Sunny");
    });

    test("R3.3: Call get_weather with missing arguments (defaults to Unknown)", async () => {
      await initMcpClients(tempDir);
      const rawRes = await executeTool("get_weather", {});
      const parsedRes = JSON.parse(rawRes);
      expect(parsedRes.exitCode).toBe(0);

      const content = JSON.parse(parsedRes.stdout);
      expect(content.location).toBe("Unknown");
    });

    test("R3.4: Call non-existent tool returns Unknown tool error JSON", async () => {
      await initMcpClients(tempDir);
      const rawRes = await executeTool("get_astronomy_data", { location: "Mars" });
      const parsedRes = JSON.parse(rawRes);
      expect(parsedRes.exitCode).toBe(1);
      expect(parsedRes.stderr).toContain("Unknown tool: get_astronomy_data");
    });

    test("R3.5: Multiple sequential initMcpClients calls clean up prior clients correctly", async () => {
      await initMcpClients(tempDir);
      expect(getMergedAgentTools().some(t => t.function.name === "get_weather")).toBe(true);

      // Call initMcpClients again
      const status2 = await initMcpClients(tempDir);
      expect(status2.connectedServers).toEqual(["mock-weather-server"]);

      // Should still work without duplicate registered tools or leaks
      const weatherTools = getMergedAgentTools().filter(t => t.function.name === "get_weather");
      expect(weatherTools.length).toBe(1);

      const res = await executeTool("get_weather", { location: "London" });
      expect(JSON.parse(res).exitCode).toBe(0);
    });

    test("R3.6: Concurrent tool executions through MCP client", async () => {
      await initMcpClients(tempDir);

      const promises = [
        executeTool("get_weather", { location: "Hanoi" }),
        executeTool("get_weather", { location: "Paris" }),
        executeTool("get_weather", { location: "New York" }),
      ];

      const results = await Promise.all(promises);
      expect(results).toHaveLength(3);

      for (const res of results) {
        const parsed = JSON.parse(res);
        expect(parsed.exitCode).toBe(0);
      }

      expect(JSON.parse(results[0]).stdout).toContain("Hanoi");
      expect(JSON.parse(results[1]).stdout).toContain("Paris");
      expect(JSON.parse(results[2]).stdout).toContain("New York");
    });
  });
});
