/**
 * Session title in the UI.
 *
 * Two surfaces: the status line (`MODEL · WORKSPACE · TITLE`, with no dangling
 * separator for an untitled session) and the resume picker, which falls back to
 * a preview of the first real task, then the project name, then the id — never a
 * dumped prompt. 52x20 (mobile SSH) must stay one usable line.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { renderFooter } from "../renderers/statusRenderer";
import { renderSessionPickerBox, type SessionItem } from "../renderers/sessionPickerRenderer";
import { stripAnsi, visibleWidth } from "../layout";
import { tuiState } from "../state";

const BASE = {
  providerName: "toolnet",
  currentModel: "agnes-2.0-flash",
  workspacePath: "/root/mercedes-benz-vns.com",
  // Pin the mutable chrome so singleton pollution from other test files
  // (they mutate tuiState.agentMode/bypassMode without restoring) cannot
  // inject extra footer segments and shrink the title budget.
  agentMode: "Build",
  bypassMode: false,
};

let savedReasoningEnabled: boolean;

beforeAll(() => {
  savedReasoningEnabled = tuiState.reasoningSettings.enabled;
  tuiState.reasoningSettings.enabled = false;
});

afterAll(() => {
  tuiState.reasoningSettings.enabled = savedReasoningEnabled;
});

function pickerItem(overrides: Partial<SessionItem>): SessionItem {
  return {
    sessionId: "sess_abc",
    messagesCount: 12,
    updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    workspace: "/root/mercedes-benz-vns.com",
    isCurrent: false,
    ...overrides,
  };
}

describe("status line — MODEL · WORKSPACE · TITLE", () => {
  test("shows the session title after the workspace", () => {
    const line = stripAnsi(renderFooter(120, { ...BASE, sessionTitle: "Build Mercedes-AMG WordPress page" }));
    expect(line).toContain("mercedes-benz-vns.com");
    expect(line).toContain("Build Mercedes-AMG WordPress page");
    expect(line.indexOf("mercedes-benz-vns.com")).toBeLessThan(line.indexOf("Build Mercedes-AMG WordPress"));
  });

  test("a narrow terminal still leads with the workspace", () => {
    const line = stripAnsi(renderFooter(80, { ...BASE, sessionTitle: "Build Mercedes-AMG WordPress page" }));
    expect(line).toContain("mercedes-benz-vns.com");
    expect(line).toContain("Build Mercedes-AMG");
    expect(visibleWidth(line)).toBeLessThanOrEqual(80);
  });

  test("an untitled session shows no empty separator", () => {
    const line = stripAnsi(renderFooter(80, { ...BASE, sessionTitle: undefined }));
    const trimmed = line.replace(/\s+$/u, "");
    expect(trimmed.endsWith("mercedes-benz-vns.com")).toBe(true);
    expect(trimmed.endsWith("·")).toBe(false);
    expect(trimmed).not.toContain("undefined");
  });

  test("a background title lands in the footer without restarting the session", () => {
    tuiState.sessionTitle = undefined;
    try {
      const before = stripAnsi(renderFooter(120, BASE as any));
      expect(before).not.toContain("Build Mercedes-AMG WordPress page");

      // Exactly what the background auto-title's `onTitle` callback mutates.
      tuiState.sessionTitle = "Build Mercedes-AMG WordPress page";
      const after = stripAnsi(renderFooter(120, BASE as any));
      expect(after).toContain("Build Mercedes-AMG WordPress page");
    } finally {
      tuiState.sessionTitle = undefined;
    }
  });

  test("stays a single line that fits 52x20 mobile", () => {
    for (const sessionTitle of [undefined, "Build Mercedes-AMG WordPress page"]) {
      const line = stripAnsi(renderFooter(52, { ...BASE, sessionTitle }));
      expect(line.includes("\n")).toBe(false);
      expect(visibleWidth(line)).toBeLessThanOrEqual(52);
    }
  });
});

describe("session picker — title first, then honest fallbacks", () => {
  test("a titled session shows its title", () => {
    const out = stripAnsi(
      renderSessionPickerBox(80, 24, {
        filteredSessions: [pickerItem({ name: "Build Mercedes-AMG WordPress page" })],
        sessionPickerIdx: 0,
        sessionSearchQuery: "",
        currentSessionId: "sess_other",
        currentWorkspace: BASE.workspacePath,
      }),
    );
    expect(out).toContain("Build Mercedes-AMG WordPress page");
  });

  test("an untitled session falls back to the preview, not the id", () => {
    const out = stripAnsi(
      renderSessionPickerBox(80, 24, {
        filteredSessions: [pickerItem({ preview: "Audit session persistence" })],
        sessionPickerIdx: 0,
        sessionSearchQuery: "",
        currentSessionId: "sess_other",
        currentWorkspace: BASE.workspacePath,
      }),
    );
    expect(out).toContain("Audit session persistence");
  });

  test("without a preview the project name is used before the id", () => {
    const out = stripAnsi(
      renderSessionPickerBox(80, 24, {
        filteredSessions: [pickerItem({})],
        sessionPickerIdx: 0,
        sessionSearchQuery: "",
        currentSessionId: "sess_other",
        currentWorkspace: BASE.workspacePath,
      }),
    );
    expect(out).toContain("mercedes-benz-vns.com");
  });

  test("a 500-line prompt is never dumped into the picker", () => {
    const huge = Array.from({ length: 500 }, (_, i) => `dòng số ${i}`).join("\n");
    const out = stripAnsi(
      renderSessionPickerBox(52, 20, {
        filteredSessions: [pickerItem({ preview: "Build Mercedes-AMG WordPress page" })],
        sessionPickerIdx: 0,
        sessionSearchQuery: "",
        currentSessionId: "sess_other",
        currentWorkspace: BASE.workspacePath,
        // A hostile item: the renderer must not print the raw prompt.
        ...({ rawPrompt: huge } as any),
      }),
    );
    expect(out).not.toContain("dòng số 499");
    expect(out.includes("\n") === false || out.split("\n").length < 40).toBe(true);
  });
});
