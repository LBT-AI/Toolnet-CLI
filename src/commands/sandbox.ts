import type { Command, CommandContext } from "./index";
import { getSandboxMode, setSandboxMode, SandboxMode } from "../lib/permissions";

export const sandboxCommand: Command = {
  name: "sandbox",
  aliases: ["permission", "permissions", "security"],
  description: "View or change sandbox mode (workspace | ask | full-access)",
  usage: "/sandbox [workspace|ask|full-access]",
  async handler(args: string[], ctx: CommandContext) {
    if (args.length === 0) {
      const mode = getSandboxMode();
      ctx.addMessage(
        "assistant",
        `Current Sandbox Mode: \u001b[1m\u001b[36m${mode}\u001b[0m\n\n` +
        `Available Modes:\n` +
        `  • \u001b[1mworkspace\u001b[0m   - Strict workspace isolation (blocks outside paths & dangerous shell commands)\n` +
        `  • \u001b[1mask\u001b[0m         - Interactive safe mode (prompts for outside paths or dangerous commands)\n` +
        `  • \u001b[1mfull-access\u001b[0m - Unrestricted mode (allows all actions without prompting)`
      );
      return;
    }

    const target = args[0].toLowerCase();
    if (target === "workspace" || target === "ask" || target === "full-access") {
      setSandboxMode(target as SandboxMode);
      ctx.setStatusMsg(`Sandbox: ${target}`);
      ctx.addMessage("assistant", `\u001b[32m\u2713\u001b[0m Sandbox mode updated to: \u001b[1m${target}\u001b[0m`);
    } else {
      ctx.addMessage(
        "assistant",
        `\u001b[31mInvalid sandbox mode: ${target}\u001b[0m\n` +
        `Supported modes: workspace, ask, full-access`
      );
    }
  },
};
