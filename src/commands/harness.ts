import type { Command, CommandContext } from "./index";
import { getHarness } from "../lib/harness";
import { contextEngine } from "../lib/context";
import { sessionTrust } from "../lib/security/sessionTrust";

function getFormattedHarnessStatus(ctx: CommandContext): string {
  const harness = getHarness({
    model: ctx.currentModel ? ctx.currentModel() : undefined,
  });
  const snap = harness.getSnapshot();
  const memory = contextEngine.getSessionMemory(snap.sessionId);
  const trustedRules = sessionTrust.listTrusted();

  const lines: string[] = [
    `⚙️ **ToolNet AgentHarness 2.0 (Unified Execution Kernel)**`,
    `───────────────────────────────────────────────────────`,
    `  • **Session ID**: \`${snap.sessionId}\``,
    `  • **Active Model**: \`${snap.currentModel}\``,
    `  • **Workspace Root**: \`${snap.workspaceRoot}\``,
    `  • **Detected Stack**: \`${snap.activeFramework}\``,
    `  • **Security Sandbox**: \`${snap.sandboxMode}\` (${trustedRules.length} session-trusted rules)`,
    ``,
    `📊 **Subsystems & Observability Telemetry**:`,
    `  • **Context Engine**: Atomic compaction ready | ${memory.keyFilesTouched.length} tracked files`,
    `  • **Security Engine**: SecretGuard & Semantic Classifier active`,
    `  • **Total Tool Calls**: ${snap.totalToolCalls}`,
    `  • **Accumulated Tokens**: ~${snap.totalTokensUsed}`,
    `  • **Uptime**: ${Math.round((Date.now() - snap.initializedAt) / 1000)}s`,
    ``,
    `💡 *Execution Strategies available: Headless (-p), Turbo, Teamwork DAG, and Subagents.*`,
  ];

  return lines.join("\n");
}

export const harnessCommand: Command = {
  name: "harness",
  aliases: ["kernel", "sys"],
  description: "Display Unified AgentHarness status, active subsystems, and runtime telemetry",
  usage: "/harness [section]",
  async handler(args: string[], ctx: CommandContext) {
    if (args[0] === "--help" || args[0] === "help") {
      ctx.addMessage(
        "assistant",
        "/harness — ToolNet Agent Harness status\n\n" +
        "  /harness            Open the interactive Harness Panel\n" +
        "  /harness <section>  Open one section directly (session, security, tools, ...)\n\n" +
        "Sections: Session, Execution, Security, Context, Tools, Telemetry, Subagents."
      );
      return;
    }

    // Interactive TUI: open the Harness Panel overlay (nothing printed to chat).
    if (typeof ctx.openHarnessPanel === "function") {
      const target = args.length > 0 ? args.join(" ").trim() : undefined;
      await ctx.openHarnessPanel(target);
      return;
    }

    // Non-interactive fallback: dump full status as a chat message.
    ctx.addMessage("assistant", getFormattedHarnessStatus(ctx));
  },
};