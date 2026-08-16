import type { Command, CommandContext } from "./index";
import { getSandboxMode, setSandboxMode, SandboxMode } from "../lib/permissions";
import { policyEngine, sessionTrust, auditLogger } from "../lib/security";

export const sandboxCommand: Command = {
  name: "sandbox",
  aliases: ["permission", "permissions", "security"],
  description: "View or change sandbox mode and security policies",
  usage: "/sandbox [workspace|ask|full-access|clear|trust]",
  async handler(args: string[], ctx: CommandContext) {
    if (args.length === 0 || args[0] === "status") {
      const mode = getSandboxMode();
      const policy = policyEngine.getPolicySnapshot();
      const trusted = sessionTrust.listTrusted();

      let info =
        `Security & Sandbox Status:\n` +
        `  • Mode: \u001b[1m\u001b[36m${mode}\u001b[0m\n` +
        `  • Policy File: ${policy ? "\u001b[32mActive (.toolnet/permissions.json)\u001b[0m" : "\u001b[90mDefault Built-in\u001b[0m"}\n` +
        `  • Session Trusts: ${trusted.length > 0 ? `\u001b[33m${trusted.length} actions trusted\u001b[0m` : "None"}\n` +
        `  • Audit Log: \u001b[90m${auditLogger.getLogPath()}\u001b[0m\n\n` +
        `Available Modes:\n` +
        `  • \u001b[1mworkspace\u001b[0m   - Strict workspace isolation (blocks secrets, outside paths & dangerous commands)\n` +
        `  • \u001b[1mask\u001b[0m         - Interactive safe mode (prompts for approval on dangerous commands/secrets)\n` +
        `  • \u001b[1mfull-access\u001b[0m - Unrestricted mode (allows all actions without prompting)\n\n` +
        `Commands:\n` +
        `  /sandbox <mode>    Switch sandbox mode\n` +
        `  /sandbox clear     Clear all in-session approved trusts`;

      ctx.addMessage("assistant", info);
      return;
    }

    const target = args[0].toLowerCase();
    if (target === "clear") {
      sessionTrust.clear();
      ctx.addMessage("assistant", `\u001b[32m\u2713\u001b[0m Cleared all session-trusted permissions.`);
      return;
    }

    if (target === "workspace" || target === "ask" || target === "full-access") {
      setSandboxMode(target as SandboxMode);
      ctx.setStatusMsg(`Sandbox: ${target}`);
      ctx.addMessage("assistant", `\u001b[32m\u2713\u001b[0m Sandbox mode updated to: \u001b[1m${target}\u001b[0m`);
    } else {
      ctx.addMessage(
        "assistant",
        `\u001b[31mInvalid sandbox option: ${target}\u001b[0m\n` +
          `Usage: /sandbox [workspace | ask | full-access | clear]`
      );
    }
  },
};
