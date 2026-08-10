import { expect, test, describe, mock } from "bun:test";
import { AgentRuntime } from "../../lib/agentRuntime";

describe("Context Truncation", () => {
  test("should truncate context when messages exceed the maximum character limit", async () => {
    // Setup fetch mock
    globalThis.fetch = (mock as any)().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "Final answer" } }],
      }),
    } as any);

    const runtime = new AgentRuntime({ gatewayUrl: "http://localhost:3000" });
    const longString = "A".repeat(10000);
    const messages = [
      { role: "system", content: "System Prompt" },
      { role: "user", content: longString },
      { role: "assistant", content: longString },
      { role: "user", content: longString },
      { role: "assistant", content: longString },
      { role: "user", content: "Short query" },
    ];

    const result = await runtime.runLoop(messages as any);
    expect(result.success).toBe(true);

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    const fetchCallArg = fetchMock.mock.calls[0][1].body;
    const body = JSON.parse(fetchCallArg);
    
    expect(body.messages.length).toBeLessThan(6);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[body.messages.length - 1].content).toBe("Short query");
  });
});
