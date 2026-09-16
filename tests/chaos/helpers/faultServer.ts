/**
 * Deterministic provider fault injection for reliability tests.
 *
 * TEST-ONLY. This is a real local HTTP server that scripts upstream faults
 * (status sequences, truncation, stalling, quota bodies, connection resets) so
 * the production provider, retry policy and failure classifier all run their
 * real code paths. It is deliberately NOT wired into production: there is no
 * flag, environment variable or branch that lets a shipped build inject a fault.
 *
 * Every fault is explicit and deterministic — no randomized chaos is used as
 * acceptance evidence.
 */
import net from "node:net";
import { streamBody, type FakeTurn } from "../../../src/core/eval/__tests__/helpers/fakeOpenAiServer";

export interface FaultScript {
  /** Status to return per attempt (1-based). The last entry repeats forever. */
  statuses?: number[];
  /** Successful turn payloads, indexed by *successful* attempt number. */
  turns?: FakeTurn[];
  /** Omit the terminal finish reason and the `[DONE]` sentinel. */
  truncateStream?: boolean;
  /** Delay before the first byte of the response body. */
  stallMs?: number;
  /** Body returned with a failing status (quota wording, protocol errors, ...). */
  errorBody?: string;
  /** Extra response headers (e.g. `retry-after`). */
  headers?: Record<string, string>;
  /** Kill the socket instead of responding — a connection reset. */
  resetConnection?: boolean;
}

export interface FaultServer {
  url: string;
  attempts(): number;
  requests(): Array<{ index: number; stream: boolean; body: any }>;
  close(): void;
}

/**
 * A socket that accepts and immediately destroys the connection: the client
 * observes a genuine transport reset (ECONNRESET), not an HTTP status.
 */
export async function createResetServer(): Promise<FaultServer> {
  let attempts = 0;
  const server = net.createServer((socket) => {
    attempts++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/v1`,
    attempts: () => attempts,
    requests: () => [],
    close: () => server.close(),
  };
}

export function createFaultServer(script: FaultScript): FaultServer {
  const records: Array<{ index: number; stream: boolean; body: any }> = [];
  let attempts = 0;
  let successes = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "fault-model", object: "model", created: 0, owned_by: "fake" }] });
      }
      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }

      const body = await req.json().catch(() => ({}));
      records.push({ index: records.length, stream: body?.stream === true, body });



      const statuses = script.statuses ?? [200];
      const status = statuses[Math.min(attempts, statuses.length - 1)];
      attempts++;

      if (status !== 200) {
        return new Response(script.errorBody ?? JSON.stringify({ error: { message: "scripted failure" } }), {
          status,
          headers: { "content-type": "application/json", ...(script.headers ?? {}) },
        });
      }

      const turn = (script.turns ?? [{}])[Math.min(successes, (script.turns ?? [{}]).length - 1)];
      successes++;

      if (script.stallMs) await new Promise((resolve) => setTimeout(resolve, script.stallMs));

      if (body?.stream === true) {
        let payload = streamBody(turn, body?.model ?? "fault-model");
        if (script.truncateStream) {
          // Drop the finish frame and the [DONE] sentinel: the socket closes
          // after content, which is exactly the silent-EOF defect.
          payload = payload.split("data: ").slice(0, -2).join("data: ");
        }
        return new Response(payload, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...(script.headers ?? {}) },
        });
      }

      return Response.json({
        id: "chatcmpl-fault",
        object: "chat.completion",
        created: 0,
        model: body?.model ?? "fault-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: turn.content ?? "ok" },
            finish_reason: turn.finishReason ?? "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port ?? 0}/v1`,
    attempts: () => attempts,
    requests: () => records,
    close: () => server.stop(true),
  };
}
