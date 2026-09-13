import { describe, it, expect } from "bun:test";
import { runToolNetCli } from "../harness/cliRunner";
import { visibleWidth, padVisible, truncateVisible, formatRelativeTime } from "../harness/contractLoaders";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

describe("Tier 1 Feature Coverage: Non-TUI Commands Isolation & Shared Contracts", () => {
  it("F2.1: 'toolnet version' executes cleanly without alt-screen switch or TUI initialization", async () => {
    const res = await runToolNetCli({ args: ["version"] });
    expect(res.exitCode).toBe(0);
    expect(res.hasAltScreen).toBe(false);
    expect(res.stdout).toContain("ToolNet CLI v1.2.4");
  });

  it("F2.2: 'toolnet --help' prints global help and exits cleanly with code 0", async () => {
    const res = await runToolNetCli({ args: ["--help"] });
    expect(res.exitCode).toBe(0);
    expect(res.hasAltScreen).toBe(false);
    expect(res.stdout).toContain("ToolNet CLI — AI coding agent for the terminal");
    expect(res.stdout).toContain("SUBCOMMANDS:");
  });

  it("F2.3: 'toolnet models --help' displays model routing CLI options without loading TUI renderer", async () => {
    const res = await runToolNetCli({ args: ["models", "--help"] });
    expect(res.exitCode).toBe(0);
    expect(res.hasAltScreen).toBe(false);
    expect(res.stdout).toContain("ToolNet models — provider registry");
    expect(res.stdout).toContain("routing");
  });

  it("F2.4: 'toolnet auth --help' displays authentication profile options without initializing TUI", async () => {
    const res = await runToolNetCli({ args: ["auth", "--help"] });
    expect(res.exitCode).toBe(0);
    expect(res.hasAltScreen).toBe(false);
    expect(res.stdout).toContain("toolnet");
  });

  it("F2.5: 'toolnet repo status' runs repository intelligence command without TUI alt-screen", async () => {
    const res = await runToolNetCli({ args: ["repo", "status"] });
    expect(res.exitCode).toBe(0);
    expect(res.hasAltScreen).toBe(false);
    expect(res.stdout).toContain('"vcs": "git"');
  });

  it("F3.1: Shared visibleWidth correctly calculates width ignoring ANSI color codes", () => {
    const plain = "Hello World";
    const colored = "\x1b[31mHello \x1b[32mWorld\x1b[0m";
    expect(visibleWidth(plain)).toBe(11);
    expect(visibleWidth(colored)).toBe(11);
  });

  it("F3.2: Shared padVisible aligns text to target terminal cell width", () => {
    const text = "Prompt";
    const leftPadded = padVisible(text, 10, "left");
    expect(visibleWidth(leftPadded)).toBe(10);
    expect(leftPadded).toBe("Prompt    ");

    const rightPadded = padVisible(text, 10, "right");
    expect(visibleWidth(rightPadded)).toBe(10);
    expect(rightPadded).toBe("    Prompt");

    const centerPadded = padVisible(text, 10, "center");
    expect(visibleWidth(centerPadded)).toBe(10);
  });

  it("F3.3: Shared truncateVisible cuts text cell-safely with ellipsis", () => {
    const longText = "Supercalifragilisticexpialidocious";
    const truncated = truncateVisible(longText, 10);
    expect(visibleWidth(truncated)).toBe(10);
    expect(truncated.endsWith("…")).toBe(true);
  });

  it("F3.4: Shared formatRelativeTime formats timestamps relative to now", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 10_000)).toBe("10s ago");
    expect(formatRelativeTime(now - 120_000)).toBe("2m ago");
    expect(formatRelativeTime(now - 7_200_000)).toBe("2h ago");
    expect(formatRelativeTime(now - 172_800_000)).toBe("2d ago");
  });

  it("F4.1: Architecture verification: canonical session sources contain no development-history comments", () => {
    const sessionDir = resolve(process.cwd(), "src/core/session");
    if (!statSync(sessionDir, { throwIfNoEntry: false })) return;

    const files = readdirSync(sessionDir).filter((f) => f.endsWith(".ts") && !f.includes(".test."));
    for (const f of files) {
      const content = readFileSync(join(sessionDir, f), "utf8");
      const match = content.match(/Phase\s+\d+|PHASE\s+\d+/);
      expect(match).toBeNull();
    }
  });
});
