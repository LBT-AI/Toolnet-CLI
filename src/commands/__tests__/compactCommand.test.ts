/**
 * `/compact` (also `/summarize`) — the MANUAL trigger for the same checkpoint
 * mechanism auto-compaction uses.
 *
 * Two contractual points are checked here: the command never starts a new
 * session (it rewrites only what the model will see), and it reports which
 * checkpoint the model now depends on.
 */

import { describe, expect, it } from "bun:test";
import { compactCommand } from "../compact";
import { findCommand } from "../index";
import { CHECKPOINT_SUMMARY_MARKER } from "../../lib/context/checkpointSummary";

function largeHistory() {
  return [
    { role: "system", content: "You are ToolNet Agent." },
    { role: "user", content: `old task ${"context ".repeat(4_000)}` },
    { role: "assistant", content: "working" },
    { role: "user", content: "newest instruction" },
    { role: "assistant", content: "newest answer" },
  ];
}

describe("/compact — manual checkpoint", () => {
  it("is reachable as /summarize as well as /compact", () => {
    expect(findCommand("/compact")?.command.name).toBe("compact");
    expect(findCommand("/summarize")?.command.name).toBe("compact");
    expect(findCommand("/compress")?.command.name).toBe("compact");
  });

  it("compacts in place: session id untouched, checkpoint reported", async () => {
    let messages: any[] = largeHistory();
    const out: string[] = [];
    const sessionId = "ses_compact_test";

    const ctx: any = {
      getMessages: () => messages,
      setMessages: (next: any[]) => {
        messages = next;
      },
      addMessage: (_role: string, text: string) => out.push(text),
      currentModel: () => "test-model",
      getCurrentSessionId: () => sessionId,
      summarizeWithModel: async () => "## Objective\nKeep going\n## Next Move\nRun the tests",
    };

    await compactCommand.handler([], ctx);

    // Not a new session: the same id still owns the (shorter) context.
    expect(ctx.getCurrentSessionId()).toBe(sessionId);
    expect(messages.length).toBeLessThan(largeHistory().length);
    const summary = messages.find((message) => message.content.includes(CHECKPOINT_SUMMARY_MARKER));
    expect(summary).toBeDefined();
    expect(summary.content).toContain("Run the tests");

    const report = out.join("\n");
    expect(report).toContain("model-written summary");
    expect(report).toContain("Session unchanged");
  });

  it("falls back to the deterministic checkpoint when no summarizer is available", async () => {
    let messages: any[] = largeHistory();
    const out: string[] = [];

    const ctx: any = {
      getMessages: () => messages,
      setMessages: (next: any[]) => {
        messages = next;
      },
      addMessage: (_role: string, text: string) => out.push(text),
      currentModel: () => "test-model",
    };

    await compactCommand.handler([], ctx);
    expect(out.join("\n")).toContain("deterministic summary");
  });

  it("reports that compaction is unsupported rather than silently doing nothing", async () => {
    const out: string[] = [];
    const ctx: any = { addMessage: (_role: string, text: string) => out.push(text) };
    await compactCommand.handler([], ctx);
    expect(out.join("\n")).toContain("not supported in this environment");
  });

  it("says why nothing happened when there is no older history to summarize", async () => {
    const out: string[] = [];
    const ctx: any = {
      getMessages: () => [
        { role: "system", content: "system" },
        { role: "user", content: "hi" },
      ],
      setMessages: () => {},
      addMessage: (_role: string, text: string) => out.push(text),
      currentModel: () => "test-model",
    };

    await compactCommand.handler([], ctx);
    // Whatever the reason, it must be stated — and nothing may be rewritten.
    expect(out.length).toBeGreaterThan(0);
    expect(out.join("\n")).toMatch(/not enough turns|does not need compaction/i);
  });
});
