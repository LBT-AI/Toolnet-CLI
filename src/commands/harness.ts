import type { Command, CommandContext } from "./index";
import { getHarness } from "../lib/harness";
import { contextEngine } from "../lib/context";
import { sessionTrust } from "../lib/security/sessionTrust";

export const harnessCommand: Command = {
  name: "harness",
  aliases: ["kernel", "sys"],
  description: "Display Unified AgentHarness status, active subsystems, and runtime telemetry",
  usage: "/harness",
  async handler(_args: string[], ctx: CommandContext) {
    const harness = getHarness({
      model: ctx.currentModel ? ctx.currentModel() : undefined,
    });
    const snap = harness.getSnapshot();
    const memory = contextEngine.getSessionMemory();
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

    ctx.addMessage("assistant", lines.join("\n"));
  },
};
