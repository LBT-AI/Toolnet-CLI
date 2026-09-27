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
import { MCP_SUBCOMMANDS, mcpSubcommandHelpLines, mcpSubcommandUsageTokens } from "../lib/mcpSubcommands";
import { A, theme } from "../term";

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

/**
 * Resolve a picker-selected server ARGUMENT (stable serverId) to the canonical
 * display NAME the headless CLI's diagnostics filter expects. Unknown values
 * pass through unchanged so explicit user input keeps working.
 */
function resolveServerName(arg: string | undefined): string | undefined {
  if (!arg || arg.startsWith("--")) return arg;
  const hit = getEffectiveMcpServers().find(
    (s) =>
      s.serverId === arg ||
      s.name === arg ||
      s.serverId.toLowerCase() === arg.toLowerCase() ||
      s.name.toLowerCase() === arg.toLowerCase()
  );
  return hit?.name ?? arg;
}

/** Map the first non-flag token of a delegated invocation through the resolver. */
function resolveDelegateArgs(subArgs: string[]): string[] {
  const idx = subArgs.findIndex((a) => !a.startsWith("--"));
  if (idx === -1) return subArgs;
  const copy = [...subArgs];
  copy[idx] = resolveServerName(copy[idx]) ?? copy[idx];
  return copy;
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

  // One card per server: name, status, kind, tools, auth, url — semantic colors.
  const trustLines: string[] = [];
  for (const server of getEffectiveMcpServers()) {
    const trust = mcpTrustManager.getTrustState(
      server.serverId, server.config, server.sourceKind, server.config.disabled
    );
    const managedStatus = mcpManager.status(server.serverId);
    const toolCount = mcpManager.listTools(server.serverId).length;
    const isBuiltin = server.sourceKind === "BUILTIN" || isBuiltinSkillsMcp(server);

    const disabled = trust === "disabled";
    const connected = !disabled && managedStatus === "connected";
    const statusColor = disabled ? A.fgMuted : connected ? A.fgGreen : A.fgWarning;
    const dot = disabled ? `${A.fgMuted}○${A.reset}` : `${statusColor}●${A.reset}`;

    const kind = isBuiltin
      ? `${A.fgViolet}[builtin]${A.reset}`
      : `${A.fgSubtext}[${server.config.type === "remote" ? "remote" : "local"}]${A.reset}`;
    const statusLabel = disabled ? "disabled" : managedStatus;
    const toolsDetail = connected ? ` ${A.fgMuted}· ${toolCount} tools${A.reset}` : "";

    trustLines.push(`  ${dot} ${A.fgText}${A.bold}${server.name}${A.reset} ${kind} ${statusColor}${statusLabel}${A.reset}${toolsDetail}`);
    if (server.config.url) {
      trustLines.push(`      ${A.fgMuted}url${A.reset} ${A.fgSubtext}${server.config.url}${A.reset}`);
    }
  }

  const lines: string[] = [];
  lines.push(A.fgAccent + A.bold + "MCP — Status" + A.reset);
  lines.push(A.fgBorder + "─".repeat(28) + A.reset);

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
  // Driven by the ONE canonical subcommand definition (src/lib/mcpSubcommands),
  // the same source the interactive picker uses.
  lines.push(...mcpSubcommandHelpLines());
  lines.push("  /mcp status             Show MCP status (alias of show)");
  lines.push("  /mcp help               Show this help");

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
  usage: `/mcp [${mcpSubcommandUsageTokens()}|status|help] ...`,
  subcommands: MCP_SUBCOMMANDS.map((s) => ({ name: s.name, usage: s.usage, description: s.description })),
  async handler(args: string[], ctx: CommandContext) {
    if (args.length === 0) {
      await showMcpStatus(ctx);
      return;
    }
    const sub = args[0].toLowerCase();
    const subArgs = args.slice(1);
    switch (sub) {
      case "help":      await showMcpStatus(ctx); break;
      case "registry":  await browseRegistry(ctx); break;
      case "tools":     await probeTools(subArgs, ctx); break;
      case "status":    await showMcpStatus(ctx); break;
      case "add":       await addMcp(subArgs, ctx); break;
      case "remove":    await removeMcp(subArgs, ctx); break;
      case "enable":    await enableMcp(subArgs, ctx); break;
      case "disable":   await disableMcp(subArgs, ctx); break;
 // remote MCP + auth, delegated to the one manager via the CLI.
      case "list":      await delegateToCli(["list", ...resolveDelegateArgs(subArgs)], ctx); break;
      case "show":      await delegateToCli(["status", ...resolveDelegateArgs(subArgs)], ctx); break;
      case "connect":   await delegateToCli(["connect", ...resolveDelegateArgs(subArgs)], ctx); break;
      case "disconnect":await delegateToCli(["disconnect", ...resolveDelegateArgs(subArgs)], ctx); break;
      case "auth":      await delegateToCli(["auth", ...resolveDelegateArgs(subArgs)], ctx); break;
      case "logout":    await delegateToCli(["logout", ...resolveDelegateArgs(subArgs)], ctx); break;
      default:          ctx.addMessage("assistant", `Unknown: ${sub}\nTry: /mcp, /mcp list, /mcp show, /mcp connect <name>, /mcp auth <name>, /mcp logout <name>, /mcp enable <name>`); break;
    }
  },
};
