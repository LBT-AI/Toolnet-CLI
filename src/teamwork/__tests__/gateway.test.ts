import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

const originalFetch = globalThis.fetch;

const testDataDir =
  `/tmp/toolnet-cli-gateway-test-${process.pid}-${Date.now()}`;

process.env.DATA_DIR = testDataDir;

const { GatewayClient } = await import("../../lib/gateway");

describe("GatewayClient", () => {
  beforeAll(() => {
    process.env.DATA_DIR = testDataDir;
  });

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  test("normalizes trailing slash from base URL", () => {
    const client = new GatewayClient("https://api.example.com///");

    expect(client.getBaseUrl()).toBe("https://api.example.com");
  });

  test("setBaseUrl normalizes trailing slash", () => {
    const client = new GatewayClient("https://gateway.example.com/");

    client.setBaseUrl("https://gateway.example.com/");

    expect(client.getBaseUrl()).toBe(
      "https://gateway.example.com"
    );
  });

  test("health performs GET /api/health", async () => {
    let requestedUrl = "";
    let requestedMethod = "";

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      requestedUrl = String(input);
      requestedMethod = init?.method || "GET";

      return new Response(
        JSON.stringify({ ok: true }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }) as unknown as typeof fetch;

    const client = new GatewayClient(
      "https://api.example.com"
    );

    const result = await client.health();

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.data).toEqual({ ok: true });

    expect(requestedUrl).toBe(
      "https://api.example.com/api/health"
    );

    expect(requestedMethod).toBe("GET");
  });

  test("returns API error message on HTTP error", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          error: "Unauthorized"
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }) as unknown as typeof fetch;

    const client = new GatewayClient(
      "https://api.example.com"
    );

    const result = await client.getProviders();

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.error).toBe("Unauthorized");
  });

  test("handles plain-text successful responses", async () => {
    globalThis.fetch = (async () => {
      return new Response("OK", {
        status: 200
      });
    }) as unknown as typeof fetch;

    const client = new GatewayClient(
      "https://api.example.com"
    );

    const result = await client.health();

    expect(result.success).toBe(true);
    expect(result.data).toBe("OK" as any);
  });

  test("handles network failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const client = new GatewayClient(
      "http://127.0.0.1:65530"
    );

    const result = await client.health();

    expect(result.success).toBe(false);
    expect(result.error).toContain("Network error:");
    expect(result.error).toContain(
      "connection refused"
    );
  });

  test("checkConnection returns false when gateway fails", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const client = new GatewayClient(
      "http://127.0.0.1:65530"
    );

    expect(await client.checkConnection()).toBe(false);
  });
});
