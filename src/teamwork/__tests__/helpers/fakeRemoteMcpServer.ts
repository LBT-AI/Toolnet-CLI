/**
 * Phase 78.20/78.21/78.22 — Real local HTTP MCP fixture.
 *
 * This is a genuine MCP server speaking JSON-RPC 2.0 over real HTTP, bound to
 * 127.0.0.1. Nothing about the client transport (StreamableHTTP or SSE) is
 * simulated: the SDK client under test performs a real `initialize`, real
 * `tools/list` and real `tools/call` against this process.
 *
 * Modes:
 *   "streamable"  — POST /mcp answers application/json (with a session id)
 *   "sse-only"    — POST /mcp with a JSON-RPC body and an
 *                   `Accept: application/json, text/event-stream` header is
 *                   REJECTED (405). The SSE GET stream + POST message endpoint
 *                   are served instead, which is exactly the "protocol
 *                   incompatibility" case the client must fall back from.
 *
 * OAuth variant (`oauth: true`) adds RFC 9728 protected-resource metadata,
 * RFC 8414 authorization-server metadata, RFC 7591 dynamic registration, an
 * authorization endpoint and a token endpoint, and answers 401 + a
 * `WWW-Authenticate` challenge until a valid bearer token arrives.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

export interface FixtureTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface RemoteFixtureOptions {
  /** "streamable" (default) serves Streamable HTTP; "sse-only" forces fallback. */
  mode?: "streamable" | "sse-only";
  name?: string;
  tools?: FixtureTool[];
  /** Answer 401 until a valid bearer token is presented. */
  requireAuth?: boolean;
  /** Enable the OAuth endpoints. */
  oauth?: boolean;
  /** Emit a registration endpoint (default true when `oauth`). */
  withRegistration?: boolean;
  /** Access token value the protected server accepts. */
  accessToken?: string;
}

export interface RemoteFixture {
  baseUrl: string;
  mcpUrl: string;
  /** Requests that arrived with a Streamable HTTP POST Accept header. */
  streamableRequests: number;
  /** Requests that arrived on the SSE stream/message endpoint. */
  sseRequests: number;
  tokenRequests: number;
  registerRequests: number;
  authorizeRequests: number;
  /** Tool name per successful tools/call, in order. */
  toolCalls: string[];
  /** Authorization header values observed (for URL-isolation assertions). */
  observedAuthorizations: string[];
  setTools(tools: FixtureTool[]): void;
  /** Emit `notifications/tools/list_changed` on open connections. */
  notifyToolsChanged(): void;
  /** Kill every open connection and stop accepting — simulates server death. */
  simulateServerDeath(): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_ACCESS_TOKEN = "fixture-access-token";

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

export async function startRemoteMcpFixture(options: RemoteFixtureOptions = {}): Promise<RemoteFixture> {
  const mode = options.mode ?? "streamable";
  const serverName = options.name ?? "remote-fixture";
  const requireAuth = options.requireAuth ?? false;
  const accessToken = options.accessToken ?? DEFAULT_ACCESS_TOKEN;
  let tools: FixtureTool[] = options.tools ?? [
    {
      // A read-named tool: the permission engine's read-only rule lets it run.
      name: "read_echo",
      description: "Echo text back unchanged (read-only).",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      annotations: { readOnlyHint: true },
    },
    {
      // No read verb in the name: the workspace policy must block it even
      // though it is harmless, and even though it is only a remote tool.
      name: "echo",
      description: "Echo text back unchanged.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      annotations: { readOnlyHint: true },
    },
    {
      name: "dangerous_write",
      description: "Write a file (permission tests assert this never runs).",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  ];

  const fixture: RemoteFixture = {
    baseUrl: "",
    mcpUrl: "",
    streamableRequests: 0,
    sseRequests: 0,
    tokenRequests: 0,
    registerRequests: 0,
    authorizeRequests: 0,
    toolCalls: [],
    observedAuthorizations: [],
    setTools(next) {
      tools = next;
    },
    notifyToolsChanged() {
      const payload = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
      for (const stream of sseStreams) writeSse(stream, "message", payload);
    },
    async simulateServerDeath() {
      dead = true;
      for (const stream of [...sseStreams]) {
        try {
          stream.end();
        } catch {
          /* ignore */
        }
      }
      sseStreams.clear();
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    async close() {
      await fixture.simulateServerDeath();
    },
  };

  const sockets = new Set<import("node:net").Socket>();
  const sseStreams = new Set<http.ServerResponse>();
  let dead = false;
  let sessionId: string | undefined;

  function writeSse(res: http.ServerResponse, event: string, data: unknown): void {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* the stream is gone */
    }
  }

  function jsonRpcResult(id: unknown, result: unknown): Record<string, unknown> {
    return { jsonrpc: "2.0", id, result };
  }

  function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  function handleRequest(
    method: string | undefined,
    params: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    switch (method) {
      case "initialize":
        return jsonRpcResult(params?.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: serverName, version: "1.0.0" },
        });
      case "ping":
        return jsonRpcResult(params?.id, {});
      case "tools/list":
        return jsonRpcResult(params?.id, { tools });
      case "tools/call": {
        const toolName = String(params?.name ?? "");
        fixture.toolCalls.push(toolName);
        const args = (params?.arguments as Record<string, unknown>) ?? {};
        if (toolName === "echo" || toolName === "read_echo") {
          return jsonRpcResult(params?.id, {
            content: [{ type: "text", text: String(args.text ?? "") }],
          });
        }
        if (toolName === "dangerous_write") {
          return jsonRpcResult(params?.id, {
            content: [{ type: "text", text: `wrote ${String(args.path ?? "")}` }],
          });
        }
        if (toolName === "secret_leak") {
          return jsonRpcResult(params?.id, {
            content: [{ type: "text", text: "SUPER_SECRET_MCP_123" }],
          });
        }
        if (toolName === "b") {
          return jsonRpcResult(params?.id, { content: [{ type: "text", text: "tool-b" }] });
        }
        return jsonRpcResult(params?.id, {
          content: [{ type: "text", text: `unknown tool: ${toolName}` }],
          isError: true,
        });
      }
      case "notifications/initialized":
        return undefined;
      default:
        return jsonRpcError(params?.id, -32601, `method not found: ${String(method)}`);
    }
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;

      if (dead) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "server is down" }));
        return;
      }

      // ── OAuth endpoints ───────────────────────────────────────────────────
      // RFC 9728 puts the well-known segment before the resource path for
      // resources that have one, so match the prefix either way.
      if (options.oauth && path.startsWith("/.well-known/oauth-protected-resource")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ resource: fixture.mcpUrl, authorization_servers: [fixture.baseUrl] }));
        return;
      }

      if (options.oauth && path.startsWith("/.well-known/oauth-authorization-server")) {
        const metadata: Record<string, unknown> = {
          issuer: fixture.baseUrl,
          authorization_endpoint: `${fixture.baseUrl}/authorize`,
          token_endpoint: `${fixture.baseUrl}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        };
        if (options.withRegistration !== false) metadata.registration_endpoint = `${fixture.baseUrl}/register`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(metadata));
        return;
      }

      if (options.oauth && path === "/register" && req.method === "POST") {
        fixture.registerRequests++;
        // RFC 7591: the response is the registered client metadata, so it must
        // echo the redirect URIs the client asked for.
        const request = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            client_id: "fixture-client",
            redirect_uris: Array.isArray(request.redirect_uris) ? request.redirect_uris : [],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
        );
        return;
      }

      if (options.oauth && path === "/authorize") {
        fixture.authorizeRequests++;
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const target = new URL(redirectUri);
        target.searchParams.set("code", "fixture-code");
        if (state) target.searchParams.set("state", state);
        res.writeHead(302, { location: target.toString() });
        res.end();
        return;
      }

      if (options.oauth && path === "/token" && req.method === "POST") {
        fixture.tokenRequests++;
        const body = new URLSearchParams(await readBody(req));
        const grant = body.get("grant_type");
        // PKCE: the code exchange must carry the verifier it committed to.
        if (grant === "authorization_code" && !body.get("code_verifier")) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_request", error_description: "code_verifier is required" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "fixture-refresh-token",
            scope: "mcp",
          }),
        );
        return;
      }

      // ── Auth gate ─────────────────────────────────────────────────────────
      const authorization = req.headers["authorization"];
      if (typeof authorization === "string") fixture.observedAuthorizations.push(authorization);
      if (requireAuth || options.oauth) {
        if (authorization !== `Bearer ${accessToken}`) {
          res.writeHead(401, {
            "content-type": "application/json",
            "www-authenticate": `Bearer resource_metadata="${fixture.baseUrl}/.well-known/oauth-protected-resource"`,
          });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
      }

      // ── SSE GET stream ────────────────────────────────────────────────────
      if (req.method === "GET" && (req.headers.accept ?? "").includes("text/event-stream")) {
        fixture.sseRequests++;
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        sseStreams.add(res);
        writeSse(res, "endpoint", "/mcp");
        req.on("close", () => sseStreams.delete(res));
        return;
      }

      // ── POST ──────────────────────────────────────────────────────────────
      if (req.method === "POST") {
        const accept = req.headers.accept ?? "";
        const wantsJson = accept.includes("application/json");

        if (mode === "sse-only" && wantsJson) {
          // Streamable HTTP is deliberately unsupported. The client must close
          // this transport and fall back to SSE.
          fixture.streamableRequests++;
          res.writeHead(405, { "content-type": "application/json", allow: "GET" });
          res.end(JSON.stringify({ error: "streamable http is not supported" }));
          return;
        }

        const raw = await readBody(req);
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad json" }));
          return;
        }

        const method = typeof message.method === "string" ? message.method : undefined;
        const params = { ...(message.params as Record<string, unknown> | undefined), id: message.id };
        const response = handleRequest(method, params);

        if (mode === "sse-only") {
          // SSE message endpoint: answer over the open stream, ack with 202.
          fixture.sseRequests++;
          if (response) for (const stream of sseStreams) writeSse(stream, "message", response);
          res.writeHead(202, { "content-type": "text/plain" });
          res.end();
          return;
        }

        fixture.streamableRequests++;
        if (method === "initialize") sessionId = randomUUID();
        const headers: Record<string, string> = {};
        if (sessionId) headers["mcp-session-id"] = sessionId;
        if (!response) {
          res.writeHead(202, headers);
          res.end();
          return;
        }
        res.writeHead(200, { ...headers, "content-type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }

      if (req.method === "DELETE") {
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    })().catch(() => {
      try {
        res.writeHead(500);
        res.end();
      } catch {
        /* already responded */
      }
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  fixture.baseUrl = `http://127.0.0.1:${address.port}`;
  fixture.mcpUrl = `${fixture.baseUrl}/mcp`;

  return fixture;
}

export const FIXTURE_ACCESS_TOKEN = DEFAULT_ACCESS_TOKEN;
