import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { AgentHarness, getHarness, resetHarness } from "../../lib/harness";
import { setSandboxMode } from "../../lib/permissions";
import type { HarnessEvent } from "../../lib/harness/types";

describe("Unified AgentHarness Architecture", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setSandboxMode("ask");
    resetHarness();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setSandboxMode("ask");
    resetHarness();
  });

  describe("1. Kernel Initialization & State Snapshot", () => {
    test("initializes kernel and reports active subsystems state", () => {
      const harness = new AgentHarness({
        model: "openai/gpt-4o",
        sandboxMode: "workspace",
      });

      const snapshot = harness.getSnapshot();
      expect(snapshot.sessionId).toBeDefined();
      expect(snapshot.workspaceRoot).toBeDefined();
      expect(snapshot.currentModel).toBe("openai/gpt-4o");
      expect(snapshot.sandboxMode).toBe("workspace");
      expect(snapshot.activeFramework).toBeDefined();
      expect(snapshot.totalTokensUsed).toBe(0);
      expect(snapshot.totalToolCalls).toBe(0);
    });

    test("singleton getHarness returns consistent instance", () => {
      const h1 = getHarness();
      const h2 = getHarness();
      expect(h1).toBe(h2);
    });
  });

  describe("2. Tool Dispatching & Security Middleware", () => {
    test("dispatches tool with automatic security evaluation and secret redaction", async () => {
      const harness = new AgentHarness({ sandboxMode: "workspace" });

      // Allowed safe tool
      const res = await harness.dispatchTool("get_cwd", {});
      expect(res.allowed).toBe(true);
      expect(res.result).toContain("stdout");

      // Blocked outside tool
      const blockedRes = await harness.dispatchTool("read_file", { path: "/etc/shadow" });
      expect(blockedRes.allowed).toBe(false);
      expect(blockedRes.result).toContain("Permission Denied");
    });
  });

  describe("3. Headless Execution Strategy", () => {
    test("runs headless task with full context & tool execution loop", async () => {
      let turn = 0;
      globalThis.fetch = (mock as any)().mockImplementation(async () => {
        turn++;
        if (turn === 1) {
          return {
            ok: true,
            json: async () => ({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "",
                    tool_calls: [
                      {
                        id: "tc_1",
                        type: "function",
                        function: { name: "get_cwd", arguments: "{}" },
                      },
                    ],
                  },
                },
              ],
            }),
          } as any;
        }

        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Project workspace is active.",
                },
              },
            ],
          }),
        } as any;
      });

      const harness = new AgentHarness();
      const result = await harness.runHeadless("Check workspace root");

      expect(result.success).toBe(true);
      expect(result.output).toBe("Project workspace is active.");
      expect(result.toolCallsCount).toBe(1);
      expect(result.turnsUsed).toBe(2);
      expect(result.mode).toBe("HEADLESS");
    });
  });

  describe("4. Turbo Execution Strategy", () => {
    test("executes tiny tasks in single-pass turbo mode", async () => {
      globalThis.fetch = (mock as any)().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Turbo task resolved instantly.",
              },
            },
          ],
        }),
      } as any);

      const harness = new AgentHarness();
      const result = await harness.runTurbo("Quick inspect");

      expect(result.success).toBe(true);
      expect(result.output).toContain("Turbo task resolved instantly");
      expect(result.mode).toBe("TURBO");
    });
  });

  describe("5. Sub-Agent Delegation via Harness", () => {
    test("spawns specialized subagent task with role isolation", async () => {
      globalThis.fetch = (mock as any)().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Code analysis findings compiled.",
              },
            },
          ],
        }),
      } as any);

      const harness = new AgentHarness();
      const result = await harness.runSubagent("RESEARCHER", "Find database modules");

      expect(result.success).toBe(true);
      expect(result.output).toContain("Code analysis findings compiled");
      expect(result.mode).toBe("SUBAGENT");
    });
  });

  describe("6. Event Bus & Telemetry Pipeline", () => {
    test("emits lifecycle events across execution pipeline", async () => {
      globalThis.fetch = (mock as any)().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Done.",
              },
            },
          ],
        }),
      } as any);

      const harness = new AgentHarness();
      const events: HarnessEvent[] = [];

      harness.on((event) => {
        events.push(event);
      });

      await harness.runHeadless("Simple test query");

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("agent:start");
      expect(eventTypes).toContain("agent:complete");
    });
  });
});
