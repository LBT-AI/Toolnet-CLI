import { expect, test, describe, mock } from "bun:test";
import { AgentRuntime } from "../../lib/agentRuntime";

describe("Context Truncation", () => {
  test("should truncate context when messages exceed the maximum character limit", async () => {
    const origFetch = globalThis.fetch;
    try {
      // Setup fetch mock
      globalThis.fetch = (mock as any)().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "Final answer" } }],
        }),
      } as any);

      const runtime = new AgentRuntime({ gatewayUrl: "http://localhost:3000" });
      // The trigger is the model's own usable capacity (window minus its output
      // allowance), not a global character limit — so the transcript has to be
      // genuinely oversized for the model in play, not merely long.
      const longString = "A".repeat(60000);
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
      // Compaction may issue a summarizer call first (a single user message,
      // tools disabled); the turn's own request is the one that starts with the
      // primary system message.
      const bodies = fetchMock.mock.calls.map((call: any) => JSON.parse(call[1].body));
      const body = bodies.find((payload: any) => payload.messages?.[0]?.role === "system");
      expect(body).toBeDefined();

      expect(body.messages.length).toBeLessThan(6);
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[body.messages.length - 1].content).toBe("Short query");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
