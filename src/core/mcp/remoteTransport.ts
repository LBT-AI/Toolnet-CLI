/**
 * Phase 78.3/78.5/78.6/78.18/78.19/78.37 — Remote MCP transports.
 *
 * This is the ONLY module that constructs remote MCP transports. It is not a
 * second runtime: it hands a connected `Client` back to the one `McpManager`,
 * which normalizes the tool list and registers into the one `ToolRegistry`.
 *
 * Transport order is fixed and exclusive:
 *
 *   1. Streamable HTTP  → on protocol/connect incompatibility, close it
 *   2. SSE              → only after (1) is closed; never both at once
 *
 * Auth and client-registration failures are TERMINAL for that server: they
 * describe the server itself, so falling back to a second transport would just
 * repeat the same 401. Those map to `needs_auth` / `needs_client_registration`
 * and stop. Any failed transport is closed before returning, so a failed
 * attempt is never leaked.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { redactRemoteError } from "./remoteConfig";
import type { McpTransportKind } from "./types";

/** Connect failures that describe the server, not the transport. */
export type RemoteFailureStatus = "needs_auth" | "needs_client_registration" | "failed";

export interface RemoteConnectOptions {
  name: string;
  serverId: string;
  url: string;
  /** Connect + initialize timeout. */
  timeoutMs: number;
  /** Already-merged, credential-safe headers (Phase 78.17). */
  headers: Record<string, string>;
  authProvider?: OAuthClientProvider;
  fetchFn: FetchLike;
  signal?: AbortSignal;
  /** Called when the server announces `notifications/tools/list_changed`. */
  onToolsChanged?: () => void;
  /** Called when the transport drops (Phase 78.6). */
  onClose?: () => void;
}

export interface RemoteConnection {
  kind: McpTransportKind;
  client: Client;
  transport: Transport;
  serverName: string;
  serverVersion: string;
}

export type RemoteConnectResult =
  | { ok: true; connection: RemoteConnection }
  | { ok: false; status: RemoteFailureStatus; error: string };

/** Map a transport error onto the canonical status machine. */
export function classifyRemoteFailure(error: unknown): { status: RemoteFailureStatus; error: string } {
  const message = redactRemoteError(error instanceof Error ? error.message : String(error));
  const code = (error as { code?: number })?.code;
  const name = (error as { name?: string })?.name ?? "";

  if (name === "UnauthorizedError" || code === 401 || /\b401\b|unauthoriz|invalid_token/i.test(message)) {
    return { status: "needs_auth", error: message || "server requires authentication" };
  }
  if (/client[_ -]?registration|invalid_client_metadata|registration_endpoint/i.test(message)) {
    return { status: "needs_client_registration", error: message };
  }
  return { status: "failed", error: message || "remote MCP connection failed" };
}

/** True when a failure means "try the other transport" is pointless. */
function isTerminal(status: RemoteFailureStatus): boolean {
  return status !== "failed";
}

async function closeQuietly(transport: Transport | undefined): Promise<void> {
  if (!transport) return;
  try {
    await transport.close();
  } catch {
    /* a failed transport is already gone — never let cleanup throw */
  }
}

/** Bounded `client.connect` with a typed timeout. */
async function connectWithTimeout(
  client: Client,
  transport: Transport,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`MCP_CONNECT_TIMEOUT: remote server did not initialize within ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    await Promise.race([client.connect(transport, { signal }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildClient(options: RemoteConnectOptions): Client {
  return new Client(
    { name: `toolnet-cli-${options.serverId}`, version: "1.0.0" },
    {
      capabilities: {},
      // Fires only when the server advertises tools.listChanged.
      listChanged: {
        tools: {
          onChanged: (error) => {
            if (error) return;
            options.onToolsChanged?.();
          },
        },
      },
    },
  );
}

/**
 * Connect one remote server, trying Streamable HTTP then SSE.
 * The returned connection's `kind` records which transport actually worked.
 */
export async function connectRemoteServer(options: RemoteConnectOptions): Promise<RemoteConnectResult> {
  const url = new URL(options.url);

  // ── 1. Streamable HTTP ────────────────────────────────────────────────────
  let streamable: StreamableHTTPClientTransport | undefined;
  try {
    streamable = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: options.headers },
      fetch: options.fetchFn,
      authProvider: options.authProvider,
      reconnectionOptions: {
        maxReconnectionDelay: 10_000,
        initialReconnectionDelay: 250,
        reconnectionDelayGrowFactor: 1.5,
        maxRetries: 1,
      },
    });
    const client = buildClient(options);
    await connectWithTimeout(client, streamable, options.timeoutMs, options.signal);
    return {
      ok: true,
      connection: {
        kind: "streamable-http",
        client,
        transport: streamable,
        serverName: client.getServerVersion()?.name ?? options.name,
        serverVersion: client.getServerVersion()?.version ?? "unknown",
      },
    };
  } catch (error) {
    const classified = classifyRemoteFailure(error);
    await closeQuietly(streamable);
    // A server that answered 401 will answer 401 over SSE too.
    if (isTerminal(classified.status)) return { ok: false, ...classified };
  }

  // ── 2. SSE fallback ──────────────────────────────────────────────────────
  let sse: SSEClientTransport | undefined;
  try {
    sse = new SSEClientTransport(url, {
      requestInit: { headers: options.headers },
      fetch: options.fetchFn,
      authProvider: options.authProvider,
    });
    const client = buildClient(options);
    await connectWithTimeout(client, sse, options.timeoutMs, options.signal);
    return {
      ok: true,
      connection: {
        kind: "sse",
        client,
        transport: sse,
        serverName: client.getServerVersion()?.name ?? options.name,
        serverVersion: client.getServerVersion()?.version ?? "unknown",
      },
    };
  } catch (error) {
    const classified = classifyRemoteFailure(error);
    await closeQuietly(sse);
    return { ok: false, ...classified };
  }
}

/** Tools as the manager's discovery loop expects them. */
export async function listRemoteTools(
  connection: RemoteConnection,
  timeoutMs: number,
): Promise<Array<{ name: string; description?: string; inputSchema?: unknown; annotations?: unknown }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`MCP_CALL_TIMEOUT: tools/list exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    const result = await Promise.race([connection.client.listTools(), timeout]);
    const tools = (result as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) return [];
    return tools
      .filter((tool): tool is Record<string, unknown> => Boolean(tool) && typeof tool === "object")
      .map((tool) => ({
        name: String((tool as { name?: unknown }).name ?? ""),
        description: typeof (tool as { description?: unknown }).description === "string"
          ? ((tool as { description: string }).description)
          : undefined,
        inputSchema: (tool as { inputSchema?: unknown }).inputSchema,
        annotations: (tool as { annotations?: unknown }).annotations,
      }))
      .filter((tool) => tool.name.length > 0);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
