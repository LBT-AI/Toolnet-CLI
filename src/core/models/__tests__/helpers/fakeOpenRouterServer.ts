/**
 * A real local HTTP server that speaks OpenRouter's `/models` shape, used to
 * prove discovery fetches and normalizes through the production adapter.
 */

export interface FakeOpenAiServer {
  url: string;
  callCount(): number;
  close(): void;
}

export interface FakeOpenAiServerOptions {
  models?: string[];
  failWithStatus?: number;
  /** Return OpenRouter-shaped records (supported_parameters, pricing, architecture). */
  openRouter?: boolean;
}

export function createFakeOpenAiServer(options: FakeOpenAiServerOptions = {}): FakeOpenAiServer {
  let calls = 0;
  const models = options.models ?? [];
  const openRouter = options.openRouter ?? false;

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      calls += 1;
      const url = new URL(req.url);

      if (options.failWithStatus) {
        return new Response(JSON.stringify({ error: { message: "scripted failure" } }), {
          status: options.failWithStatus,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.pathname.endsWith("/models")) {
        return Response.json({
          data: models.map((id) =>
            openRouter
              ? {
                  id,
                  name: `Fixture ${id}`,
                  context_length: 200_000,
                  supported_parameters: ["tools", "reasoning", "response_format"],
                  pricing: { prompt: "0.000003", completion: "0.000015" },
                  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
                  top_provider: { context_length: 200_000, max_completion_tokens: 8192 },
                }
              : { id, object: "model", created: 0, owned_by: "fixture" },
          ),
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port ?? 0}/v1`,
    callCount: () => calls,
    close: () => server.stop(true),
  };
}
