import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { executeTurboTask } from "../turboExecutor";
import * as agentToolsMod from "../../lib/agentTools";

// Mock the global fetch
const originalFetch = global.fetch;

describe("turboExecutor", () => {
  beforeEach(() => {
    // We will replace global.fetch inside the tests
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should handle a multi-tool loop and generate a final textual response", async () => {
    // We will simulate 2 loops: 
    // Loop 1: Assistant calls a tool
    // Loop 2: Assistant provides final response
    
    // Mock the tool execution
    mock.module("../../lib/agentTools", () => ({
      ...agentToolsMod,
      executeTool: async () => "mock tool output",
    }));

    let fetchCount = 0;
    
    global.fetch = (mock as any)(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCount++;
      const reqBody = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const messages = reqBody.messages || [];

      if (fetchCount === 1) {
        // First completion returns a tool call
        return new Response(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_123",
                type: "function",
                function: { name: "run_command", arguments: "{}" }
              }]
            }
          }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      } else if (fetchCount === 2) {
        // Second completion returns a final textual response
        // Assert that the messages array includes the tool message
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.role).toBe("tool");
        expect(lastMsg.tool_call_id).toBe("call_123");
        expect(lastMsg.content).toBe("mock tool output");

        return new Response(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: "This is the final response after tool execution."
            }
          }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({}), { status: 500 });
    });

    const result = await executeTurboTask("Do something", { gatewayUrl: "http://mock" });
    
    expect(fetchCount).toBe(2);
    expect(result.success).toBe(true);
    expect(result.output).toBe("This is the final response after tool execution.");
    expect(result.toolCallsCount).toBe(1);
  });
});
