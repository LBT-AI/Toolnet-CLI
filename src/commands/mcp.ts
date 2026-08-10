import type { Command, CommandContext } from "./index";
import { loadLocalMcpConfig, addLocalMcpServer, removeLocalMcpServer } from "../lib/mcpRunner";

async function showMcpStatus(ctx: CommandContext) {
  const { gateway, addMessage } = ctx;
  addMessage("assistant", "Fetching MCP status...");
  const res = await gateway.getCoworkSettings();
  if (!res.success) {
    addMessage("assistant", `\u001b[31mFailed: ${res.error}\u001b[0m`);
    return;
  }
  const data = res.data || {};
  const cowork = (data as any).cowork || {};
  const plugins = cowork.plugins || [];
  const localPlugins = cowork.localPlugins || [];
  const customPlugins = cowork.customPlugins || [];

  const localMcpConfig = loadLocalMcpConfig();
  const localMcpNames = Object.keys(localMcpConfig);
  const combinedLocal = Array.from(new Set([...localPlugins, ...localMcpNames]));

  const lines: string[] = [];
  lines.push("MCP — Status");
  lines.push("───".repeat(10));

  const installed = (data as any).installed;
  lines.push(`  Claude Desktop: ${installed ? "\u001b[32minstalled\u001b[0m" : "\u001b[33mnot detected\u001b[0m"}`);

  if (cowork.baseUrl) {
    lines.push(`  Base URL: ${cowork.baseUrl}`);
  }

  lines.push("");
  lines.push(`  Plugins (${plugins.length}):`);
  for (const p of plugins) {
    const icon = (p as any).url?.includes("/api/mcp/") ? "\u001b[36m\u25B6\u001b[0m" : "\u001b[34m\u2601\u001b[0m";
    lines.push(`    ${icon} ${(p as any).name || "?"}`);
    if ((p as any).toolNames?.length) {
      lines.push(`           tools: ${(p as any).toolNames.join(", ")}`);
    }
  }

  if (combinedLocal.length > 0) {
    lines.push("");
    lines.push(`  Local stdio plugins: ${combinedLocal.join(", ")}`);
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
  lines.push("  /mcp registry           Browse MCP registry");
  lines.push("  /mcp tools <url>        Probe MCP server tools");
  lines.push("  /mcp add <name> <cmd>   Add a local MCP server");
  lines.push("  /mcp remove <name>      Remove a local MCP server");

  addMessage("assistant", lines.join("\n"));
}

async function browseRegistry(ctx: CommandContext) {
  const { gateway, addMessage } = ctx;
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
  removeLocalMcpServer(name);
  addMessage("assistant", `\x1b[32m✓\x1b[0m Removed local MCP server '${name}'`);
}

export const mcpCommand: Command = {
  name: "mcp",
  aliases: [],
  description: "Manage MCP (Model Context Protocol) plugins and registry",
  usage: "/mcp [registry|tools|add|remove|status] ...",
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
      default:          ctx.addMessage("assistant", `Unknown: ${sub}\nTry: /mcp, /mcp registry, /mcp tools <url>, /mcp add, /mcp remove`); break;
    }
  },
};
