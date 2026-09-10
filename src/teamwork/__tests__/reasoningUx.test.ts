/**
 * Thinking/Reasoning UX regression tests.
 *
 * Capability-aware: the provider API's model metadata is the source of truth.
 * Nothing is guessed from model names, no fabricated thinking for models that
 * do not reason.
 *
 * Covers:
 * - applyReasoningOptions guard chain (non-reasoning / disabled / no-effort /
 *   auto → request untouched)
 * - capability cache (setModelCapabilities → supportsReasoning / Effort)
 * - /reasoning command (no args help, unknown value, valid values, unsupported
 *   model keeps settings)
 * - renderReasoningPanel (expanded box, collapsed line, CJK safety, no panel
 *   when there is no content)
 * - palette still has exactly 38 commands (single registry)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { ChatRequest } from "../../providers/types";
import {
  applyReasoningOptions,
  setModelCapabilities,
  supportsReasoning,
  supportsReasoningEffort,
  getModelCapabilities,
  reasoningEffortLabel,
  DEFAULT_REASONING_SETTINGS,
} from "../../lib/reasoning";
import { reasoningCommand } from "../../commands/reasoning";
import { getAllCommands } from "../../commands";
import { renderReasoningPanel } from "../../tui/renderers/reasoningPanel";
import { visibleWidth, stripAnsi } from "../../tui/layout";
import { tuiState } from "../../tui/state";

// ---- Test fixture: three models with distinct capabilities ----

const FIXTURE_MODELS = [
  { id: "plain-model", capabilities: undefined },
  { id: "reasoner", capabilities: { reasoning: true, reasoningEffort: true } },
  { id: "reasoner-fixed", capabilities: { reasoning: true, reasoningEffort: false } },
];

function baseRequest(): ChatRequest {
  return {
    model: "reasoner",
    messages: [{ role: "user", content: "hi" }],
  };
}

describe("Reasoning UX — capability cache", () => {
  beforeEach(() => {
    setModelCapabilities(FIXTURE_MODELS as any);
  });

  it("indexes capabilities from provider model metadata (source of truth)", () => {
    expect(supportsReasoning("reasoner")).toBe(true);
    expect(supportsReasoning("reasoner-fixed")).toBe(true);
    expect(supportsReasoning("plain-model")).toBe(false);
    expect(supportsReasoning("unknown-model")).toBe(false);
    expect(getModelCapabilities("reasoner")).toEqual({ reasoning: true, reasoningEffort: true });
  });

  it("reasoningEffort is only true when the model declares it", () => {
    expect(supportsReasoningEffort("reasoner")).toBe(true);
    expect(supportsReasoningEffort("reasoner-fixed")).toBe(false);
    expect(supportsReasoningEffort("plain-model")).toBe(false);
  });

  it("never guesses from the model id (no includes() substring logic)", () => {
    // Even a model whose NAME suggests thinking must not report capabilities
    // unless the API metadata says so.
    expect(supportsReasoning("gpt-omni-thinking-ultra")).toBe(false);
    expect(supportsReasoning("deepseek-reasoner")).toBe(false);
  });
});

describe("Reasoning UX — applyReasoningOptions guard chain", () => {
  beforeEach(() => {
    setModelCapabilities(FIXTURE_MODELS as any);
  });

  it("returns the request untouched for models without reasoning", () => {
    const req = baseRequest();
    const out = applyReasoningOptions(req, "plain-model", DEFAULT_REASONING_SETTINGS);
    expect(out).toBe(req);
    expect((out as any).reasoningEffort).toBeUndefined();
  });

  it("returns untouched when reasoning is disabled (/reasoning off)", () => {
    const req = baseRequest();
    const out = applyReasoningOptions(req, "reasoner", { enabled: false, effort: "auto" });
    expect(out).toBe(req);
  });

  it("returns untouched when the model cannot configure effort", () => {
    const req = baseRequest();
    const out = applyReasoningOptions(req, "reasoner-fixed", { enabled: true, effort: "high" });
    expect(out).toBe(req);
  });

  it("returns untouched on 'auto' (let the adapter decide)", () => {
    const req = baseRequest();
    const out = applyReasoningOptions(req, "reasoner", DEFAULT_REASONING_SETTINGS);
    expect(out).toBe(req);
  });

  it("adds reasoningEffort only when everything is supported and enabled", () => {
    const req = baseRequest();
    const out = applyReasoningOptions(req, "reasoner", { enabled: true, effort: "high" });
    expect(out).not.toBe(req);
    expect(out.reasoningEffort).toBe("high");
  });

  it("explicit low/medium/high pass through verbatim", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      const out = applyReasoningOptions(baseRequest(), "reasoner", { enabled: true, effort });
      expect(out.reasoningEffort).toBe(effort);
    }
  });
});

describe("Reasoning UX — /reasoning command", () => {
  beforeEach(() => {
    setModelCapabilities(FIXTURE_MODELS as any);
    tuiState.currentModel = "reasoner";
    tuiState.reasoningSettings = { ...DEFAULT_REASONING_SETTINGS };
  });

  function makeCtx() {
    const messages: Array<{ role: string; content: string }> = [];
    return {
      messages,
      ctx: {
        addMessage: (role: string, content: string) => messages.push({ role, content }),
        setStatusMsg: () => {},
        setReasoningEffort: (effort: "auto" | "low" | "medium" | "high" | "off") => {
          const { supportsReasoningEffort } = require("../../lib/reasoning");
          if (!supportsReasoningEffort(tuiState.currentModel) && effort !== "off") return false;
          if (effort === "off") tuiState.reasoningSettings = { enabled: false, effort: "auto" };
          else if (effort === "auto") tuiState.reasoningSettings = { enabled: true, effort: "auto" };
          else tuiState.reasoningSettings = { enabled: true, effort };
          return true;
        },
        getReasoningStatus: () => {
          const s = tuiState.reasoningSettings;
          if (!s.enabled) return "off";
          return s.effort === "auto" ? "auto (model default)" : s.effort;
        },
      } as any,
    };
  }

  it("no args shows usage help and current setting", async () => {
    const { messages, ctx } = makeCtx();
    await reasoningCommand.handler([], ctx);
    const joined = messages.map((m) => m.content).join("\n");
    expect(joined).toContain("/reasoning auto");
    expect(joined).toContain("/reasoning off");
    expect(joined).toContain("Current: auto (model default)");
  });

  it("applies valid effort values", async () => {
    const { ctx } = makeCtx();
    await reasoningCommand.handler(["high"], ctx);
    expect(tuiState.reasoningSettings).toEqual({ enabled: true, effort: "high" });
    await reasoningCommand.handler(["off"], ctx);
    expect(tuiState.reasoningSettings).toEqual({ enabled: false, effort: "auto" });
    await reasoningCommand.handler(["auto"], ctx);
    expect(tuiState.reasoningSettings).toEqual({ enabled: true, effort: "auto" });
  });

  it("rejects unknown values without touching settings", async () => {
    const { messages, ctx } = makeCtx();
    await reasoningCommand.handler(["turbo"], ctx);
    expect(messages.map((m) => m.content).join("\n")).toContain("Unknown reasoning level 'turbo'");
    expect(tuiState.reasoningSettings).toEqual({ ...DEFAULT_REASONING_SETTINGS });
  });

  it("unsupported model reports non-configurable without crashing and keeps settings", async () => {
    tuiState.currentModel = "plain-model";
    const { messages, ctx } = makeCtx();
    await reasoningCommand.handler(["high"], ctx);
    expect(tuiState.reasoningSettings).toEqual({ ...DEFAULT_REASONING_SETTINGS });
    expect(messages.map((m) => m.content).join("\n")).toContain(
      "This model does not support configurable reasoning"
    );
  });

  it("reasoningEffortLabel reflects enabled/disabled state", () => {
    expect(reasoningEffortLabel({ enabled: true, effort: "auto" })).toBe("auto");
    expect(reasoningEffortLabel({ enabled: true, effort: "high" })).toBe("high");
    expect(reasoningEffortLabel({ enabled: false, effort: "auto" })).toBe("off");
  });
});

describe("Reasoning UX — thinking panel renderer", () => {
  it("renders nothing when there is no reasoning content and not collapsed", () => {
    const lines = renderReasoningPanel(80, {
      text: "",
      elapsed: "",
      effort: "auto",
      collapsed: false,
      tokens: 0,
    });
    expect(lines.length).toBe(0);
  });

  it("expanded panel shows header, content and token count within width", () => {
    const lines = renderReasoningPanel(80, {
      text: "Analyzing project structure...\nChecking provider configuration...",
      elapsed: "4.8s",
      effort: "high",
      collapsed: false,
      tokens: 1240,
    });
    const joined = stripAnsi(lines.join("")).replace(/\r/g, "");
    expect(joined).toContain("Thinking");
    expect(joined).toContain("4.8s");
    expect(joined).toContain("high");
    expect(joined).toContain("1,240 tokens");
    expect(joined).toContain("Analyzing project structure");
    // every rendered line fits inside the terminal width
    for (const raw of lines) {
      expect(visibleWidth(stripAnsi(raw).replace(/\r/g, ""))).toBeLessThanOrEqual(80);
    }
  });

  it("CJK reasoning text renders without overflowing (2 cells per char)", () => {
    const lines = renderReasoningPanel(60, {
      text: "分析项目结构，然后检查配置。",
      elapsed: "2.1s",
      effort: "auto",
      collapsed: false,
      tokens: 512,
    });
    expect(lines.length).toBeGreaterThan(0);
    for (const raw of lines) {
      expect(visibleWidth(stripAnsi(raw).replace(/\r/g, ""))).toBeLessThanOrEqual(60);
    }
  });

  it("collapsed panel renders a single ▶ line with metadata", () => {
    const lines = renderReasoningPanel(80, {
      text: "long reasoning content...",
      elapsed: "4.8s",
      effort: "high",
      collapsed: true,
      tokens: 1240,
    });
    const joined = stripAnsi(lines.join("")).replace(/\r/g, "");
    expect(joined).toContain("▶");
    expect(joined).toContain("Thinking");
    expect(joined).toContain("4.8s");
    expect(joined).toContain("1,240 tokens");
    expect(joined).not.toContain("long reasoning content");
  });

  it("collapsed with NO content still shows the status line (metadata only)", () => {
    const lines = renderReasoningPanel(80, {
      text: "",
      elapsed: "3.3s",
      effort: "low",
      collapsed: true,
      tokens: 0,
    });
    const joined = stripAnsi(lines.join("")).replace(/\r/g, "");
    expect(joined).toContain("▶");
    expect(joined).toContain("Thinking");
  });
});

describe("Reasoning UX — registry integration", () => {
  it("palette exposes exactly 38 commands including /reasoning", () => {
    const all = getAllCommands();
    expect(all.length).toBe(38);
    expect(all.some((c) => c.name === "reasoning")).toBe(true);
    const r = all.find((c) => c.name === "reasoning")!;
    expect(r.aliases).toContain("reason");
    expect(r.aliases).toContain("think");
  });
});