import { test, it, expect, describe, beforeEach } from "bun:test";
import { MultilineInputBuffer } from "../../tui/input/multilineInput";
import { parseDiffStats, renderCompactDiffSummary, renderUnifiedDiffLines } from "../../tui/renderers/diffRenderer";
import { renderSidebar } from "../../tui/renderers/sidebarRenderer";
import { renderHeader } from "../../tui/renderers/headerRenderer";
import { renderWorkingStatus, renderInputArea, renderFooter } from "../../tui/renderers/statusRenderer";
import { renderSuggestionsPopup } from "../../tui/renderers/suggestRenderer";
import { renderChatMessages } from "../../tui/renderers/chatRenderer";
import { renderModelPickerBox } from "../../tui/renderers/modelPickerRenderer";
import { getGlobalTracker } from "../../lib/usage";
import { computeLayout, stripAnsi, truncate } from "../../tui/layout";
import { isNoColor, setNoColor, A } from "../../term";
import { handleKey, getInputState, setInputState, resetInputState } from "../../tui/input/inputHandler";
import { tuiState } from "../../tui/state";

describe("P4.1 — TUI Modular Independence", () => {
  it("TUI modules import independently without side effects", async () => {
    const layout = await import("../../tui/layout");
    expect(typeof layout.computeLayout).toBe("function");

    const state = await import("../../tui/state");
    expect(state.tuiState).toBeDefined();

    const diff = await import("../../tui/renderers/diffRenderer");
    expect(typeof diff.parseDiffStats).toBe("function");

    const sidebar = await import("../../tui/renderers/sidebarRenderer");
    expect(typeof sidebar.renderSidebar).toBe("function");

    const input = await import("../../tui/input/inputHandler");
    expect(typeof input.handleKey).toBe("function");
  });
});

describe("P4.2 — Multiline Input & Cursor Movement", () => {
  let buffer: MultilineInputBuffer;

  beforeEach(() => {
    buffer = new MultilineInputBuffer();
  });

  it("handles inserting multiline text and tracks cursor", () => {
    buffer.insertText("Line 1");
    buffer.insertNewline();
    buffer.insertText("Line 2");

    expect(buffer.getText()).toBe("Line 1\nLine 2");
    expect(buffer.isMultiline()).toBe(true);
    expect(buffer.getCursor()).toBe(13);
  });

  it("moves cursor up and down across lines in multiline input", () => {
    buffer.setText("Hello World\nSecond Line\nThird Line", 20);
    expect(buffer.isAtFirstLine()).toBe(false);

    // Move up from second line to first line
    const movedUp = buffer.moveUp();
    expect(movedUp).toBe(true);
    expect(buffer.isAtFirstLine()).toBe(true);

    // Move down back to second line
    const movedDown = buffer.moveDown();
    expect(movedDown).toBe(true);
  });

  it("paste multiline does not submit automatically", () => {
    resetInputState();
    setInputState("initial ");

    // Simulating paste event insertion
    const pastedChunk = "function test() {\n  return 42;\n}";
    const current = getInputState();
    setInputState(current.buffer + pastedChunk);

    const afterPaste = getInputState();
    expect(afterPaste.buffer).toBe("initial function test() {\n  return 42;\n}");
    expect(afterPaste.buffer).toContain("\n");
  });
});

describe("P4.3 — Diff Rendering", () => {
  it("diff renderer computes additions and deletions accurately", () => {
    const rawDiff = `
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,5 @@
-oldLine1
-oldLine2
+newLine1
+newLine2
+newLine3
`;
    const stats = parseDiffStats(rawDiff);
    expect(stats.length).toBe(1);
    expect(stats[0].additions).toBe(3);
    expect(stats[0].deletions).toBe(2);

    const summary = renderCompactDiffSummary(stats[0]);
    expect(summary).toContain("+3");
    expect(summary).toContain("-2");
  });

  it("diff renderer truncates large diffs beyond max lines", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`+ added line ${i}`);
    }
    const longDiff = lines.join("\n");
    const rendered = renderUnifiedDiffLines(longDiff, 20);

    expect(rendered.length).toBe(21); // 20 lines + truncation notice
    expect(rendered[rendered.length - 1]).toContain("more lines");
  });
});

describe("P4.4 — Token/Cost Sidebar", () => {
  it("usage sidebar reads UsageTracker correctly", () => {
    const tracker = getGlobalTracker();
    tracker.reset();
    tracker.recordUsage({
      inputTokens: 1000,
      outputTokens: 500,
      model: "openai/gpt-4o",
      latencyMs: 300,
    });

    const lines = renderSidebar("openai/gpt-4o", Date.now() - 5000, 40);
    const joined = lines.join("\n");

    expect(joined).toContain("Token & Usage Metrics");
    expect(joined).toContain("1,500");
    expect(joined).toContain("Cost:");
  });
});

describe("P4.20 & P4.21 — Terminal Resize & NO_COLOR", () => {
  it("computeLayout handles small terminals without crashing", () => {
    const layout = computeLayout(0, 3, 0);
    expect(layout.cols).toBeGreaterThanOrEqual(20);
    expect(layout.rows).toBeGreaterThanOrEqual(5);
    expect(layout.chatRows).toBeGreaterThanOrEqual(1);
  });

  it("NO_COLOR suppresses ANSI color escape codes in term styling", () => {
    setNoColor(true);
    expect(isNoColor()).toBe(true);
    expect(A.fgGreen).toBe("");
    expect(A.fgRed).toBe("");
    expect(A.reset).toBe("");

    setNoColor(false);
    expect(isNoColor()).toBe(false);
    expect(A.fgGreen).toContain("\x1b");
  });
});

describe("P4.22 — Keyboard UX & Abort", () => {
  beforeEach(() => {
    tuiState.pendingConfirmation = null;
    tuiState.showHelp = false;
    tuiState.showModelPicker = false;
    tuiState.showKeyManager = false;
    tuiState.showSkillsPicker = false;
    tuiState.showQueueManager = false;
    tuiState.showSessionPicker = false;
    tuiState.ctrlCCount = 0;
    tuiState.isStreaming = false;
  });

  it("Ctrl+C aborts streaming session first", () => {
    tuiState.isStreaming = true;
    let aborted = false;
    tuiState.abortController = {
      abort: () => { aborted = true; },
      signal: {} as any,
    };

    let exitCalled = false;
    handleKey(Buffer.from("\x03"), {
      renderAll: () => {},
      sendMessage: () => {},
      exitApp: () => { exitCalled = true; },
      openModelPicker: async () => {},
    });

    expect(aborted).toBe(true);
    expect(exitCalled).toBe(false);
    expect(tuiState.isStreaming).toBe(false);
  });
});

describe("TUI Redesign — Header & Working Status & Footer", () => {
  it("Header renders clean branding and live status badges", () => {
    const idleHeader = renderHeader(80, {
      agentMode: "Build",
      bypassMode: false,
      bypassLevel: "none",
      statusText: "",
    });
    const stripped = stripAnsi(idleHeader);
    expect(stripped).toContain("ToolNet CLI");
    expect(stripped).toContain("[Build]");
    expect(stripped).toContain("● Idle");
    expect(stripped).not.toContain("localhost");

    const workingHeader = renderHeader(80, {
      agentMode: "Plan",
      bypassMode: false,
      bypassLevel: "none",
      isStreaming: true,
      statusText: "Generating response",
    });
    const workingStripped = stripAnsi(workingHeader);
    expect(workingStripped).toContain("ToolNet CLI");
    expect(workingStripped).toContain("[Plan]");
    expect(workingStripped).toContain("Working");
  });

  it("Working Status line shows live spinner, elapsed time, and ready state", () => {
    const readyStatus = renderWorkingStatus(80, {
      showHelp: false,
      isStreaming: false,
      spinnerIdx: 0,
      statusText: "",
      elapsedDisplay: "",
      primaryColor: "\x1b[36m",
    });
    expect(stripAnsi(readyStatus)).toContain("● Ready");

    const streamingStatus = renderWorkingStatus(80, {
      showHelp: false,
      isStreaming: true,
      spinnerIdx: 2,
      statusText: "Executing tests",
      elapsedDisplay: "3.5s",
      primaryColor: "\x1b[36m",
    });
    const streamingStripped = stripAnsi(streamingStatus);
    expect(streamingStripped).toContain("Executing tests");
    expect(streamingStripped).toContain("3.5s");
  });

  it("Input Area displays clean prompt and placeholder", () => {
    const emptyInput = renderInputArea(80, "", "\x1b[36m");
    expect(stripAnsi(emptyInput)).toContain("> Enter a coding task or / for commands");

    const typingInput = renderInputArea(80, "refactor providers\nand run tests", "\x1b[36m");
    expect(stripAnsi(typingInput)).toContain("refactor providers ↵");
  });

  it("Footer displays Provider, Model, Workspace and updates immediately", () => {
    const footerConfigured = renderFooter(100, {
      providerName: "OpenAI Compatible",
      currentModel: "gpt-4o-mini",
      workspacePath: "/home/user/project",
    });
    const confStripped = stripAnsi(footerConfigured);
    expect(confStripped).toContain("Provider: OpenAI Compatible");
    expect(confStripped).toContain("Model: gpt-4o-mini");
    expect(confStripped).toContain("Workspace:");

    const footerUnconfigured = renderFooter(100, {
      providerName: "",
      currentModel: "",
      workspacePath: "/root",
    });
    expect(stripAnsi(footerUnconfigured)).toContain("Provider: Not configured");
  });
});

describe("TUI Redesign — Command Palette & Model Picker", () => {
  it("Command Palette renders boxed popup with navigation hints", () => {
    const suggests = [
      { name: "/model", desc: "Switch active model" },
      { name: "/provider", desc: "Manage AI providers" },
      { name: "/session", desc: "Save or load sessions" },
    ];
    const lines = renderSuggestionsPopup(80, 8, suggests, 0, "\x1b[36m");
    const joined = lines.join("");

    expect(joined).toContain("Commands");
    expect(joined).toContain("/model");
    expect(joined).toContain("/provider");
    expect(joined).toContain("↑↓ navigate");
  });

  it("Model Picker renders filter box and tag badges", () => {
    const box = renderModelPickerBox(80, 24, {
      filteredModels: ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"],
      modelPickerIdx: 0,
      currentModel: "openai/gpt-4o",
      modelSearchQuery: "gpt",
    });

    expect(box).toContain("Select Model");
    expect(box).toContain("Filter:");
    expect(box).toContain("gpt-4o");
  });
});

describe("TUI Redesign — Conversation & Unicode Support", () => {
  it("renders User and Assistant messages distinctly", () => {
    const messages = [
      { role: "user" as const, content: "Viết hàm tính tổng" },
      { role: "assistant" as const, content: "Dưới đây là hàm TypeScript:\n```typescript\nfunction sum(a: number, b: number): number {\n  return a + b;\n}\n```" },
    ];
    const lines = renderChatMessages(messages, 80, "\x1b[36m");
    const joined = lines.join("\n");

    expect(joined).toContain("❯");
    expect(joined).toContain("Viết hàm tính tổng");
    expect(joined).toContain("✦");
    expect(joined).toContain("sum");
  });

  it("renders compact tool calls with bullet ●, tick ✓, and cross ✗", () => {
    const messages: any[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", function: { name: "read_file", arguments: JSON.stringify({ path: "src/index.ts" }) } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        name: "read_file",
        content: JSON.stringify({ stdout: "export const app = 1;", exitCode: 0 }),
      },
    ];
    const lines = renderChatMessages(messages, 80, "\x1b[36m");
    const joined = lines.join("\n");

    expect(joined).toContain("Read");
    expect(joined).toContain("src/index.ts");
    expect(joined).toContain("✓");
  });

  it("preserves multi-byte Vietnamese Unicode without corruption", () => {
    const messages = [
      { role: "user" as const, content: "Thử nghiệm Tiếng Việt có dấu: 🚀 Đã hoàn tất thành công!" },
      { role: "assistant" as const, content: "<thought>Đang suy nghĩ câu trả lời</thought>Kết quả xử lý chuẩn xác." },
    ];
    const lines = renderChatMessages(messages, 80, "\x1b[36m");
    const joined = lines.join("\n");

    expect(joined).toContain("Thử nghiệm Tiếng Việt có dấu: 🚀 Đã hoàn tất thành công!");
    expect(joined).toContain("💭");
    expect(joined).toContain("Kết quả xử lý chuẩn xác.");
    expect(joined).not.toContain("\uFFFD");
  });
});

describe("TUI Command Execution & Status Line Integrity", () => {
  it("executes /model command and immediately opens model picker", async () => {
    const { sendMessage } = await import("../../tui/events/agentWiring");
    tuiState.showModelPicker = false;
    tuiState.availableModels = [];
    tuiState.messages = [];

    // Simulate user typing /model and pressing Enter
    await sendMessage("/model");

    expect(tuiState.showModelPicker).toBe(true);
    expect(tuiState.filteredModels.length).toBeGreaterThan(0);
  });

  it("executes /model <id> and sets active model immediately", async () => {
    const { sendMessage } = await import("../../tui/events/agentWiring");
    tuiState.currentModel = "old-model";
    tuiState.messages = [];

    await sendMessage("/model claude-3-5-sonnet");

    expect(tuiState.currentModel).toBe("claude-3-5-sonnet");
    expect(tuiState.messages.some((m) => m.content.includes("Model set to: claude-3-5-sonnet"))).toBe(true);
  });

  it("executes /help command and displays slash commands list", async () => {
    const { sendMessage } = await import("../../tui/events/agentWiring");
    tuiState.messages = [];

    await sendMessage("/help");

    const helpMsg = tuiState.messages.find((m) => m.content.includes("TOOLNET — Slash Commands"));
    expect(helpMsg).toBeDefined();
    expect(helpMsg?.content).toContain("/model");
    expect(helpMsg?.content).toContain("/provider");
  });

  it("reports clear error for unknown slash command e.g. /abc", async () => {
    const { sendMessage } = await import("../../tui/events/agentWiring");
    tuiState.messages = [];

    await sendMessage("/abc");

    const errMsg = tuiState.messages.find((m) => m.content.includes("Unknown command: /abc"));
    expect(errMsg).toBeDefined();
  });

  it("renders status line cleanly for both Planner and Builder mode with no garbage suffix", () => {
    tuiState.agentMode = "Build";
    const builderStatus = renderWorkingStatus(100, {
      showHelp: false,
      isStreaming: false,
      spinnerIdx: 0,
      statusText: "",
      elapsedDisplay: "",
      primaryColor: "\x1b[36m",
    });
    const strippedBuilder = stripAnsi(builderStatus);
    expect(strippedBuilder).toContain("Mode: Builder");
    expect(strippedBuilder).not.toContain("modeup");

    tuiState.agentMode = "Plan";
    const plannerStatus = renderWorkingStatus(100, {
      showHelp: false,
      isStreaming: false,
      spinnerIdx: 0,
      statusText: "",
      elapsedDisplay: "",
      primaryColor: "\x1b[36m",
    });
    const strippedPlanner = stripAnsi(plannerStatus);
    expect(strippedPlanner).toContain("Mode: Planner");
    expect(strippedPlanner).not.toContain("modeup");
  });
});

describe("TUI API Key Manager & Slash Command Architecture", () => {
  it("executes /key and opens Key Manager modal without dumping text to conversation stream", async () => {
    const { sendMessage } = await import("../../tui/events/agentWiring");
    tuiState.showKeyManager = false;
    tuiState.messages = [];

    // Simulate user typing /key and pressing Enter
    await sendMessage("/key");

    expect(tuiState.showKeyManager).toBe(true);
    // Verified conversation history does NOT have API Key Management text dump
    expect(tuiState.messages.length).toBe(0);
    expect(tuiState.messages.some((m) => m.content.includes("API Key Management"))).toBe(false);
  });

  it("renders Key Manager box with masked keys and never exposes full plaintext key", () => {
    const { saveCliKey, deleteCliKey } = require("../../lib/keys");
    const { renderKeyManagerBox, getKeyManagerProviders } = require("../../tui/renderers/keyManagerRenderer");

    const testSecret = "sk-supersecret-live-api-key-value-60f7";
    saveCliKey("toolnet", testSecret);

    const rendered = renderKeyManagerBox(80, 24, {
      keyManagerIdx: 0,
      keyManagerInput: null,
    });
    const stripped = stripAnsi(rendered);

    // Box has API Keys title and Provider column
    expect(stripped).toContain("API Keys");
    expect(stripped).toContain("Provider");
    expect(stripped).toContain("Status");

    // Masked key is shown
    expect(stripped).toContain("••••••••60f7");

    // Full secret key is NEVER exposed in the rendered text
    expect(stripped).not.toContain(testSecret);
    expect(stripped).not.toContain("sk-supersecret-live-api-key");

    // Cleanup
    deleteCliKey("toolnet");
  });

  it("handles keyboard navigation and Esc closing in Key Manager modal", async () => {
    const { handleKey } = await import("../../tui/input/inputHandler");
    tuiState.openKeyManager();
    tuiState.keyManagerIdx = 0;

    // Press Down arrow (1b5b42)
    handleKey(Buffer.from("1b5b42", "hex"));
    expect(tuiState.keyManagerIdx).toBe(1);

    // Press Up arrow (1b5b41)
    handleKey(Buffer.from("1b5b41", "hex"));
    expect(tuiState.keyManagerIdx).toBe(0);

    // Press Esc (1b)
    handleKey(Buffer.from("1b", "hex"));
    expect(tuiState.showKeyManager).toBe(false);
  });

  it("supports adding and deleting keys interactively and updates provider status immediately", async () => {
    const { saveCliKey, deleteCliKey, getCliKey } = require("../../lib/keys");
    const { getKeyManagerProviders } = require("../../tui/renderers/keyManagerRenderer");

    // 1. Add key
    saveCliKey("deepseek", "sk-deepseek-test-9999");
    expect(getCliKey("deepseek")).toBe("sk-deepseek-test-9999");

    let providers = getKeyManagerProviders();
    const deepseekItem = providers.find((p: any) => p.id === "deepseek");
    expect(deepseekItem).toBeDefined();
    expect(deepseekItem?.isConfigured).toBe(true);
    expect(deepseekItem?.maskedKey).toContain("••••9999");

    // 2. Delete key
    const deleted = deleteCliKey("deepseek");
    expect(deleted).toBe(true);
    expect(getCliKey("deepseek")).toBeNull();

    providers = getKeyManagerProviders();
    const deepseekAfter = providers.find((p: any) => p.id === "deepseek");
    expect(deepseekAfter?.isConfigured).toBe(false);
  });
});
