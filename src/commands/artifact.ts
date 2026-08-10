import type { Command, CommandContext } from "./index";
import { currentCwd } from "../lib/codingAgent";
import fs from "node:fs";
import path from "node:path";

export const artifactCommand: Command = {
  name: "artifact",
  aliases: ["art"],
  description: "Manage artifacts. Usage: /artifact list | /artifact create <name> <content> | /artifact delete <name>",
  usage: "/artifact <action> [args...]",
  async handler(args: string[], ctx: CommandContext) {
    if (args.length === 0) {
      ctx.addMessage("assistant", "Usage: /artifact list | /artifact create <name> <content> | /artifact delete <name>");
      return;
    }

    const action = args[0].toLowerCase();
    const artifactsDir = path.join(currentCwd, ".artifacts");

    if (!fs.existsSync(artifactsDir)) {
      fs.mkdirSync(artifactsDir, { recursive: true });
    }

    if (action === "list") {
      const files = fs.readdirSync(artifactsDir);
      if (files.length === 0) {
        ctx.addMessage("assistant", "No artifacts found.");
        return;
      }
      const links = files.map(file => {
        const absPath = path.join(artifactsDir, file);
        return `\x1b]8;;file://${absPath}\x1b\\${file}\x1b]8;;\x1b\\`;
      });
      ctx.addMessage("assistant", `Artifacts:\n${links.join("\n")}`);
    } else if (action === "create") {
      if (args.length < 3) {
        ctx.addMessage("assistant", "Usage: /artifact create <name> <content>");
        return;
      }
      const name = args[1];
      const content = args.slice(2).join(" ");
      const absPath = path.join(artifactsDir, name);
      fs.writeFileSync(absPath, content, "utf8");
      const link = `\x1b]8;;file://${absPath}\x1b\\${name}\x1b]8;;\x1b\\`;
      ctx.addMessage("assistant", `Created artifact: ${link}`);
    } else if (action === "delete") {
      if (args.length < 2) {
        ctx.addMessage("assistant", "Usage: /artifact delete <name>");
        return;
      }
      const name = args[1];
      const absPath = path.join(artifactsDir, name);
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
        ctx.addMessage("assistant", `Deleted artifact: ${name}`);
      } else {
        ctx.addMessage("assistant", `Artifact not found: ${name}`);
      }
    } else {
      ctx.addMessage("assistant", `Unknown action: ${action}`);
    }
  },
};
