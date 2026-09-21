import { test, it, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  classifyCommand,
  classifyToolAction,
  resolveDefaultTimeout,
  clampTimeout,
  DEFAULT_SHELL_TIMEOUT_MS,
  DEFAULT_TEST_BUILD_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
} from "../../lib/commandClassifier";
import {
  renderToolLine,
  prettyToolTarget,
  formatDuration,
} from "../../lib/tool-format";
import {
  tuiState,
  openActiveToolActivity,
  updateActiveToolProgress,
  cancelActiveToolActivity,
  closeActiveToolActivity,
} from "../../tui/state";
import { renderActiveToolActivity, renderChatMessages, formatInlineMarkdown } from "../../tui/renderers/chatRenderer";
import { A, theme, setNoColor, isNoColor } from "../../term";
import { stripAnsi, computeLayoutGeometry } from "../../tui/layout";
import { redactOutputSecrets } from "../../lib/security/outputRedactor";
import { backgroundJobs } from "../../core/background/service";
import type { Msg } from "../../tui/types";

describe("Long-Running Tool UX & Semantic Color System", () => {
  beforeEach(() => {
    closeActiveToolActivity();
    setNoColor(false);
  });

  afterEach(() => {
    closeActiveToolActivity();
    setNoColor(false);
  });

  describe("1. Command Classification", () => {
    it("classifies virtualenv pytest as Test action with 5m default timeout", () => {
      const c = classifyCommand(".venv/bin/pytest tests/unit");
      expect(c.category).toBe("test");
      expect(c.actionLabel).toBe("Test");
      expect(c.isLongRunningCandidate).toBe(true);
      expect(c.defaultTimeoutMs).toBe(DEFAULT_TEST_BUILD_TIMEOUT_MS);
    });

    it("classifies bun test as Test action", () => {
      const c = classifyCommand("bun test src/teamwork");
      expect(c.category).toBe("test");
      expect(c.actionLabel).toBe("Test");
      expect(c.isLongRunningCandidate).toBe(true);
      expect(c.defaultTimeoutMs).toBe(DEFAULT_TEST_BUILD_TIMEOUT_MS);
    });

    it("classifies npm run build as Build action", () => {
      const c = classifyCommand("npm run build");
      expect(c.category).toBe("build");
      expect(c.actionLabel).toBe("Build");
      expect(c.isLongRunningCandidate).toBe(true);
      expect(c.defaultTimeoutMs).toBe(DEFAULT_TEST_BUILD_TIMEOUT_MS);
    });

    it("classifies npm install as Install action", () => {
      const c = classifyCommand("npm install");
      expect(c.category).toBe("install");
      expect(c.actionLabel).toBe("Install");
      expect(c.isLongRunningCandidate).toBe(true);
      expect(c.defaultTimeoutMs).toBe(DEFAULT_TEST_BUILD_TIMEOUT_MS);
    });

    it("classifies rg as Search action", () => {
      const c = classifyCommand("rg 'export function' src/");
      expect(c.category).toBe("search");
      expect(c.actionLabel).toBe("Search");
      expect(c.isLongRunningCandidate).toBe(false);
      expect(c.defaultTimeoutMs).toBe(DEFAULT_SHELL_TIMEOUT_MS);
    });

    it("handles chained expressions such as cd dir && pytest", () => {
      const c = classifyCommand("cd /workspace/subproject && pytest -v");
      expect(c.category).toBe("test");
      expect(c.actionLabel).toBe("Test");
      expect(c.isLongRunningCandidate).toBe(true);
    });

    it("classifies generic shell commands as Shell action with 60s default timeout", () => {
      const c = classifyCommand("echo hello world");
      expect(c.category).toBe("shell");
      expect(c.actionLabel).toBe("Run");
      expect(c.isLongRunningCandidate).toBe(false);
      expect(c.defaultTimeoutMs).toBe(DEFAULT_SHELL_TIMEOUT_MS);
    });
  });

  describe("2. Default Timeouts and Clamping", () => {
    it("resolves default timeouts correctly", () => {
      expect(resolveDefaultTimeout("pytest")).toBe(300_000);
      expect(resolveDefaultTimeout("cargo build")).toBe(300_000);
      expect(resolveDefaultTimeout("ls -la")).toBe(60_000);
    });

    it("clamps explicit timeout_ms within bounded range [100ms, 30min]", () => {
      expect(clampTimeout(50, "ls")).toBe(100);
      expect(clampTimeout(10_000, "ls")).toBe(10_000);
      expect(clampTimeout(2_000_000, "ls")).toBe(MAX_COMMAND_TIMEOUT_MS); // capped at 30 min (1_800_000ms)
      expect(clampTimeout(undefined, "cargo build")).toBe(300_000);
    });
  });

  describe("3. Tool Action Classification & Palette Alignment", () => {
    it("maps read tools to read category and theme.read", () => {
      const info = classifyToolAction("read_file", { path: "src/main.ts" });
      expect(info.category).toBe("read");
      expect(info.color).toBe(theme.read);
    });

    it("maps write tools to write category and theme.write", () => {
      const info = classifyToolAction("write_file", { path: "src/main.ts" });
      expect(info.category).toBe("write");
      expect(info.color).toBe(theme.write);
    });

    it("maps edit tools to edit category and theme.edit", () => {
      const info = classifyToolAction("replace_file_content", { TargetFile: "src/main.ts" });
      expect(info.category).toBe("edit");
      expect(info.color).toBe(theme.edit);
    });

    it("maps subagent tools to subagent category and theme.subagent", () => {
      const info = classifyToolAction("task", { prompt: "run task" });
      expect(info.category).toBe("subagent");
      expect(info.actionLabel).toBe("Subagent");
      expect(info.color).toBe(theme.subagent);
    });
  });

  describe("4. Tool Formatting & Color Discipline", () => {
    it("colors only the icon and action label, keeping target and elapsed dim", () => {
      const line = renderToolLine({
        action: "Test",
        target: ".venv/bin/pytest",
        elapsedMs: 12000,
        status: "running",
      });

      // Contains amber ● and Test
      expect(line).toContain("●");
      expect(line).toContain("Test");
      expect(line).toContain(".venv/bin/pytest");
      expect(line).toContain("12s");

      // Verify stripped version structure
      const stripped = stripAnsi(line);
      expect(stripped.trim()).toBe("● Test .venv/bin/pytest · 12s");
    });

    it("renders cancelled status cleanly with square icon", () => {
      const line = renderToolLine({
        action: "Test",
        target: ".venv/bin/pytest",
        elapsedMs: 22000,
        status: "cancelled",
      });

      const stripped = stripAnsi(line);
      expect(stripped.trim()).toBe("■ Test .venv/bin/pytest · cancelled · 22s");
    });

    it("formats duration human-readably", () => {
      expect(formatDuration(450)).toBe("0.5s");
      expect(formatDuration(2500)).toBe("2.5s");
      expect(formatDuration(12000)).toBe("12s");
      expect(formatDuration(65000)).toBe("1m 5s");
    });
  });

  describe("5. Active Tool Activity Lifecycle in TUI State", () => {
    it("opens active tool activity on start", () => {
      const act = openActiveToolActivity("call-1", "bash", { command: "bun test" });
      expect(tuiState.activeToolActivity).toBeDefined();
      expect(act.callId).toBe("call-1");
      expect(act.actionLabel).toBe("Test");
      expect(act.status).toBe("running");
      expect(act.elapsedMs).toBe(0);
    });

    it("updates progress tail lines bounded", () => {
      openActiveToolActivity("call-1", "bash", { command: "bun test" });
      updateActiveToolProgress("call-1", ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6"], 3500);

      expect(tuiState.activeToolActivity?.elapsedMs).toBe(3500);
      expect(tuiState.activeToolActivity?.tail?.length).toBe(5); // bounded to last 5
      expect(tuiState.activeToolActivity?.tail?.[4]).toBe("line 6");
    });

    it("cancels active tool activity immediately on cancelActiveToolActivity", () => {
      openActiveToolActivity("call-1", "bash", { command: "bun test" });
      const cancelled = cancelActiveToolActivity("call-1");

      expect(cancelled).toBe(true);
      expect(tuiState.activeToolActivity?.status).toBe("cancelled");
    });

    it("closes active tool activity on completion", () => {
      openActiveToolActivity("call-1", "bash", { command: "bun test" });
      const closed = closeActiveToolActivity("call-1");

      expect(closed).toBeDefined();
      expect(tuiState.activeToolActivity).toBeNull();
    });
  });

  describe("6. Chat Renderer Active Activity & No Duplicate Rows", () => {
    it("renders active running tool row at the tail of messages", () => {
      openActiveToolActivity("call-1", "bash", { command: "bun test" });
      updateActiveToolProgress("call-1", ["running test suite...", "1 pass, 0 fail"], 4000);

      const msgs: Msg[] = [
        { role: "user", content: "run tests" },
      ];

      const lines = renderChatMessages(msgs, 80, A.fgCyan);
      const text = lines.map((l) => stripAnsi(l)).join("\n");

      expect(text).toContain("● Test bun test · 4s");
      expect(text).toContain("running test suite...");
      expect(text).toContain("1 pass, 0 fail");
    });

    it("does not render duplicate start rows for answered or in-flight tool calls", () => {
      openActiveToolActivity("tc-1", "bash", { command: "pytest" });

      const msgs: Msg[] = [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "tc-1",
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command: "pytest" }) },
            },
          ],
        },
      ];

      const lines = renderChatMessages(msgs, 80, A.fgCyan);
      const stripped = lines.map((l) => stripAnsi(l)).join("\n");

      // The in-flight call tc-1 should NOT appear in tool_calls section, only once in activeToolActivity
      const matches = stripped.match(/Test pytest/g);
      expect(matches?.length).toBe(1);
    });

    it("renders completed tool response with compact summary and duration", () => {
      const msgs: Msg[] = [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "tc-2",
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command: "bun test" }) },
            },
          ],
        },
        {
          role: "tool",
          name: "bash",
          tool_call_id: "tc-2",
          content: JSON.stringify({
            stdout: "✓ test passed\nRan 1 test.",
            stderr: "",
            exitCode: 0,
            durationMs: 2500,
          }),
        },
      ];

      const lines = renderChatMessages(msgs, 80, A.fgCyan);
      const stripped = lines.map((l) => stripAnsi(l)).join("\n");

      expect(stripped).toContain("✓ Test bun test · 2.5s");
      expect(stripped).toContain("Ran 1 test.");
    });
  });

  describe("7. Secret Redaction & Live Progress Tail", () => {
    it("redacts secret tokens from live output tail", () => {
      const rawSecret = "Authorization: Bearer sk-ant-api03-abcdef12345678901234567890";
      const redacted = redactOutputSecrets(rawSecret);
      expect(redacted).not.toContain("sk-ant-api03-abcdef12345678901234567890");
      expect(redacted).toContain("****");
    });
  });

  describe("8. Mobile Layout Resilience", () => {
    it("renders active tool activity without overflow on narrow 52x20 terminal", () => {
      const layout = computeLayoutGeometry(52, 20);
      expect(layout.chatCols).toBeLessThanOrEqual(52);

      openActiveToolActivity("call-mobile", "bash", {
        command: "bun test very/deeply/nested/path/to/my/long/test/file/name.test.ts",
      });
      updateActiveToolProgress(
        "call-mobile",
        ["Line 1 that is exceptionally long and should be properly truncated without breaking terminal geometry"],
        14000
      );

      const rendered = renderActiveToolActivity(tuiState.activeToolActivity!, layout.chatCols);
      expect(rendered.length).toBeGreaterThan(0);

      for (const line of rendered) {
        expect(stripAnsi(line).length).toBeLessThanOrEqual(layout.chatCols);
      }
    });
  });

  describe("9. NO_COLOR Support", () => {
    it("suppresses ANSI color escapes when NO_COLOR is active", () => {
      setNoColor(true);
      expect(isNoColor()).toBe(true);

      const line = renderToolLine({
        action: "Test",
        target: ".venv/bin/pytest",
        elapsedMs: 15000,
        status: "running",
      });

      // No ESC [ escape codes present
      expect(line).not.toContain("\x1b[");
      expect(line.trim()).toBe("● Test .venv/bin/pytest · 15s");
    });
  });

  describe("10. Background Job Execution Integration", () => {
    it("starts background job through BackgroundJobService", () => {
      const job = backgroundJobs.start({
        type: "tool",
        title: "echo bg-test",
        run: async () => {},
      });
      expect(job.id).toBeDefined();
      expect(job.status).toBe("running");

      // Clean up job
      backgroundJobs.cancel(job.id);
      expect(backgroundJobs.get(job.id)?.status).toBe("cancelled");
    });
  });

  describe("11. Inline Markdown & Asterisk Elimination", () => {
    it("converts bold markdown **text** into bold ANSI without literal asterisks", () => {
      const formatted = formatInlineMarkdown("- **Exploring your codebase** — finding files");
      expect(formatted).not.toContain("**");
      expect(formatted).toContain(A.bold);
      expect(stripAnsi(formatted)).toBe("- Exploring your codebase — finding files");
    });

    it("converts inline code and bold italic cleanly", () => {
      const formatted = formatInlineMarkdown("Run `npm test` for ***full verification***");
      expect(formatted).not.toContain("`");
      expect(formatted).not.toContain("***");
      expect(stripAnsi(formatted)).toBe("Run npm test for full verification");
    });

    it("renders formatted markdown in chat messages without raw asterisks", () => {
      const msgs: Msg[] = [
        { role: "assistant", content: "I can help with:\n- **Reading files**\n- **Running tests**" },
      ];
      const lines = renderChatMessages(msgs, 80, A.fgCyan);
      const text = lines.map((l) => stripAnsi(l)).join("\n");
      expect(text).not.toContain("**Reading files**");
      expect(text).toContain("Reading files");
      expect(text).toContain("Running tests");
    });
  });
});
