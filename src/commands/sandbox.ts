import fs from "node:fs";
import path from "node:path";
import type { Command, CommandContext } from "./index";
import { getSandboxMode, setSandboxMode, SandboxMode } from "../lib/permissions";
import { policyEngine, auditLogger } from "../lib/security";
import { SessionTrustManager } from "../lib/security/sessionTrust";
import type { PermissionCapability } from "../lib/security/types";

const ALL_CAPABILITIES: PermissionCapability[] = [
  "READ",
  "CREATE",
  "MODIFY",
  "DELETE",
  "EXECUTE",
  "RESET",
  "NETWORK",
  "SYSTEM",
];

export const sandboxCommand: Command = {
  name: "sandbox",
  aliases: ["permission", "permissions", "security"],
  description: "View or manage sandbox mode, project permissions matrix, and code safety policies",
  usage: "/sandbox [workspace|ask|full-access|grant <cap>|revoke <cap>|init|clear]",
  async handler(args: string[], ctx: CommandContext) {
    if (args.length === 0 || args[0] === "status") {
      const mode = getSandboxMode();
      const policy = policyEngine.getPolicySnapshot();
      const trusted = new SessionTrustManager().listTrusted(ctx.getCurrentSessionId?.() || "");
      const caps = policyEngine.getAllCapabilities();

      const capLines = [
        `  • **READ**    : ${caps.READ ? "\x1b[32mAllowed ✓\x1b[0m" : "\x1b[31mBlocked ✗\x1b[0m"}  *(Read files, directory trees, git status)*`,
        `  • **CREATE**  : ${caps.CREATE ? "\x1b[32mAllowed ✓\x1b[0m" : "\x1b[31mBlocked ✗\x1b[0m"}  *(Create new files, tests, directories)*`,
        `  • **MODIFY**  : ${caps.MODIFY ? "\x1b[32mAllowed ✓\x1b[0m" : "\x1b[31mBlocked ✗\x1b[0m"}  *(Surgical code editing & patch in workspace)*`,
        `  • **DELETE**  : ${caps.DELETE ? "\x1b[33mUnlocked ⚠\x1b[0m" : "\x1b[36mProtected 🔒\x1b[0m"}  *(rm, file deletion, dropping databases)*`,
        `  • **EXECUTE** : ${caps.EXECUTE ? "\x1b[32mAllowed ✓\x1b[0m" : "\x1b[31mBlocked ✗\x1b[0m"}  *(Running builds, tests, typecheck)*`,
        `  • **RESET**   : ${caps.RESET ? "\x1b[33mUnlocked ⚠\x1b[0m" : "\x1b[36mProtected 🔒\x1b[0m"}  *(git reset --hard, clean, uncommitted wipe)*`,
        `  • **NETWORK** : ${caps.NETWORK ? "\x1b[32mAllowed ✓\x1b[0m" : "\x1b[31mBlocked ✗\x1b[0m"}  *(Web fetch, API calls, docs lookup)*`,
        `  • **SYSTEM**  : ${caps.SYSTEM ? "\x1b[31mCRITICAL ⚠\x1b[0m" : "\x1b[31mLocked 🛑\x1b[0m"}  *(Sudo, OS admin, termination, hardware)*`,
      ].join("\n");

      let info =
        `🛡️ **ToolNet Security & Granular Permissions Matrix**:\n` +
        `  • Active Sandbox Mode : \x1b[1m\x1b[36m${mode}\x1b[0m\n` +
        `  • Project Policy File : ${policy ? "\x1b[32mActive (.toolnet/permissions.json)\x1b[0m" : "\x1b[90mDefault Safe Policy\x1b[0m"}\n` +
        `  • Session Approvals   : ${trusted.length > 0 ? `\x1b[33m${trusted.length} actions trusted\x1b[0m` : "None"}\n` +
        `  • Security Audit Log  : \x1b[90m${auditLogger.getLogPath()}\x1b[0m\n\n` +
        `🔒 **8 Granular Action Capabilities**:\n` +
        `${capLines}\n\n` +
        `⚙️ **Commands**:\n` +
        `  • \`/sandbox workspace\`       - Enforce strict workspace isolation\n` +
        `  • \`/sandbox ask\`             - Interactive prompt [Y/A/N] for dangerous actions\n` +
        `  • \`/sandbox grant <cap>\`      - Unlock a capability (e.g. \`/sandbox grant delete\`)\n` +
        `  • \`/sandbox revoke <cap>\`     - Lock a capability (e.g. \`/sandbox revoke delete\`)\n` +
        `  • \`/sandbox init\`            - Generate \`.toolnet/permissions.json\` project policy\n` +
        `  • \`/sandbox clear\`           - Clear all session-approved trusts\n\n` +
        `💡 *Note: Jailbreak/Bypass only affects LLM reasoning; Project Code Safety & Permissions are enforced 100% locally.*`;

      ctx.addMessage("assistant", info);
      return;
    }

    const target = args[0].toLowerCase();

    // Subcommand: /sandbox grant <capability>
    if (target === "grant" || target === "allow") {
      const capName = (args[1] || "").toUpperCase() as PermissionCapability;
      if (!ALL_CAPABILITIES.includes(capName)) {
        ctx.addMessage("assistant", `✖ Unknown capability: "${args[1]}". Valid: ${ALL_CAPABILITIES.join(", ")}`);
        return;
      }
      policyEngine.setCapability(capName, true);
      ctx.addMessage("assistant", `✅ Capability **${capName}** has been **GRANTED** for this session.`);
      return;
    }

    // Subcommand: /sandbox revoke <capability>
    if (target === "revoke" || target === "deny" || target === "lock") {
      const capName = (args[1] || "").toUpperCase() as PermissionCapability;
      if (!ALL_CAPABILITIES.includes(capName)) {
        ctx.addMessage("assistant", `✖ Unknown capability: "${args[1]}". Valid: ${ALL_CAPABILITIES.join(", ")}`);
        return;
      }
      policyEngine.setCapability(capName, false);
      ctx.addMessage("assistant", `🔒 Capability **${capName}** has been **LOCKED** (requires approval).`);
      return;
    }

    // Subcommand: /sandbox init
    if (target === "init" || target === "create") {
      const toolnetDir = path.join(process.cwd(), ".toolnet");
      const policyPath = path.join(toolnetDir, "permissions.json");

      const defaultPolicy = {
        capabilities: {
          read: true,
          create: true,
          modify: true,
          delete: false,
          execute: true,
          reset: false,
          network: true,
          system: false,
        },
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
            `• Configured 8 Granular Capabilities (\`DELETE: false\`, \`RESET: false\`, \`SYSTEM: false\`)\n` +
            `• Whitelisted safe build/test commands (\`bun test\`, \`npm run build\`, etc.)\n\n` +
            `You can edit \`.toolnet/permissions.json\` anytime to customize project rules.`
        );
      } catch (err) {
        ctx.addMessage("assistant", `\x1b[31mFailed to create permissions file: ${err}\x1b[0m`);
      }
      return;
    }

    if (target === "clear") {
      new SessionTrustManager().clear(ctx.getCurrentSessionId?.() || "");
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
          `Usage: \`/sandbox [workspace | ask | full-access | grant <cap> | revoke <cap> | init | clear]\``
      );
    }
  },
};
