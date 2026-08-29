import type { Command, CommandContext } from "./index";
import fs from "node:fs";
import path from "node:path";
import { getSandboxMode } from "../lib/permissions";

export const policyCommand: Command = {
  name: "policy",
  aliases: ["permissions", "perm"],
  description: "View and manage workspace security policy (.toolnet/permissions.json)",
  usage: "/policy [show|init|mode]",
  async handler(args: string[], ctx: CommandContext) {
    const action = args[0]?.toLowerCase() || "show";
    const cwd = process.cwd();
    const policyPath = path.join(cwd, ".toolnet", "permissions.json");

    switch (action) {
      case "show":
      case "status": {
        const mode = getSandboxMode();
        let exists = fs.existsSync(policyPath);
        let details = "";

        if (exists) {
          try {
            const raw = fs.readFileSync(policyPath, "utf8");
            details = `\n\`\`\`json\n${raw}\n\`\`\``;
          } catch {
            details = "\n*(Failed to read file)*";
          }
        }

        ctx.addMessage("assistant",
          `🛡️ **Workspace Security Policy**\n\n` +
          `• **Sandbox Mode:** \`${mode}\`\n` +
          `• **Policy File:** \`${policyPath}\` (${exists ? "Configured" : "Not present — using default"})\n` +
          `${details}\n\n` +
          `Manage mode with: \`/sandbox workspace|ask|full-access\``
        );
        break;
      }

      case "init": {
        const dir = path.join(cwd, ".toolnet");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const defaultPolicy = {
          version: 1,
          sandboxMode: "ask",
          trustedTools: ["read_file", "search_workspace", "get_cwd"],
          deniedTools: [],
          restrictedPaths: [".git", ".env*", "id_rsa*", "*.pem"],
        };

        fs.writeFileSync(policyPath, JSON.stringify(defaultPolicy, null, 2) + "\n", "utf8");
        ctx.addMessage("assistant", `✅ Initialized default workspace policy at: \`${policyPath}\``);
        break;
      }

      default:
        ctx.addMessage("assistant",
          "Usage:\n" +
          "  /policy show   Show active security policy and sandbox mode\n" +
          "  /policy init   Create a template .toolnet/permissions.json file"
        );
    }
  },
};
