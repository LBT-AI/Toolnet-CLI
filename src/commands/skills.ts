import type { Command, CommandContext } from "./index";
import {
  loadAllSkills,
  getSkillById,
  refreshSkillsCache,
  type SkillInfo,
} from "../lib/skillsLoader";

async function showSkillsList(ctx: CommandContext) {
  const { addMessage } = ctx;
  const skills = await loadAllSkills();

  const lines: string[] = [];
  lines.push(`Skills Registry (${skills.length} total)`);
  lines.push("───".repeat(12));

  const grouped: Record<string, SkillInfo[]> = {
    workspace: [],
    global: [],
    toolnet: [],
  };

  for (const s of skills) {
    if (grouped[s.source]) {
      grouped[s.source].push(s);
    } else {
      grouped.toolnet.push(s);
    }
  }

  if (grouped.workspace.length > 0) {
    lines.push("\u001b[1mWorkspace Skills:\u001b[0m");
    for (const s of grouped.workspace) {
      const status = s.enabled ? "\u001b[32m●\u001b[0m" : "\u001b[90m○\u001b[0m";
      lines.push(`  ${status} \u001b[1m${s.id}\u001b[0m — ${s.name}  \u001b[36m· workspace\u001b[0m`);
      if (s.description) lines.push(`     \u001b[90m${s.description}\u001b[0m`);
    }
    lines.push("");
  }

  if (grouped.global.length > 0) {
    lines.push("\u001b[1mGlobal Local Skills:\u001b[0m");
    for (const s of grouped.global) {
      const status = s.enabled ? "\u001b[32m●\u001b[0m" : "\u001b[90m○\u001b[0m";
      lines.push(`  ${status} \u001b[1m${s.id}\u001b[0m — ${s.name}  \u001b[35m· global\u001b[0m`);
      if (s.description) lines.push(`     \u001b[90m${s.description}\u001b[0m`);
    }
    lines.push("");
  }

  if (grouped.toolnet.length > 0) {
    lines.push("\u001b[1mToolNet Default Skills:\u001b[0m");
    for (const s of grouped.toolnet) {
      const status = s.enabled ? "\u001b[32m●\u001b[0m" : "\u001b[90m○\u001b[0m";
      const offlineBadge = s.isOfflineCache ? " \u001b[90m(offline)\u001b[0m" : "";
      lines.push(`  ${status} \u001b[1m${s.id}\u001b[0m — ${s.name}${offlineBadge}  \u001b[33m· toolnet\u001b[0m`);
      if (s.description) lines.push(`     \u001b[90m${s.description}\u001b[0m`);
    }
    lines.push("");
  }

  lines.push("Usage: /skills <name>    — Show skill details");
  lines.push("       /skills refresh   — Refresh default skills from ToolNet MCP");
  lines.push("       /tools            — View local execution tools");
  addMessage("assistant", lines.join("\n"));
}

async function showSkillDetail(name: string, ctx: CommandContext) {
  const { addMessage } = ctx;
  const skill = await getSkillById(name);

  if (!skill) {
    addMessage(
      "assistant",
      `\u001b[31mSkill not found: ${name}\u001b[0m\nUse /skills to see all available skills.`
    );
    return;
  }

  const lines: string[] = [];
  lines.push(`\uD83D\uDCDD  \u001b[1m${skill.name}\u001b[0m \u001b[90m[${skill.id}]\u001b[0m`);
  lines.push("───".repeat(12));
  lines.push(`  Source:      ${skill.source}`);
  if (skill.version) {
    lines.push(`  Version:     v${skill.version}`);
  }
  if (skill.tags && skill.tags.length > 0) {
    lines.push(`  Tags:        ${skill.tags.join(", ")}`);
  }
  const offlineText = skill.isOfflineCache ? " \u001b[33m[Offline cache]\u001b[0m" : "";
  lines.push(`  Status:      ${skill.enabled ? "\u001b[32m● Enabled\u001b[0m" : "\u001b[31m○ Disabled\u001b[0m"}${offlineText}`);
  if (skill.filepath) {
    lines.push(`  Path:        ${skill.filepath}`);
  }
  lines.push(`  Description: ${skill.description || "(no description)"}`);
  lines.push("");
  lines.push("\u001b[1mInstructions / Workflow:\u001b[0m");
  const instructions = skill.instructions || skill.description || "(No instructions available)";
  const snippet = instructions.length > 1000
    ? instructions.slice(0, 1000) + "...\n(truncated)"
    : instructions;
  lines.push(snippet);
  addMessage("assistant", lines.join("\n"));
}

export const skillsCommand: Command = {
  name: "skills",
  aliases: ["skill"],
  description: "Browse and configure ToolNet AI skills (Workspace, Global, ToolNet MCP)",
  usage: "/skills [skill-name|refresh]",
  async handler(args: string[], ctx: CommandContext) {
    if (args[0] === "--help" || args[0] === "help") {
      ctx.addMessage(
        "assistant",
        "/skills — ToolNet Skills System\n\n" +
        "  /skills             Open interactive skill picker\n" +
        "  /skills <name>      Show details and instructions for a skill\n" +
        "  /skills refresh     Refresh default skills from https://skills.toolnet.tech/mcp\n\n" +
        "Priority when duplicate IDs exist:\n" +
        "  Workspace (.agents/skills) > Global (~/.toolnet-cli/skills) > ToolNet MCP\n\n" +
        "For execution tools (read_file, shell, browser), use /tools instead."
      );
      return;
    }

    if (args[0] === "refresh" || args[0] === "reload" || args[0] === "-r") {
      const res = await refreshSkillsCache();
      const offlineMsg = res.isOffline ? " (offline cache active)" : "";
      ctx.setStatusMsg(`Refreshed ${res.count} ToolNet skills${offlineMsg}`);
      ctx.addMessage(
        "assistant",
        `\u001b[32m✓\u001b[0m Refreshed \u001b[1m${res.count}\u001b[0m ToolNet default skills from remote MCP${offlineMsg}.`
      );
      return;
    }

    if (typeof ctx.openSkillsPicker === "function") {
      const target = args.length > 0 ? args.join(" ").trim() : undefined;
      await ctx.openSkillsPicker(target);
      return;
    }

    if (args.length === 0) {
      await showSkillsList(ctx);
      return;
    }

    await showSkillDetail(args.join(" "), ctx);
  },
};
