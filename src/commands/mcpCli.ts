/**
 * Phase 78.32/78.33 — `toolnet mcp ...` headless CLI.
 *
 * The core API comes first (Phase 78.32): this module only formats output and
 * sequences calls on the ONE `McpManager`. It never constructs a transport, an
 * OAuth provider, or a second registry, and it never prints a token or header
 * value.
 *
 * Manual-code fallback (Phase 78.12): `auth <name> --no-wait` prints the
 * authorization URL and exits, so a headless/VPS operator can complete the flow
 * on another machine; `auth <name> --code <code> --state <state>` finishes it.
 */

import { McpManager, mcpManager } from "../core/mcp/manager";
import { formatExtensionStatuses } from "../core/mcp/diagnostics";
import type { ExtensionStatus } from "../core/mcp/types";

export interface McpCliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: McpCliIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export const MCP_CLI_USAGE = `ToolNet MCP — remote and local MCP servers

USAGE:
  toolnet mcp list                       List configured servers and their status
  toolnet mcp status [name]              Show diagnostics (transport, tools, auth)
  toolnet mcp connect <name>             Connect a server and register its tools
  toolnet mcp disconnect <name>          Disconnect a server and withdraw its tools
  toolnet mcp auth <name>                Run the OAuth flow (opens a loopback callback)
  toolnet mcp auth <name> --no-wait      Print the authorization URL only (headless)
  toolnet mcp auth <name> --code <c> [--state <s>]
                                         Complete a flow started with --no-wait
  toolnet mcp logout <name>              Remove stored credentials (config is kept)

NOTES:
  · Remote servers use Streamable HTTP with an SSE fallback.
  · All MCP tools register into the same tool registry and permission engine.
  · Secrets are never printed.`;

export interface McpCliDeps {
  manager?: McpManager;
  io?: McpCliIO;
}

function parseFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

/** Run one `toolnet mcp ...` invocation. Returns a process exit code. */
export async function runMcpCli(args: string[], deps: McpCliDeps = {}): Promise<number> {
  const io = deps.io ?? defaultIo;
  const manager = deps.manager ?? mcpManager;

  const sub = (args[0] ?? "status").toLowerCase();
  const rest = args.slice(1);

  if (sub === "help" || args.includes("--help") || args.includes("-h")) {
    io.out(MCP_CLI_USAGE);
    return 0;
  }

  if (!["list", "status", "connect", "disconnect", "auth", "logout"].includes(sub)) {
    io.err(`Unknown MCP subcommand: ${sub}`);
    io.err(MCP_CLI_USAGE);
    return 1;
  }

  // Discovery first: the manager must know the server before it can act on it.
  try {
    await manager.sync();
  } catch (error) {
    io.err(`Failed to load MCP configuration: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const name = rest.find((arg) => !arg.startsWith("--") && arg !== "true");

  switch (sub) {
    case "list": {
      const servers = manager.listServers();
      if (servers.length === 0) {
        io.out("No MCP servers configured.");
        return 0;
      }
      for (const server of servers) {
        const kind = server.kind === "remote" ? "remote" : "stdio";
        const transport = server.transport ? ` transport=${server.transport}` : "";
        const auth = server.kind === "remote" ? ` auth=${server.authenticated ? "yes" : "no"}` : "";
        io.out(`${server.name}  [${kind}]${transport}  status=${server.status}  tools=${server.toolCount}${auth}`);
      }
      return 0;
    }

    case "status": {
      const all = manager.getDiagnostics();
      const statuses: ExtensionStatus[] = name
        ? all.filter((entry) => entry.id === name)
        : all;
      if (name && statuses.length === 0) {
        io.err(`No MCP server named '${name}'.`);
        return 1;
      }
      io.out(formatExtensionStatuses(statuses));
      return 0;
    }

    case "connect": {
      if (!name) {
        io.err("Usage: toolnet mcp connect <name>");
        return 1;
      }
      const status = await manager.connect(name);
      if (status === "not-installed") {
        io.err(`No MCP server named '${name}'.`);
        return 1;
      }
      const info = manager.listServers().find((server) => server.name === name);
      io.out(`${name}: ${status}${info ? ` (tools: ${info.toolCount})` : ""}`);
      if (info?.error) io.err(`  error: ${info.error}`);
      return status === "connected" ? 0 : 1;
    }

    case "disconnect": {
      if (!name) {
        io.err("Usage: toolnet mcp disconnect <name>");
        return 1;
      }
      const wasActive = await manager.disconnect(name);
      io.out(`${name}: disconnected (${wasActive ? "was active" : "was not connected"})`);
      return 0;
    }

    case "logout": {
      if (!name) {
        io.err("Usage: toolnet mcp logout <name>");
        return 1;
      }
      const removed = await manager.logout(name);
      io.out(`${name}: credentials ${removed ? "removed" : "were not stored"}; config is unchanged.`);
      return 0;
    }

    case "auth": {
      if (!name) {
        io.err("Usage: toolnet mcp auth <name> [--no-wait] [--code <c>] [--state <s>]");
        return 1;
      }
      const code = parseFlag(rest, "--code");
      const state = parseFlag(rest, "--state");

      if (code) {
        // Manual-code fallback: complete a flow started with --no-wait.
        const result = await manager.completeAuth(name, code, state);
        io.out(`${name}: ${result}`);
        return result === "connected" ? 0 : 1;
      }

      const noWait = rest.includes("--no-wait");
      const result = await manager.startAuth(name, { waitForCallback: !noWait });

      if (result.authorizationUrl) {
        io.out(`Open this URL to authorize ${name}:`);
        io.out(result.authorizationUrl);
      }
      if (result.reason) io.err(`  ${result.reason}`);

      if (noWait && result.status === "needs_auth") {
        io.out("");
        io.out("After authorizing, finish with:");
        io.out(`  toolnet mcp auth ${name} --code <code> --state <state>`);
        return 0;
      }

      io.out(`${name}: ${result.status}`);
      return result.status === "connected" ? 0 : 1;
    }

    default:
      io.err(MCP_CLI_USAGE);
      return 1;
  }
}
