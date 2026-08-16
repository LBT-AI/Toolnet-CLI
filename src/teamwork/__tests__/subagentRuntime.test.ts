import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import {
  executeSubagentTask,
  getSubagentRolePrompt,
  getSubagentTools,
} from "../subagentRuntime";
import { DynamicScheduler } from "../dynamicScheduler";
import type { TaskGraph, TaskNode } from "../types";

describe("Subagent Runtime & Real Execution Engine", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("1. Role Personas & Prompt Formulation", () => {
    test("generates specialized operational prompt for RESEARCHER", () => {
      const prompt = getSubagentRolePrompt("RESEARCHER", "Explore auth flow");
      expect(prompt).toContain("ToolNet Sub-Agent [RESEARCHER]");
      expect(prompt).toContain("read_file, grep, glob, find_path");
      expect(prompt).toContain("Current Task: \"Explore auth flow\"");
      expect(prompt).toContain("Do NOT make file modifications");
    });

    test("generates specialized operational prompt for CODER", () => {
      const prompt = getSubagentRolePrompt("CODER", "Implement password reset");
      expect(prompt).toContain("ToolNet Sub-Agent [CODER]");
      expect(prompt).toContain("write_file, edit_file, or apply_patch");
      expect(prompt).toContain("Current Task: \"Implement password reset\"");
    });

    test("generates specialized operational prompt for TESTER", () => {
      const prompt = getSubagentRolePrompt("TESTER", "Run verification test suite");
      expect(prompt).toContain("ToolNet Sub-Agent [TESTER]");
      expect(prompt).toContain("bun test, npm test");
      expect(prompt).toContain("Summarize test pass/fail statistics");
    });

    test("generates specialized operational prompt for REVIEWER", () => {
      const prompt = getSubagentRolePrompt("REVIEWER", "Review git diff");
      expect(prompt).toContain("ToolNet Sub-Agent [REVIEWER]");
      expect(prompt).toContain("security implications");
      expect(prompt).toContain("APPROVED / CHANGES REQUESTED");
    });
  });

  describe("2. Role-based Tool Filtering & Isolation", () => {
    test("RESEARCHER only has access to read & exploration tools", () => {
      const tools = getSubagentTools("RESEARCHER");
      const toolNames = tools.map((t: any) => t.function?.name);

      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("grep");
      expect(toolNames).toContain("glob");
      expect(toolNames).toContain("find_path");
      expect(toolNames).toContain("web_fetch");

      expect(toolNames).not.toContain("write_file");
      expect(toolNames).not.toContain("edit_file");
      expect(toolNames).not.toContain("apply_patch");
    });

    test("TESTER has access to verification & execution tools", () => {
      const tools = getSubagentTools("TESTER");
      const toolNames = tools.map((t: any) => t.function?.name);

      expect(toolNames).toContain("shell");
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("git_diff");
      expect(toolNames).not.toContain("write_file");
      expect(toolNames).not.toContain("edit_file");
    });

    test("CODER has full access to modification and build tools", () => {
      const tools = getSubagentTools("CODER");
      const toolNames = tools.map((t: any) => t.function?.name);

      expect(toolNames).toContain("write_file");
      expect(toolNames).toContain("edit_file");
      expect(toolNames).toContain("apply_patch");
      expect(toolNames).toContain("read_file");
    });
  });

  describe("3. Real Sub-Agent Execution Loop", () => {
    test("executes tool calls and returns final result from Gateway", async () => {
      let callCount = 0;
      globalThis.fetch = (mock as any)().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First turn: model calls get_cwd
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
                        id: "call_cwd_1",
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

        // Second turn: model returns final summary
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Research complete. The workspace root is /root/toolnet-cli.",
                },
              },
            ],
          }),
        } as any;
      });

      const node: TaskNode = {
        id: "task_research_1",
        title: "Explore workspace location",
        role: "RESEARCHER",
        prompt: "Find the current workspace directory",
        status: "PENDING",
        dependencies: [],
      };

      const result = await executeSubagentTask(node, {
        gatewayUrl: "http://localhost:3000",
        maxTurns: 5,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("Research complete");
      expect(result.toolCallsCount).toBe(1);
      expect(result.turnsUsed).toBe(2);
      expect(result.role).toBe("RESEARCHER");
    });

    test("handles Gateway network failure gracefully", async () => {
      globalThis.fetch = (mock as any)().mockRejectedValue(new Error("Connection refused"));

      const node: TaskNode = {
        id: "task_fail_1",
        title: "Failing task",
        role: "CODER",
        prompt: "Do something",
        status: "PENDING",
        dependencies: [],
      };

      const result = await executeSubagentTask(node, {
        gatewayUrl: "http://localhost:3000",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Gateway network error");
    });
  });

  describe("4. DynamicScheduler Integration with Real Sub-Agents", () => {
    test("DynamicScheduler dispatches tasks to executeSubagentTask and updates token metrics", async () => {
      globalThis.fetch = (mock as any)().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Subagent completed assigned task successfully.",
              },
            },
          ],
        }),
      } as any);

      const graph: TaskGraph = {
        sessionId: "subagent-test-session",
        mode: "STANDARD",
        createdAt: Date.now(),
        nodes: [
          {
            id: "node_1",
            title: "Task 1",
            role: "RESEARCHER",
            prompt: "Analyze codebase",
            status: "PENDING",
            dependencies: [],
          },
          {
            id: "node_2",
            title: "Task 2",
            role: "CODER",
            prompt: "Write implementation",
            status: "PENDING",
            dependencies: ["node_1"],
          },
        ],
      };

      const scheduler = new DynamicScheduler(graph, {
        gatewayUrl: "http://localhost:3000",
        maxConcurrencyOverride: 1,
      });

      const finalState = await scheduler.start();
      expect(finalState.status).toBe("COMPLETED");
      expect(finalState.completedTaskIds).toContain("node_1");
      expect(finalState.completedTaskIds).toContain("node_2");
    });
  });
});
