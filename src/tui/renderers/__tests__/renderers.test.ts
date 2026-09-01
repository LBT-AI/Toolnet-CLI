import { describe, it, expect } from "bun:test";
import { renderHeader } from "../headerRenderer";
import { renderChatMessages } from "../chatRenderer";
import { renderSidebar } from "../sidebarRenderer";
import { renderWorkingStatus, renderInputArea, renderFooter } from "../statusRenderer";
import { renderConfirmationModal, renderToast } from "../modalRenderer";
import { renderModelPickerBox } from "../modelPickerRenderer";
import { renderKeyManagerBox } from "../keyManagerRenderer";
import { renderSkillsPickerBox } from "../skillsPickerRenderer";
import { renderQueueManagerBox } from "../queueManagerRenderer";
import { renderQueuedMessagesPreview } from "../queuePreviewRenderer";
import { renderSessionPickerBox } from "../sessionPickerRenderer";
import { renderSuggestionsPopup } from "../suggestRenderer";
import { stripAnsi } from "../../layout";

describe("TUI Renderers Unit Tests", () => {
  it("renderHeader renders title, mode badge, and status without ANSI overflow", () => {
    const output = renderHeader(80, {
      agentMode: "Build",
      bypassMode: false,
      bypassLevel: "lite",
      statusText: "Ready",
      isStreaming: false,
    });
    expect(output).toBeString();
    expect(output).toContain("ToolNet CLI");
    expect(output).toContain("Build");
  });

  it("renderHeader renders Plan mode and Bypass mode badges accurately", () => {
    const planHeader = renderHeader(100, {
      agentMode: "Plan",
      bypassMode: false,
      bypassLevel: "lite",
      statusText: "Planning checklist",
      isStreaming: true,
    });
    expect(planHeader).toContain("Plan");

    const bypassHeader = renderHeader(100, {
      agentMode: "Build",
      bypassMode: true,
      bypassLevel: "godmode",
      statusText: "Active",
      isStreaming: false,
    });
    expect(bypassHeader).toContain("GODMODE");
  });

  it("renderChatMessages renders empty conversation gracefully", () => {
    const output = renderChatMessages([], 80, "\x1b[36m", false);
    expect(output).toBeArray();
    expect(output.length).toBe(0);
  });

  it("renderChatMessages formats user, assistant, system messages", () => {
    const msgs = [
      { role: "user" as const, content: "Hello ToolNet!" },
      { role: "assistant" as const, content: "Hello! How can I help you today?" },
      { role: "system" as const, content: "Mode switched" },
    ];
    const output = renderChatMessages(msgs, 80, "\x1b[36m", false);
    const joined = stripAnsi(output.join("\n"));
    expect(joined).toContain("Hello ToolNet!");
    expect(joined).toContain("How can I help you today?");
  });

  it("renderSidebar formats token usage and model information", () => {
    const output = renderSidebar("openai/gpt-4o", Date.now(), 40);
    expect(output).toBeArray();
    expect(output.length).toBeGreaterThan(0);
    const text = stripAnsi(output.join("\n"));
    expect(text).toContain("Token & Usage Metrics");
  });

  it("renderWorkingStatus renders single-line status without overflow", () => {
    const line = renderWorkingStatus(80, {
      showHelp: false,
      isStreaming: true,
      spinnerIdx: 0,
      statusText: "Executing tool: bash...",
      elapsedDisplay: "1.2s",
      primaryColor: "\x1b[36m",
    });
    expect(line).toBeString();
    expect(line).toContain("Executing tool: bash...");
    expect(line).toContain("1.2s");
  });

  it("renderInputArea renders prompt cursor and text", () => {
    const line = renderInputArea(80, "test prompt", "\x1b[36m");
    expect(line).toBeString();
    expect(line).toContain("test prompt");
  });

  it("renderFooter renders provider, model, and workspace info", () => {
    const line = renderFooter(100, {
      providerName: "OpenAI",
      currentModel: "gpt-4o",
      workspacePath: "/root/toolnet-cli",
    });
    expect(line).toBeString();
    expect(line).toContain("OpenAI");
    expect(line).toContain("gpt-4o");
  });

  it("renderConfirmationModal renders prompt and decision options", () => {
    const modal = renderConfirmationModal(80, 24, {
      prompt: "Allow bash execution?",
      resolve: () => {},
    });
    expect(modal).toBeArray();
    const joined = stripAnsi(modal.join("\n"));
    expect(joined).toContain("Security Approval Required");
    expect(joined).toContain("[Y] Once");
    expect(joined).toContain("[N] Deny");
  });

  it("renderToast renders centered notification badge", () => {
    const toast = renderToast(80, "Settings saved");
    expect(toast).toBeArray();
    const joined = stripAnsi(toast.join(""));
    expect(joined).toContain("Settings saved");
  });

  it("renderModelPickerBox renders model list and selection indicator", () => {
    const box = renderModelPickerBox(80, 24, {
      filteredModels: ["gpt-4o", "claude-3-5-sonnet", "gemini-2.0-flash"],
      modelPickerIdx: 1,
      currentModel: "claude-3-5-sonnet",
      modelSearchQuery: "",
    });
    const stripped = stripAnsi(box);
    expect(stripped).toContain("Select Model");
    expect(stripped).toContain("gpt-4o");
    expect(stripped).toContain("claude-3-5-sonnet");
  });

  it("renderKeyManagerBox renders list, input, and delete confirm modes", () => {
    const listMode = renderKeyManagerBox(80, 24, {
      keyManagerIdx: 0,
      keyManagerInput: null,
      keyManagerConfirmDelete: null,
    });
    const strippedList = stripAnsi(listMode);
    expect(strippedList).toContain("API Keys");
    expect(strippedList).toContain("Provider");
    expect(strippedList).toContain("Status");

    const inputMode = renderKeyManagerBox(80, 24, {
      keyManagerIdx: 0,
      keyManagerInput: { provider: "openai", buffer: "sk-test1234" },
      keyManagerConfirmDelete: null,
    });
    const strippedInput = stripAnsi(inputMode);
    expect(strippedInput).toContain("Enter API Key");
    expect(strippedInput).toContain("••••••••");

    const deleteMode = renderKeyManagerBox(80, 24, {
      keyManagerIdx: 0,
      keyManagerInput: null,
      keyManagerConfirmDelete: "openai",
    });
    const strippedDelete = stripAnsi(deleteMode);
    expect(strippedDelete).toContain("Delete");
  });

  it("renderSuggestionsPopup renders command suggestions list", () => {
    const popup = renderSuggestionsPopup(
      80,
      10,
      [
        { name: "/model", desc: "Select model" },
        { name: "/provider", desc: "Manage providers" },
      ],
      0,
      "\x1b[36m"
    );
    expect(popup).toBeArray();
    const stripped = stripAnsi(popup.join("\n"));
    expect(stripped).toContain("/model");
    expect(stripped).toContain("/provider");
  });

  it("renderSkillsPickerBox renders skills list and detail views", () => {
    const listBox = renderSkillsPickerBox(80, 24, {
      filteredSkills: [
        {
          id: "autocad-drafting",
          name: "autocad-drafting",
          description: "AutoCAD 2D/3D drafting",
          source: "toolnet",
          instructions: "Draft AIA standard drawings",
          enabled: true,
        },
        {
          id: "my-custom-skill",
          name: "My Custom Skill",
          description: "Workspace local skill",
          source: "workspace",
          instructions: "Custom workflow",
          enabled: false,
        },
      ],
      skillsPickerIdx: 0,
      skillsSearchQuery: "",
      selectedSkillDetail: null,
    });
    const strippedList = stripAnsi(listBox);
    expect(strippedList).toContain("Skills (2 skills)");
    expect(strippedList).toContain("autocad-drafting");
    expect(strippedList).toContain("my-custom-skill");
    expect(strippedList).toContain("workspace");
    expect(strippedList).toContain("toolnet");

    const detailBox = renderSkillsPickerBox(80, 24, {
      filteredSkills: [],
      skillsPickerIdx: 0,
      skillsSearchQuery: "",
      selectedSkillDetail: {
        id: "autocad-drafting",
        name: "autocad-drafting",
        description: "AutoCAD 2D/3D drafting",
        source: "toolnet",
        filepath: undefined,
        instructions: "Draft AIA standard drawings",
        enabled: true,
      },
    });
    const strippedDetail = stripAnsi(detailBox);
    expect(strippedDetail).toContain("Skill: autocad-drafting");
    expect(strippedDetail).toContain("Enabled");
    expect(strippedDetail).toContain("Draft AIA standard drawings");
  });

  it("renderQueueManagerBox and renderQueuedMessagesPreview render accurately", () => {
    const preview = renderQueuedMessagesPreview(80, [
      { id: "1", text: "First task in queue", timestamp: Date.now() },
      { id: "2", text: "Second task in queue", timestamp: Date.now() },
    ]);
    const strippedPreview = stripAnsi(preview);
    expect(strippedPreview).toContain("2 queued messages");
    expect(strippedPreview).toContain("First task in queue");
    expect(strippedPreview).toContain("Second task in queue");

    const queueBox = renderQueueManagerBox(80, 24, {
      queue: [
        { id: "1", text: "First task", timestamp: Date.now() },
        { id: "2", text: "Second task", timestamp: Date.now() },
      ],
      queueIdx: 0,
      editing: null,
    });
    const strippedQueueBox = stripAnsi(queueBox);
    expect(strippedQueueBox).toContain("Queue (2 tasks)");
    expect(strippedQueueBox).toContain("1. First task");
    expect(strippedQueueBox).toContain("2. Second task");
    expect(strippedQueueBox).toContain("Ctrl+↑/↓ Reorder");
  });

  it("renderSessionPickerBox renders sessions list and metadata accurately", () => {
    const sessionBox = renderSessionPickerBox(90, 20, {
      filteredSessions: [
        {
          sessionId: "sess_1234567890_abc",
          model: "openai/gpt-4o",
          provider: "toolnet",
          messagesCount: 8,
          updatedAt: new Date(Date.now() - 60000).toISOString(),
          isCurrent: true,
          workspace: "/root/toolnet-cli",
        },
        {
          sessionId: "sess_9876543210_xyz",
          model: "anthropic/claude-3-5-sonnet",
          provider: "anthropic",
          messagesCount: 3,
          updatedAt: new Date(Date.now() - 3600000).toISOString(),
          isCurrent: false,
          workspace: "/root/other-project",
        },
      ],
      sessionPickerIdx: 0,
      sessionSearchQuery: "",
      currentSessionId: "sess_1234567890_abc",
      currentWorkspace: "/root/toolnet-cli",
    });
    const stripped = stripAnsi(sessionBox);
    expect(stripped).toContain("Sessions (2 sessions)");
    expect(stripped).toContain("sess_1234567890_abc");
    expect(stripped).toContain("(current)");
    expect(stripped).toContain("toolnet/openai/gpt-4o");
    expect(stripped).toContain("8 msgs");
    expect(stripped).toContain("sess_9876543210_xyz");
    expect(stripped).toContain("root/other-project");
    expect(stripped).toContain("Enter Resume");
    expect(stripped).toContain("D Delete");
  });
});
