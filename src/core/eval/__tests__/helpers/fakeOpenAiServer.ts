/**
 * Phase 80 — fake OpenAI-compatible HTTP server for eval integration tests.
 *
 * It is a REAL local HTTP server: the eval runner, AgentHarness, ModelRouter,
 * ProviderRegistry and ModelAdapter all take their production code paths. Only
 * the upstream model is scripted, so the test proves the runtime, not a mock.
 */

export interface FakeTurn {
  content?: string;
  toolCalls?: Array<{ id?: string; name: string; arguments: unknown }>;
  finishReason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  /** Artificial latency — used by the cancellation case. */
  delayMs?: number;
}

export interface FakeRequestRecord {
  index: number;
  body: any;
  stream: boolean;
}

export interface FakeOpenAiServer {
  url: string;
  port: number;
  requests: FakeRequestRecord[];
  callCount(): number;
  lastBody(): any;
  close(): void;
}

export interface FakeOpenAiServerOptions {
  /** Model ids served from GET /v1/models. */
  models?: string[];
  /** Produce the response for the Nth chat request (0-based). */
  script: (turnIndex: number, body: any) => FakeTurn | Promise<FakeTurn>;
  /** Fail every request with this HTTP status (error-path tests). */
  failWithStatus?: number;
}

function toOpenAiMessage(turn: FakeTurn) {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: turn.content ?? (turn.toolCalls && turn.toolCalls.length > 0 ? null : ""),
  };
  if (turn.toolCalls && turn.toolCalls.length > 0) {
    message.tool_calls = turn.toolCalls.map((call, index) => ({
      id: call.id ?? `call_${index}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    }));
  }
  return message;
}

function completionPayload(turn: FakeTurn, model: string) {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: toOpenAiMessage(turn),
        finish_reason: turn.finishReason ?? (turn.toolCalls?.length ? "tool_calls" : "stop"),
      },
    ],
    usage: {
      prompt_tokens: turn.usage?.prompt_tokens ?? 11,
      completion_tokens: turn.usage?.completion_tokens ?? 7,
      total_tokens: turn.usage?.total_tokens ?? 18,
    },
  };
}

/** Build the SSE body for a streamed turn. */
export function streamBody(turn: FakeTurn, model: string): string {
  const chunks: string[] = [];
  const message = toOpenAiMessage(turn);
  const content = typeof message.content === "string" ? message.content : "";

  const frame = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

  chunks.push(frame({ role: "assistant", content: "" }, null));
  if (content) chunks.push(frame({ content }, null));
  for (const [index, call] of (turn.toolCalls ?? []).entries()) {
    chunks.push(
      frame(
        {
          tool_calls: [
            {
              index,
              id: call.id ?? `call_${index}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
            },
          ],
        },
        null,
      ),
    );
  }
  chunks.push(frame({}, turn.finishReason ?? (turn.toolCalls?.length ? "tool_calls" : "stop")));
  chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}

export function createFakeOpenAiServer(options: FakeOpenAiServerOptions): FakeOpenAiServer {
  const requests: FakeRequestRecord[] = [];
  const models = options.models ?? ["eval-model"];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname.endsWith("/models")) {
        return Response.json({
          object: "list",
          data: models.map((id) => ({ id, object: "model", created: 0, owned_by: "fake" })),
        });
      }

      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }

      if (options.failWithStatus) {
        return new Response(JSON.stringify({ error: { message: "scripted failure" } }), {
          status: options.failWithStatus,
          headers: { "content-type": "application/json" },
        });
      }

      const body = await req.json().catch(() => ({}));
      const index = requests.length;
      requests.push({ index, body, stream: body?.stream === true });

      const turn = await options.script(index, body);
      if (turn.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, turn.delayMs));
      }

      const model = body?.model ?? models[0];

      if (body?.stream === true) {
        return new Response(streamBody(turn, model), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }

      return Response.json(completionPayload(turn, model));
    },
  });

  return {
    url: `http://127.0.0.1:${server.port ?? 0}/v1`,
    port: server.port ?? 0,
    requests,
    callCount: () => requests.length,
    lastBody: () => requests[requests.length - 1]?.body,
    close: () => server.stop(true),
  };
}

/**
 * Scripted model behaviours shared by the eval tests.
 */
export const scripts = {
  /** Edits a file on turn 0, then reports completion. */
  writeFile(path: string, content: string, summary = "Done.") {
    return (turnIndex: number): FakeTurn =>
      turnIndex === 0
        ? { toolCalls: [{ id: "call_write", name: "write_file", arguments: { path, content } }] }
        : { content: summary };
  },
  /** Reads a file on turn 0, then answers with the codeword. */
  readFileAndAnswer(path: string, answer: string) {
    return (turnIndex: number): FakeTurn =>
      turnIndex === 0
        ? { toolCalls: [{ id: "call_read", name: "read_file", arguments: { path } }] }
        : { content: answer };
  },
  /** Runs a shell command on turn 0, then reports. */
  runShell(command: string) {
    return (turnIndex: number): FakeTurn =>
      turnIndex === 0
        ? { toolCalls: [{ id: "call_shell", name: "bash", arguments: { command } }] }
        : { content: "Ran it." };
  },
  /** Narrates a change without calling any tool — the §13 failure mode. */
  narrateOnly(text = "I fixed the file. The bug is resolved.") {
    return (): FakeTurn => ({ content: text });
  },
  /** Always returns plain text. */
  alwaysText(text: string) {
    return (): FakeTurn => ({ content: text });
  },
  /** Responds slowly so a cancellation can interrupt it. */
  slowText(text: string, delayMs: number) {
    return (): FakeTurn => ({ content: text, delayMs });
  },
};
