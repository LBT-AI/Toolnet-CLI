import { describe, it, expect } from "bun:test";

export type ToolExecutionPhase = "queued" | "running" | "completed" | "error";

export interface ToolEventView {
  tool: string;
  args: Record<string, unknown>;
  phase: ToolExecutionPhase;
  output?: string;
  error?: string;
  expanded?: boolean;
  durationMs?: number;
}

export function formatToolPresentation(event: ToolEventView): { summary: string; lines: string[] } {
  const { tool, phase, output = "", error, expanded = false, durationMs = 0 } = event;
  const outLines = output.split("\n").filter((l) => l.length > 0);

  let summary = `[tool:${tool}]`;
  if (phase === "queued") {
    summary += ` (queued)`;
    return { summary, lines: [summary] };
  }
  if (phase === "running") {
    summary += ` ⚙️ running...`;
    return { summary, lines: [summary] };
  }
  if (phase === "error") {
    summary += ` ❌ failed: ${error || "unknown error"}`;
    return { summary, lines: [summary] };
  }

  // Completed
  summary += ` ✓ done (${durationMs}ms)`;
  const lines: string[] = [summary];

  if (outLines.length === 0) {
    return { summary, lines };
  }

  if (expanded || outLines.length <= 4) {
    for (const l of outLines) {
      lines.push(`    ${l}`);
    }
  } else {
    // Compact summary mode
    lines.push(`    ${outLines[0]}`);
    lines.push(`    … (${outLines.length - 1} more lines; toggle expand)`);
  }

  return { summary, lines };
}

describe("Tier 1 Feature Coverage: 3-Phase Tool Presentation", () => {
  it("F20.1: Queued state displays tool name and queued status badge", () => {
    const event: ToolEventView = {
      tool: "bash",
      args: { cmd: "npm test" },
      phase: "queued",
    };
    const res = formatToolPresentation(event);
    expect(res.summary).toContain("[tool:bash] (queued)");
    expect(res.lines.length).toBe(1);
  });

  it("F20.2: Running state displays active indicator and tool name", () => {
    const event: ToolEventView = {
      tool: "git_diff",
      args: {},
      phase: "running",
    };
    const res = formatToolPresentation(event);
    expect(res.summary).toContain("[tool:git_diff] ⚙️ running...");
  });

  it("F20.3: Completed state shows compact summary without dumping giant output inline", () => {
    const giantOutput = Array.from({ length: 20 }, (_, i) => `log line ${i + 1}`).join("\n");
    const event: ToolEventView = {
      tool: "npm_build",
      args: {},
      phase: "completed",
      output: giantOutput,
      durationMs: 150,
      expanded: false,
    };
    const res = formatToolPresentation(event);
    expect(res.summary).toContain("✓ done (150ms)");
    // Should be truncated with placeholder
    expect(res.lines.length).toBeLessThan(5);
    expect(res.lines.some((l) => l.includes("more lines"))).toBe(true);
  });

  it("F20.4: Toggling expanded renders full output lines", () => {
    const output = Array.from({ length: 10 }, (_, i) => `stdout: ${i}`).join("\n");
    const event: ToolEventView = {
      tool: "grep_search",
      args: { query: "test" },
      phase: "completed",
      output,
      expanded: true,
    };
    const res = formatToolPresentation(event);
    expect(res.lines.length).toBe(11); // 1 header + 10 lines
    expect(res.lines.some((l) => l.includes("more lines"))).toBe(false);
  });

  it("F20.5: Error state renders failure badge and message", () => {
    const event: ToolEventView = {
      tool: "fetch_api",
      args: { url: "https://example.com" },
      phase: "error",
      error: "404 Not Found",
    };
    const res = formatToolPresentation(event);
    expect(res.summary).toContain("❌ failed: 404 Not Found");
  });
});
