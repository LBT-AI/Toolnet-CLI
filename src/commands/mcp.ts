import type { Command, CommandContext } from "./index";
import {
  loadLocalMcpConfig,
  addLocalMcpServer,
  removeLocalMcpServer,
  getLocalMcpServers,
  getEffectiveMcpServers,
  mcpTrustManager,
} from "../lib/mcpRunner";
import { isBuiltinSkillsMcp } from "../core/mcp/builtin";
import { mcpManager } from "../core/mcp/manager";
import { runMcpCli } from "./mcpCli";

/**
 * the TUI is a CONSUMER of the canonical MCP manager. These
 * subcommands delegate to the same headless CLI so the TUI never connects or
 * authenticates a transport itself.
 */
async function delegateToCli(subArgs: string[], ctx: CommandContext) {
  const lines: string[] = [];
  const code = await runMcpCli(subArgs, {
    io: {
      out: (line) => lines.push(line),
      err: (line) => lines.push(`\u001b[31m${line}\u001b[0m`),
    },
  });
  if (lines.length === 0) lines.push(code === 0 ? "Done." : "Command failed.");
  ctx.addMessage("assistant", lines.join("\n"));
}

async function showMcpStatus(ctx: CommandContext) {
  const { gateway, addMessage } = ctx;
  let plugins: any[] = [];
  let localPlugins: any[] = [];
  let customPlugins: any[] = [];
  let installed = false;
  let baseUrl: string | undefined;

  if (gateway) {
    addMessage("assistant", "Fetching MCP status...");
    const res = await gateway.getCoworkSettings();
    if (res.success && res.data) {
      const cowork = (res.data as any).cowork || {};
      plugins = cowork.plugins || [];
      localPlugins = cowork.localPlugins || [];
      customPlugins = cowork.customPlugins || [];
      installed = (res.data as any).installed;
      baseUrl = cowork.baseUrl;
    }
  }

  const localMcpConfig = loadLocalMcpConfig();
  const localMcpNames = Object.keys(localMcpConfig);
  const combinedLocal = Array.from(new Set([...localPlugins, ...localMcpNames]));

  // Discovered and built-in servers with trust and connection status
  const trustLines: string[] = [];
  for (const server of getEffectiveMcpServers()) {
    const trust = mcpTrustManager.getTrustState(
      server.serverId, server.config, server.sourceKind, server.config.disabled
    );
    const managedStatus = mcpManager.status(server.serverId);
    const toolCount = mcpManager.listTools(server.serverId).length;
    const isBuiltin = server.sourceKind === "BUILTIN" || isBuiltinSkillsMcp(server);
    const icon = trust === "disabled"
      ? "\u001b[90m○\u001b[0m"
      : managedStatus === "connected"
        ? "\u001b[32m●\u001b[0m"
        : "\u001b[33m●\u001b[0m";

    const builtinBadge = isBuiltin ? " [builtin]" : "";
    const statusLabel = trust === "disabled" ? "disabled" : managedStatus;
    const toolsDetail = managedStatus === "connected" ? ` · ${toolCount} tools` : "";
    const urlDetail = server.config.url ? `\n      url: ${server.config.url}` : "";

    trustLines.push(`    ${icon} ${server.name}${builtinBadge} [${statusLabel}]${toolsDetail}${urlDetail}`);
  }

  const lines: string[] = [];
  lines.push("MCP — Status");
  lines.push("───".repeat(10));

  if (gateway) {
    lines.push(`  Claude Desktop: ${installed ? "\u001b[32minstalled\u001b[0m" : "\u001b[33mnot detected\u001b[0m"}`);
    if (baseUrl) {
      lines.push(`  Base URL: ${baseUrl}`);
    }
  }

  if (plugins.length > 0) {
    lines.push("");
    lines.push(`  Plugins (${plugins.length}):`);
    for (const p of plugins) {
      const icon = (p as any).url?.includes("/api/mcp/") ? "\u001b[36m\u25B6\u001b[0m" : "\u001b[34m\u2601\u001b[0m";
      lines.push(`    ${icon} ${(p as any).name || "?"}`);
      if ((p as any).toolNames?.length) {
        lines.push(`           tools: ${(p as any).toolNames.join(", ")}`);
      }
    }
  }

  if (combinedLocal.length > 0) {
    lines.push("");
    lines.push(`  Local stdio plugins: ${combinedLocal.join(", ")}`);
  }

  if (trustLines.length > 0) {
    lines.push("");
    lines.push("  Configured & Built-in MCP servers:");
    lines.push(...trustLines);
  }

  if (customPlugins.length > 0) {
    lines.push("");
    lines.push(`  Custom plugins (${customPlugins.length}):`);
    for (const cp of customPlugins) {
      lines.push(`    ${(cp as any).name || "?"} — ${(cp as any).url || ""}`);
    }
  }

  lines.push("");
  lines.push("Commands:");
  lines.push("  /mcp list               List configured servers and status");
  lines.push("  /mcp show [name]        Diagnostics (transport, tools, auth)");
  lines.push("  /mcp connect <name>     Connect a server and register its tools");
  lines.push("  /mcp disconnect <name>  Disconnect and withdraw its tools");
  lines.push("  /mcp enable <name>      Trust + enable a server");
  lines.push("  /mcp disable <name>     Revoke trust / disable a server");
  lines.push("  /mcp add <name> <cmd>   Add a local MCP server");
  lines.push("  /mcp remove <name>      Remove or disable an MCP server");
  lines.push("  /mcp registry           Browse MCP registry");
  lines.push("  /mcp tools <url>        Probe MCP server tools");
  lines.push("  /mcp auth <name>        OAuth flow for a remote server");
  lines.push("  /mcp logout <name>      Remove stored credentials");

  addMessage("assistant", lines.join("\n"));
}

async function browseRegistry(ctx: CommandContext) {
  const { gateway, addMessage } = ctx;
  if (!gateway) {
    addMessage("assistant", "MCP registry requires a ToolNet gateway connection. Use /provider to configure.");
    return;
  }
  addMessage("assistant", "Fetching MCP registry...");
  const res = await gateway.getMcpRegistry();
  if (!res.success) {
    addMessage("assistant", `\u001b[31mFailed: ${res.error}\u001b[0m`);
    return;
  }
  const servers = res.data?.servers || [];
  if (servers.length === 0) {
    addMessage("assistant", "No MCP servers found in registry.");
    return;
  }
  const lines: string[] = [];
  lines.push(`MCP Registry (${res.data?.total || servers.length} servers)`);
  lines.push("───".repeat(14));
  for (const s of servers) {
    const auth = s.oauth ? " \u001b[33mOAuth\u001b[0m" : "";
    lines.push(`  \u001b[1m${s.title}\u001b[0m${auth}`);
    lines.push(`      ${s.url}`);
    if (s.toolNames?.length) {
      lines.push(`      tools: ${s.toolNames.join(", ")}`);
    }
    if (s.description) {
      lines.push(`      ${s.description.slice(0, 120)}`);
    }
  }
  addMessage("assistant", lines.join("\n"));
}

async function probeTools(args: string[], ctx: CommandContext) {
  const { gateway, addMessage } = ctx;
  if (!gateway) {
    addMessage("assistant", "MCP tools probing requires a ToolNet gateway connection. Use /provider to configure.");
    return;
  }
  if (args.length < 1) {
    addMessage("assistant", "Usage: /mcp tools <url>\ne.g. /mcp tools https://mcp.example.com/mcp");
    return;
  }
  const url = args[0];
  addMessage("assistant", `Probing MCP server at ${url}...`);
  const res = await gateway.probeMcpTools(url);
  if (!res.success) {
    addMessage("assistant", `\u001b[31mFailed: ${res.error}\u001b[0m`);
    return;
  }
  const tools = res.data?.tools || [];
  if (tools.length === 0) {
    addMessage("assistant", "No tools found (may require OAuth).");
    return;
  }
  const lines: string[] = [];
  lines.push(`MCP Tools at ${url}`);
  lines.push("───".repeat(12));
  for (const t of tools) {
    lines.push(`  \u001b[1m${t.name}\u001b[0m`);
    if (t.description) lines.push(`    ${t.description.slice(0, 120)}`);
  }
  addMessage("assistant", lines.join("\n"));
}


async function addMcp(args: string[], ctx: CommandContext) {
  const { addMessage } = ctx;
  if (args.length < 2) {
    addMessage("assistant", "Usage: /mcp add <name> <command> [args...]\ne.g. /mcp add fetch node index.js");
    return;
  }
  const [name, command, ...cmdArgs] = args;
  addLocalMcpServer(name, { command, args: cmdArgs });
  addMessage("assistant", `\x1b[32m✓\x1b[0m Added local MCP server '${name}'`);
}

async function removeMcp(args: string[], ctx: CommandContext) {
  const { addMessage } = ctx;
  if (args.length < 1) {
    addMessage("assistant", "Usage: /mcp remove <name>");
    return;
  }
  const name = args[0];
  const server = getEffectiveMcpServers().find(
    (s) =>
      s.name === name ||
      s.serverId === name ||
      s.name.toLowerCase() === name.toLowerCase() ||
      s.serverId.toLowerCase() === name.toLowerCase()
  );
  if (server?.sourceKind === "BUILTIN" || (server && isBuiltinSkillsMcp(server))) {
    mcpTrustManager.disableServer(server.serverId);
    if (server.name !== server.serverId) {
      mcpTrustManager.disableServer(server.name);
    }
    await mcpManager.disconnect(server.serverId).catch(() => {});
    addMessage(
      "assistant",
      `\x1b[33m!\x1b[0m Built-in MCP server '${server.name}' cannot be removed from core definitions. It has been disabled instead.\nUse '/mcp enable ${name}' to re-enable it.`
    );
    return;
  }
  removeLocalMcpServer(name);
  mcpTrustManager.disableServer(name);
  await mcpManager.disconnect(name).catch(() => {});
  addMessage("assistant", `\x1b[32m✓\x1b[0m Removed local MCP server '${name}'`);
}

/**
 * Explicit trust decision — enables a server and connects it.
 */
async function enableMcp(args: string[], ctx: CommandContext) {
  const { addMessage } = ctx;
  if (args.length < 1) {
    addMessage("assistant", "Usage: /mcp enable <name>");
    return;
  }
  const name = args[0];
  const server = getEffectiveMcpServers().find(
    (s) =>
      s.name === name ||
      s.serverId === name ||
      s.name.toLowerCase() === name.toLowerCase() ||
      s.serverId.toLowerCase() === name.toLowerCase()
  );
  if (!server) {
    addMessage("assistant", `\x1b[31m✗\x1b[0m No discovered MCP server named '${name}'.`);
    return;
  }
  mcpTrustManager.enableServer(server.serverId, server.config, server.sourceFile, server.name);
  await mcpManager.sync().catch(() => {});
  const status = await mcpManager.connect(server.serverId).catch(() => "failed");
  addMessage(
    "assistant",
    `\x1b[32m✓\x1b[0m Enabled '${server.name}' (${server.sourceKind}).` +
      (server.config.command ? `\n  command: ${server.config.command} ${(server.config.args || []).join(" ")}` : "") +
      (server.config.url ? `\n  url: ${server.config.url}` : "") +
      `\n  status: ${status}`
  );
}

async function disableMcp(args: string[], ctx: CommandContext) {
  const { addMessage } = ctx;
  if (args.length < 1) {
    addMessage("assistant", "Usage: /mcp disable <name>");
    return;
  }
  const name = args[0];
  const server = getEffectiveMcpServers().find(
    (s) =>
      s.name === name ||
      s.serverId === name ||
      s.name.toLowerCase() === name.toLowerCase() ||
      s.serverId.toLowerCase() === name.toLowerCase()
  );
  if (server) {
    mcpTrustManager.disableServer(server.serverId);
    if (server.name !== server.serverId) {
      mcpTrustManager.disableServer(server.name);
    }
    await mcpManager.disconnect(server.serverId).catch(() => {});
  } else {
    // Server may already be removed; still revoke any lingering trust by id.
    mcpTrustManager.disableServer(name);
    await mcpManager.disconnect(name).catch(() => {});
  }
  addMessage("assistant", `\x1b[32m✓\x1b[0m Disabled '${name}' (trust revoked).`);
}

export const mcpCommand: Command = {
  name: "mcp",
  aliases: [],
  description: "Manage MCP (Model Context Protocol) plugins and registry",
  usage: "/mcp [list|show|connect|disconnect|auth|logout|registry|tools|add|remove|enable|disable|status] ...",
  async handler(args: string[], ctx: CommandContext) {
    if (args.length === 0) {
      await showMcpStatus(ctx);
      return;
    }
    const sub = args[0].toLowerCase();
    const subArgs = args.slice(1);
    switch (sub) {
      case "registry":  await browseRegistry(ctx); break;
      case "tools":     await probeTools(subArgs, ctx); break;
      case "status":    await showMcpStatus(ctx); break;
      case "add":       await addMcp(subArgs, ctx); break;
      case "remove":    await removeMcp(subArgs, ctx); break;
      case "enable":    await enableMcp(subArgs, ctx); break;
      case "disable":   await disableMcp(subArgs, ctx); break;
 // remote MCP + auth, delegated to the one manager via the CLI.
      case "list":      await delegateToCli(["list", ...subArgs], ctx); break;
      case "show":      await delegateToCli(["status", ...subArgs], ctx); break;
      case "connect":   await delegateToCli(["connect", ...subArgs], ctx); break;
      case "disconnect":await delegateToCli(["disconnect", ...subArgs], ctx); break;
      case "auth":      await delegateToCli(["auth", ...subArgs], ctx); break;
      case "logout":    await delegateToCli(["logout", ...subArgs], ctx); break;
      default:          ctx.addMessage("assistant", `Unknown: ${sub}\nTry: /mcp, /mcp list, /mcp show, /mcp connect <name>, /mcp auth <name>, /mcp logout <name>, /mcp enable <name>`); break;
    }
  },
};
