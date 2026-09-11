#!/usr/bin/env bun
/**
 * Phase 77.27 — Real stdio MCP fixture server.
 *
 * This is a genuine MCP server process speaking JSON-RPC 2.0 over
 * newline-delimited stdio (the same shape `src/mock-mcp.ts` uses). It is NOT a
 * mock of the manager: the client under test performs a real spawn, real
 * `initialize` handshake, real `tools/list` and real `tools/call`.
 *
 * Tools:
 *   echo(text)                  → returns the text unchanged
 *   read_fixture(name)          → reads a file inside $MCP_FIXTURE_ROOT
 *   fail_tool                   → returns an MCP error result
 *   slow_tool(delayMs)          → sleeps, used to prove cancellation/timeout
 *   dangerous_write(path,body)  → would write a file; a permission test asserts
 *                                 this never runs
 *
 * `$MCP_CALL_LOG` (optional) receives one line per tool call so a test can
 * prove that a denied call never reached the server.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const fixtureRoot = process.env.MCP_FIXTURE_ROOT || process.cwd();
const callLog = process.env.MCP_CALL_LOG;

function recordCall(toolName: string): void {
  if (!callLog) return;
  try {
    fs.appendFileSync(callLog, `${toolName}\n`, "utf8");
  } catch {
    // Logging must never break the server.
  }
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const TOOLS = [
  {
    name: "echo",
    description: "Echo text back unchanged.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo" } },
      required: ["text"],
    },
  },
  {
    name: "read_fixture",
    description: "Read a fixture file (read-only).",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "fail_tool",
    description: "Always fails, used to verify error normalization.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "slow_tool",
    description: "Sleep then answer, used to verify cancellation.",
    inputSchema: {
      type: "object",
      properties: { delayMs: { type: "number" } },
      required: [],
    },
  },
  {
    name: "dangerous_write",
    description: "Write a file (mutating; permission tests rely on this never running).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  switch (name) {
    case "echo":
      return { text: String(args.text ?? ""), isError: false };

    case "read_fixture": {
      const requested = String(args.name ?? "");
      // Path containment: a fixture server must not read outside its root.
      const resolved = path.resolve(fixtureRoot, requested);
      if (!resolved.startsWith(path.resolve(fixtureRoot))) {
        return { text: "refused: path escapes fixture root", isError: true };
      }
      if (!fs.existsSync(resolved)) return { text: `missing fixture: ${requested}`, isError: true };
      return { text: fs.readFileSync(resolved, "utf8"), isError: false };
    }

    case "fail_tool":
      return { text: "fixture failure", isError: true };

    case "slow_tool": {
      const delayMs = Number(args.delayMs ?? 200);
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(delayMs) ? delayMs : 200));
      return { text: `slept ${delayMs}ms`, isError: false };
    }

    case "dangerous_write": {
      const target = String(args.path ?? "");
      fs.writeFileSync(target, String(args.content ?? ""), "utf8");
      return { text: `wrote ${target}`, isError: false };
    }

    default:
      return { text: `unknown tool: ${name}`, isError: true };
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request: Record<string, unknown>;
  try {
    request = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }

  const { id, method, params } = request as { id?: unknown; method?: string; params?: Record<string, unknown> };

  // Notifications carry no id and expect no response.
  if (id === undefined || id === null) return;

  switch (method) {
    case "initialize":
      sendResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "phase77-fixture", version: "1.0.0" },
      });
      return;

    case "ping":
      sendResult(id, {});
      return;

    case "tools/list":
      sendResult(id, { tools: TOOLS });
      return;

    case "tools/call": {
      const toolName = String(params?.name ?? "");
      recordCall(toolName);
      callTool(toolName, (params?.arguments as Record<string, unknown>) ?? {})
        .then((outcome) => {
          if (outcome.isError) {
            sendResult(id, { content: [{ type: "text", text: outcome.text }], isError: true });
            return;
          }
          sendResult(id, { content: [{ type: "text", text: outcome.text }] });
        })
        .catch((error: unknown) => {
          sendError(id, -32603, error instanceof Error ? error.message : String(error));
        });
      return;
    }

    default:
      sendError(id, -32601, `method not found: ${String(method)}`);
  }
});

rl.on("close", () => process.exit(0));
