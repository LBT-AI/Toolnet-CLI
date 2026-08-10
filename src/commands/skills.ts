import type { Command, CommandContext } from "./index";
import { loadLocalSkills } from "../lib/skillsLoader";
import { agentTools } from "../lib/agentTools";

interface Skill {
  id: string;
  name: string;
  description: string;
  endpoint: string | null;
  icon: string;
}

const BUILTIN_SKILLS: Skill[] = agentTools.map(t => ({
  id: t.function.name,
  name: t.function.name,
  description: t.function.description || "",
  endpoint: "local tool",
  icon: "🛠️"
}));

function showSkillsList(ctx: CommandContext) {
  const { addMessage } = ctx;
  const localSkills = loadLocalSkills();
  const totalCount = BUILTIN_SKILLS.length + localSkills.length;

  const lines: string[] = [];
  lines.push(`Skills (${totalCount})`);
  lines.push("───".repeat(10));

  lines.push("\u001b[1mBuilt-in Local Tools:\u001b[0m");
  for (const s of BUILTIN_SKILLS) {
    const ep = s.endpoint ? ` \u001b[90m${s.endpoint}\u001b[0m` : "";
    lines.push(`  ${s.icon} \u001b[1m${s.name}\u001b[0m${ep}`);
    lines.push(`           ${s.description}`);
  }

  if (localSkills.length > 0) {
    lines.push("");
    lines.push("\u001b[1mLocal Discovered Skills:\u001b[0m");
    for (const ls of localSkills) {
      lines.push(`  \uD83D\uDCDD \u001b[1m${ls.name}\u001b[0m \u001b[90m[${ls.id}]\u001b[0m`);
      if (ls.description) {
        lines.push(`           ${ls.description}`);
      }
    }
  }

  lines.push("");
  lines.push("Usage: /skills <name>  — Show skill details");
  addMessage("assistant", lines.join("\n"));
}

function showSkillDetail(name: string, ctx: CommandContext) {
  const { addMessage } = ctx;
  const skill = BUILTIN_SKILLS.find(
    s => s.id === name || s.name.toLowerCase().includes(name.toLowerCase())
  );
  if (skill) {
    const lines: string[] = [];
    lines.push(`${skill.icon}  \u001b[1m${skill.name}\u001b[0m`);
    lines.push("───".repeat(10));
    lines.push(`  ID:          ${skill.id}`);
    lines.push(`  Description: ${skill.description}`);
    lines.push(`  Endpoint:    ${skill.endpoint || "(entry skill)"}`);
    lines.push("");
    lines.push("Add this skill to your AI's instructions to teach it how");
    lines.push(`to use the ${skill.name} feature of local tools.`);
    addMessage("assistant", lines.join("\n"));
    return;
  }

  const localSkills = loadLocalSkills();
  const localSkill = localSkills.find(
    s => s.id === name.toLowerCase() || s.name.toLowerCase().includes(name.toLowerCase())
  );
  if (localSkill) {
    const lines: string[] = [];
    lines.push(`\uD83D\uDCDD  \u001b[1m${localSkill.name}\u001b[0m`);
    lines.push("───".repeat(10));
    lines.push(`  ID:          ${localSkill.id}`);
    lines.push(`  Description: ${localSkill.description || "(no description)"}`);
    lines.push(`  Path:        ${localSkill.filepath}`);
    lines.push("");
    lines.push("Instructions:");
    const snippet = localSkill.instructions.length > 500
      ? localSkill.instructions.slice(0, 500) + "...\n(truncated)"
      : localSkill.instructions;
    lines.push(snippet);
    addMessage("assistant", lines.join("\n"));
    return;
  }

  addMessage("assistant", `\u001b[31mSkill not found: ${name}\u001b[0m`);
}

export const skillsCommand: Command = {
  name: "skills",
  aliases: ["skill"],
  description: "List available API and local skills for AI agents",
  usage: "/skills [skill-name]",
  async handler(args: string[], ctx: CommandContext) {
    if (args.length === 0) {
      showSkillsList(ctx);
      return;
    }
    if (args[0] === "--help" || args[0] === "help") {
      ctx.addMessage("assistant",
        "/skills — Skills for AI Agents\n\n" +
        "  /skills           List all available skills (built-in and local)\n" +
        "  /skills <name>    Show skill details\n\n" +
        "Skills are instructional guides (SKILL.md) that teach AI agents\n" +
        "how to execute specific workflows and API features."
      );
      return;
    }
    showSkillDetail(args.join(" "), ctx);
  },
};
