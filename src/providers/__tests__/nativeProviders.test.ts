import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AnthropicProvider, normalizeAnthropicBaseUrl } from "../anthropic";
import { GeminiProvider, normalizeGeminiBaseUrl } from "../gemini";
import { createProviderInstance } from "../registry";

describe("Native Anthropic Provider", () => {
  it("normalizes Anthropic base URLs correctly", () => {
    expect(normalizeAnthropicBaseUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com/v1");
    expect(normalizeAnthropicBaseUrl("https://api.anthropic.com/")).toBe("https://api.anthropic.com/v1");
    expect(normalizeAnthropicBaseUrl("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com/v1");
    expect(normalizeAnthropicBaseUrl()).toBe("https://api.anthropic.com/v1");
  });

  it("creates Anthropic provider instance via factory", () => {
    const p = createProviderInstance({
      id: "anthropic",
      name: "Anthropic Claude",
      baseUrl: "https://api.anthropic.com",
    });
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.id).toBe("anthropic");
  });

  it("lists fallback default models without crash", async () => {
    const p = new AnthropicProvider({
      id: "anthropic",
      name: "Anthropic",
      baseUrl: "http://localhost:9999", // unreachable
    });
    const models = await p.listModels();
    expect(models).toBeArray();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some(m => m.id.includes("claude-3-5-sonnet"))).toBe(true);
  });

  it("translates OpenAI tools to Anthropic format and parses response", async () => {
    let capturedBody: any = null;
    let capturedHeaders: any = null;

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        capturedHeaders = {
          "x-api-key": req.headers.get("x-api-key"),
          "anthropic-version": req.headers.get("anthropic-version"),
        };
        return req.json().then(body => {
          capturedBody = body;
          return Response.json({
            id: "msg_test123",
            type: "message",
            role: "assistant",
            content: [
              { type: "text", text: "I will use bash" },
              { type: "tool_use", id: "toolu_01", name: "bash", input: { command: "ls" } },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 15, output_tokens: 25 },
          });
        });
      },
    });

    try {
      const p = new AnthropicProvider({
        id: "anthropic",
        name: "Anthropic",
        baseUrl: `http://localhost:${server.port}`,
        apiKey: "sk-ant-testkey",
      });

      const res = await p.chat({
        model: "claude-3-5-sonnet-20241022",
        messages: [
          { role: "system", content: "You are a helpful coding assistant." },
          { role: "user", content: "List files" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              description: "Execute bash command",
              parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
            },
          },
        ],
      });

      expect(capturedHeaders["x-api-key"]).toBe("sk-ant-testkey");
      expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01");
      expect(capturedBody.system).toBe("You are a helpful coding assistant.");
      expect(capturedBody.tools).toBeArray();
      expect(capturedBody.tools[0].name).toBe("bash");

      expect(res.choices[0].message.content).toBe("I will use bash");
      expect(res.choices[0].message.tool_calls).toBeArray();
      expect(res.choices[0].message.tool_calls![0].function.name).toBe("bash");
      expect(res.choices[0].message.tool_calls![0].function.arguments).toBe(JSON.stringify({ command: "ls" }));
      expect(res.usage?.total_tokens).toBe(40);
    } finally {
      server.stop(true);
    }
  });

  it("handles Anthropic streaming SSE events", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`));
            controller.enqueue(new TextEncoder().encode(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Xin chào"}}\n\n`));
            controller.enqueue(new TextEncoder().encode(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" Việt Nam"}}\n\n`));
            controller.enqueue(new TextEncoder().encode(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n`));
            controller.enqueue(new TextEncoder().encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      },
    });

    try {
      const p = new AnthropicProvider({
        id: "anthropic",
        name: "Anthropic",
        baseUrl: `http://localhost:${server.port}`,
        apiKey: "sk-ant-testkey",
      });

      const chunks: string[] = [];
      for await (const chunk of p.stream({
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: "Hi" }],
      })) {
        if (chunk.choices[0]?.delta?.content) {
          chunks.push(chunk.choices[0].delta.content);
        }
      }

      expect(chunks.join("")).toBe("Xin chào Việt Nam");
    } finally {
      server.stop(true);
    }
  });
});

describe("Native Gemini Provider", () => {
  it("normalizes Gemini base URLs correctly", () => {
    expect(normalizeGeminiBaseUrl("https://generativelanguage.googleapis.com")).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(normalizeGeminiBaseUrl("https://generativelanguage.googleapis.com/")).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(normalizeGeminiBaseUrl("https://generativelanguage.googleapis.com/v1beta")).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(normalizeGeminiBaseUrl()).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("creates Gemini provider instance via factory", () => {
    const p = createProviderInstance({
      id: "gemini",
      name: "Google Gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
    });
    expect(p).toBeInstanceOf(GeminiProvider);
    expect(p.id).toBe("gemini");
  });

  it("translates OpenAI request to Gemini contents and parses function call", async () => {
    let capturedBody: any = null;

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return req.json().then(body => {
          capturedBody = body;
          return Response.json({
            candidates: [
              {
                content: {
                  parts: [
                    { text: "Executing command" },
                    { functionCall: { name: "read_file", args: { path: "package.json" } } },
                  ],
                  role: "model",
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 30, totalTokenCount: 80 },
          });
        });
      },
    });

    try {
      const p = new GeminiProvider({
        id: "gemini",
        name: "Gemini",
        baseUrl: `http://localhost:${server.port}`,
        apiKey: "AIzaSyTestKey123",
      });

      const res = await p.chat({
        model: "gemini-2.0-flash",
        messages: [
          { role: "system", content: "You are Gemini" },
          { role: "user", content: "Read package.json" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read file content",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          },
        ],
      });

      expect(capturedBody.systemInstruction).toBeDefined();
      expect(capturedBody.contents).toBeArray();
      expect(capturedBody.tools).toBeArray();
      expect(capturedBody.tools[0].functionDeclarations[0].name).toBe("read_file");

      expect(res.choices[0].message.content).toBe("Executing command");
      expect(res.choices[0].message.tool_calls).toBeArray();
      expect(res.choices[0].message.tool_calls![0].function.name).toBe("read_file");
      expect(res.usage?.total_tokens).toBe(80);
    } finally {
      server.stop(true);
    }
  });

  it("handles Gemini SSE streaming chunks", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: {"candidates":[{"content":{"parts":[{"text":"Hello from "}],"role":"model"}}]}\n\n`));
            controller.enqueue(new TextEncoder().encode(`data: {"candidates":[{"content":{"parts":[{"text":"Gemini 2.0!"}],"role":"model"}}]}\n\n`));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      },
    });

    try {
      const p = new GeminiProvider({
        id: "gemini",
        name: "Gemini",
        baseUrl: `http://localhost:${server.port}`,
        apiKey: "AIzaSyTestKey123",
      });

      const parts: string[] = [];
      for await (const chunk of p.stream({
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "Hi" }],
      })) {
        if (chunk.choices[0]?.delta?.content) {
          parts.push(chunk.choices[0].delta.content);
        }
      }

      expect(parts.join("")).toBe("Hello from Gemini 2.0!");
    } finally {
      server.stop(true);
    }
  });
});
