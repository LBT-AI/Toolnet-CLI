import { test, expect, describe, mock } from "bun:test";
import path from "node:path";
import { agentTools, executeTool } from "../../lib/agentTools";
import { AgentRuntime } from "../../lib/agentRuntime";

describe("Step 2 - P0-A Agent Execution Foundation", () => {
  test("agentTools registry exposes all mandatory tools with schemas", () => {
    const toolNames = agentTools.map((t) => t.function.name);
    expect(toolNames).toContain("run_command");
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("write_file");
    expect(toolNames).toContain("edit_file");
    expect(toolNames).toContain("replace_all");
    expect(toolNames).toContain("grep_search");
    expect(toolNames).toContain("glob_search");
    expect(toolNames).toContain("get_cwd");
    expect(toolNames).toContain("list_dir");
    expect(toolNames).toContain("file_exists");
    expect(toolNames).toContain("glob");
    expect(toolNames).toContain("grep");
    expect(toolNames).toContain("shell");
    expect(toolNames).toContain("web_fetch");
    expect(toolNames.length).toBeGreaterThanOrEqual(14);

    // Verify read_file has offset and limit parameters
    const readFileTool = agentTools.find((t) => t.function.name === "read_file");
    expect(readFileTool?.function.parameters.properties).toHaveProperty("offset");
    expect(readFileTool?.function.parameters.properties).toHaveProperty("limit");
  });

  test("executeTool handles tool execution and returns standardized JSON", async () => {
    const pkgPath = path.resolve(__dirname, "../../../package.json");
    const res = await executeTool("read_file", { path: pkgPath, limit: 5 });
    const parsed = JSON.parse(res);
    expect(parsed).toHaveProperty("stdout");
    expect(parsed).toHaveProperty("stderr");
    expect(parsed).toHaveProperty("exitCode");
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toContain("toolnetapi");
  });

  test("AgentRuntime detects infinite loops and aborts execution after 3 identical calls", async () => {
    const origFetch = global.fetch;
    let fetchCount = 0;

    global.fetch = (mock as any)(async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: `call_${fetchCount}`,
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({ path: "non_existent.txt" }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    });

    try {
      const runtime = new AgentRuntime({ maxTurns: 10, gatewayUrl: "http://127.0.0.1:9999" });
      const messages: any[] = [{ role: "user", content: "read file" }];
      const res = await runtime.runLoop(messages);

      expect(res.success).toBe(false);
      expect(res.error).toContain("Infinite loop detected");
      expect(fetchCount).toBe(3);
    } finally {
      global.fetch = origFetch;
    }
  });

  test("AgentRuntime successfully finishes loop and returns final textual response", async () => {
    const origFetch = global.fetch;
    let step = 0;

    global.fetch = (mock as any)(async () => {
      step++;
      if (step === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "read_file",
                        arguments: JSON.stringify({ path: "package.json", limit: 2 }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );
      } else {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "I have read package.json and it contains the package configuration.",
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
    });

    try {
      const runtime = new AgentRuntime({ maxTurns: 5, gatewayUrl: "http://127.0.0.1:9999" });
      const messages: any[] = [{ role: "user", content: "Check package.json" }];
      const res = await runtime.runLoop(messages);

      expect(res.success).toBe(true);
      expect(res.output).toContain("package.json");
      expect(res.toolCallsCount).toBe(1);
    } finally {
      global.fetch = origFetch;
    }
  });
});
