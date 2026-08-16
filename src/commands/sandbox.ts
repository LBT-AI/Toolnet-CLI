import fs from "node:fs";
import path from "node:path";
import type { Command, CommandContext } from "./index";
import { getSandboxMode, setSandboxMode, SandboxMode } from "../lib/permissions";
import { policyEngine, sessionTrust, auditLogger } from "../lib/security";

export const sandboxCommand: Command = {
  name: "sandbox",
  aliases: ["permission", "permissions", "security"],
  description: "View or manage sandbox mode, project permissions, and code protection policies",
  usage: "/sandbox [workspace|ask|full-access|init|clear]",
  async handler(args: string[], ctx: CommandContext) {
    if (args.length === 0 || args[0] === "status") {
      const mode = getSandboxMode();
      const policy = policyEngine.getPolicySnapshot();
      const trusted = sessionTrust.listTrusted();

      let info =
        `🛡️ **ToolNet Security & Permissions Status**:\n` +
        `  • Active Mode    : \x1b[1m\x1b[36m${mode}\x1b[0m\n` +
        `  • Policy File    : ${policy ? "\x1b[32mActive (.toolnet/permissions.json)\x1b[0m" : "\x1b[90mDefault Built-in Policy\x1b[0m"}\n` +
        `  • Session Trusts : ${trusted.length > 0 ? `\x1b[33m${trusted.length} actions trusted\x1b[0m` : "None"}\n` +
        `  • Audit Log      : \x1b[90m${auditLogger.getLogPath()}\x1b[0m\n\n` +
        `📖 **Available Sandbox Modes**:\n` +
        `  • \x1b[1mworkspace\x1b[0m   - Strict workspace isolation (blocks secrets, outside paths & destructive commands)\n` +
        `  • \x1b[1mask\x1b[0m         - Interactive safe mode (prompts with [Y/A/N] for dangerous operations/secrets)\n` +
        `  • \x1b[1mfull-access\x1b[0m - Unrestricted system mode (allows all OS actions without confirmation)\n\n` +
        `⚙️ **Commands**:\n` +
        `  • \`/sandbox workspace\`   - Enforce strict project directory boundary\n` +
        `  • \`/sandbox ask\`         - Prompt confirmation for high-risk actions\n` +
        `  • \`/sandbox init\`        - Generate \`.toolnet/permissions.json\` project code safety policy\n` +
        `  • \`/sandbox clear\`       - Clear all session-approved trusts\n\n` +
        `🔒 *Project Code Protection: Destructive wiping (\`rm -rf *\`, \`git reset --hard\`, source code removal) is always blocked/prompted.*`;

      ctx.addMessage("assistant", info);
      return;
    }

    const target = args[0].toLowerCase();

    // Subcommand: /sandbox init
    if (target === "init" || target === "create") {
      const toolnetDir = path.join(process.cwd(), ".toolnet");
      const policyPath = path.join(toolnetDir, "permissions.json");

      const defaultPolicy = {
        allowedCommands: [
          "bun test*",
          "npm test*",
          "npm run build*",
          "bun run build*",
          "git status*",
          "git diff*",
          "git log*",
          "tsc*",
          "pytest*",
        ],
        blockedCommands: [
          "rm -rf *",
          "rm -rf ./*",
          "rm -rf .*",
          "rm -rf .git",
          "rm -rf src",
          "rm -rf lib",
          "rm -rf app",
          "git reset --hard*",
          "git clean -f*",
          ":(){ :|:& };:",
        ],
        blockedPaths: [
          ".env",
          ".env.*",
          ".ssh",
          "id_rsa",
          ".aws",
          ".npmrc",
        ],
        allowedWritePaths: [
          ".",
        ],
      };

      try {
        fs.mkdirSync(toolnetDir, { recursive: true });
        fs.writeFileSync(policyPath, JSON.stringify(defaultPolicy, null, 2), "utf8");
        policyEngine.reload();
        ctx.addMessage(
          "assistant",
          `✅ **Created project security policy**: \`.toolnet/permissions.json\`\n\n` +
            `• Blocked destructive file/directory wiping (\`rm -rf *\`, \`git reset --hard\`, \`rm -rf src\`)\n` +
            `• Blocked sensitive credential files (\`.env*\`, \`.ssh\`, \`.npmrc\`)\n` +
            `• Whitelisted safe build/test commands (\`bun test\`, \`npm run build\`, etc.)\n\n` +
            `You can edit \`.toolnet/permissions.json\` anytime to customize project rules.`
        );
      } catch (err) {
        ctx.addMessage("assistant", `\x1b[31mFailed to create permissions file: ${err}\x1b[0m`);
      }
      return;
    }

    if (target === "clear") {
      sessionTrust.clear();
      ctx.addMessage("assistant", `\x1b[32m✓\x1b[0m Cleared all session-trusted permissions.`);
      return;
    }

    if (target === "workspace" || target === "ask" || target === "full-access") {
      setSandboxMode(target as SandboxMode);
      ctx.setStatusMsg(`Sandbox: ${target}`);
      ctx.addMessage("assistant", `\x1b[32m✓\x1b[0m Sandbox mode updated to: \x1b[1m${target}\x1b[0m`);
    } else {
      ctx.addMessage(
        "assistant",
        `\x1b[31mInvalid sandbox option: ${target}\x1b[0m\n` +
          `Usage: \`/sandbox [workspace | ask | full-access | init | clear]\``
      );
    }
  },
};
