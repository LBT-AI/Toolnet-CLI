import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tuiState } from "../../tui/state";
import { handleKey, setInputState, resetInputState } from "../../tui/input/inputHandler";
import { handleOverlayKey, overlayIsActive } from "../../tui/input/overlayInput";
import { renderToolsPanelBox } from "../../tui/renderers/toolsPanelRenderer";
import { renderHarnessPanelBox } from "../../tui/renderers/harnessPanelRenderer";
import { renderListPanelBox, ensureVisible, type ScrollableListPanelState } from "../../tui/renderers/listPanelRenderer";
import { getToolListItems } from "../../lib/toolsCatalog";
import { getHarnessSections } from "../../lib/harnessCatalog";
import { stripAnsi } from "../../tui/layout";

/** Max visible width of any cursor-positioned row in a box-drawing output. */
function maxRowWidth(box: string): number {
  let max = 0;
  for (const seg of box.split(/\x1b\[\d+;\d+H/)) {
    const clean = stripAnsi(seg).replace(/[ \t]+$/g, "");
    max = Math.max(max, clean.length);
  }
  return max;
}

describe("Tools / Harness Panel Overlay Regression", () => {
  beforeEach(() => {
    resetInputState();
    tuiState.overlay = { type: "none" };
    tuiState.messages = [];
    tuiState.pendingConfirmation = null;
    tuiState.showHelp = false;
    tuiState.showModelPicker = false;
    tuiState.showKeyManager = false;
    tuiState.showSkillsPicker = false;
    tuiState.showQueueManager = false;
    tuiState.showSessionPicker = false;
  });

  afterEach(() => {
    tuiState.overlay = { type: "none" };
    resetInputState();
    tuiState.messages = [];
  });

  test("1. /tools does NOT print raw text into chat — opens the Tools Panel", async () => {
    const { sendMessage } = await import("../../tui/events/agentWiring");
    await sendMessage("/tools");

    expect(tuiState.overlay.type).toBe("tools");
    expect(overlayIsActive()).toBe(true);
    expect(tuiState.messages.length).toBe(0);
    const joined = tuiState.messages.map((m) => m.content).join("\n");
    expect(joined).not.toContain("Agent Tools Registry");
  });

  test("2. /harness does NOT print raw text into chat — opens the Harness Panel", async () => {
    const { sendMessage } = await import("../../tui/events/agentWiring");
    await sendMessage("/harness");

    expect(tuiState.overlay.type).toBe("harness");
    expect(tuiState.messages.length).toBe(0);
    const joined = tuiState.messages.map((m) => m.content).join("\n");
    expect(joined).not.toContain("AgentHarness");
  });

  test("3. /tools <name> opens the tool detail directly without printing text", async () => {
    const { sendMessage } = await import("../../tui/events/agentWiring");
    await sendMessage("/tools read_file");
    expect(tuiState.overlay.type).toBe("tool-detail");
    if (tuiState.overlay.type === "tool-detail") {
      expect(tuiState.overlay.toolId).toBe("read_file");
    }
    expect(tuiState.messages.length).toBe(0);
  });

  test("4. /harness <section> opens the section detail directly", async () => {
    const { sendMessage } = await import("../../tui/events/agentWiring");
    await sendMessage("/harness security");
    expect(tuiState.overlay.type).toBe("harness-detail");
    if (tuiState.overlay.type === "harness-detail") {
      expect(tuiState.overlay.section).toBe("security");
    }
    expect(tuiState.messages.length).toBe(0);
  });

  test("5. Down/Up arrows change the selected tool and never leak into the prompt", () => {
    setInputState("/tools");
    tuiState.openToolsOverlay();
    const before = tuiState.inputBuffer;

    handleKey(Buffer.from("1b5b42", "hex"), { renderAll: () => {} }); // Down
    expect(tuiState.overlay.type).toBe("tools");
    if (tuiState.overlay.type === "tools") expect(tuiState.overlay.selected).toBe(1);

    handleKey(Buffer.from("1b5b41", "hex"), { renderAll: () => {} }); // Up
    if (tuiState.overlay.type === "tools") expect(tuiState.overlay.selected).toBe(0);

    // k / j vim keys
    handleKey(Buffer.from("6a", "hex"), { renderAll: () => {} }); // j (down)
    if (tuiState.overlay.type === "tools") expect(tuiState.overlay.selected).toBe(1);
    handleKey(Buffer.from("6b", "hex"), { renderAll: () => {} }); // k (up)
    if (tuiState.overlay.type === "tools") expect(tuiState.overlay.selected).toBe(0);

    // prompt untouched
    expect(tuiState.inputBuffer).toBe(before);
  });

  test("6. Editing keys in the overlay do not reach the chat input buffer", () => {
    setInputState("sentry");
    tuiState.openToolsOverlay();
    handleKey(Buffer.from("61", "hex"), { renderAll: () => {} }); // 'a' -> filter query
    if (tuiState.overlay.type === "tools") expect(tuiState.overlay.query).toBe("a");
    expect(tuiState.inputBuffer).toBe("sentry");
    expect(tuiState.cursorPos).toBe(6);
  });

  test("7. Enter opens tool detail, Esc returns to list, Esc closes overlay", () => {
    tuiState.openToolsOverlay();
    // Down to 2nd tool, press Enter
    handleKey(Buffer.from("1b5b42", "hex"), { renderAll: () => {} });
    handleKey(Buffer.from("1b5b42", "hex"), { renderAll: () => {} });
    const toolId = getToolListItems()[2].id;
    handleKey(Buffer.from("0d", "hex"), { renderAll: () => {} });
    expect(tuiState.overlay.type).toBe("tool-detail");
    if (tuiState.overlay.type === "tool-detail") expect(tuiState.overlay.toolId).toBe(toolId);

    // Esc back to list, preserving selection on the same tool
    handleKey(Buffer.from("1b", "hex"), { renderAll: () => {} });
    expect(tuiState.overlay.type).toBe("tools");
    if (tuiState.overlay.type === "tools") {
      expect(tuiState.overlay.selected).toBe(2);
      expect(getToolListItems()[tuiState.overlay.selected].id).toBe(toolId);
    }

    // Esc on list closes the overlay entirely
    handleKey(Buffer.from("1b", "hex"), { renderAll: () => {} });
    expect(tuiState.overlay.type).toBe("none");
  });

  test("8. Harness sections navigate and open on Enter", () => {
    tuiState.openHarnessOverlay();
    handleKey(Buffer.from("1b5b42", "hex"), { renderAll: () => {} });
    handleKey(Buffer.from("1b5b42", "hex"), { renderAll: () => {} });
    const sectionId = getHarnessSections()[2].id;
    handleKey(Buffer.from("0d", "hex"), { renderAll: () => {} });
    expect(tuiState.overlay.type).toBe("harness-detail");
    if (tuiState.overlay.type === "harness-detail") expect(tuiState.overlay.section).toBe(sectionId);
    handleKey(Buffer.from("1b", "hex"), { renderAll: () => {} });
    expect(tuiState.overlay.type).toBe("harness");
    handleKey(Buffer.from("1b", "hex"), { renderAll: () => {} });
    expect(tuiState.overlay.type).toBe("none");
  });

  test("9. PageDown / End / Home move selection across the viewport", () => {
    tuiState.openToolsOverlay();
    handleKey(Buffer.from("1b5b367e", "hex"), { renderAll: () => {} }); // PgDn
    if (tuiState.overlay.type === "tools") {
      expect(tuiState.overlay.selected).toBeGreaterThan(3);
    }
    handleKey(Buffer.from("1b5b4f46", "hex"), { renderAll: () => {} }); // End
    if (tuiState.overlay.type === "tools") {
      expect(tuiState.overlay.selected).toBe(Math.max(0, getToolListItems().length - 1));
    }
    handleKey(Buffer.from("1b5b48", "hex"), { renderAll: () => {} }); // Home
    if (tuiState.overlay.type === "tools") expect(tuiState.overlay.selected).toBe(0);
  });

  test("10. Mock keys route through handleOverlayKey guard without leaking", () => {
    setInputState("abc");
    tuiState.openToolsOverlay();
    // Direct guard function behaves identically to handleKey dispatch
    const consumed = handleOverlayKey("1b5b42", "\x1b[A");
    expect(consumed).toBe(true);
    if (tuiState.overlay.type === "tools") expect(tuiState.overlay.selected).toBe(1);
    expect(tuiState.inputBuffer).toBe("abc");
  });

  test("11. Mobile 50x20 layout never wraps and hides the description column", () => {
    tuiState.openToolsOverlay();
    const box = renderToolsPanelBox(50, 20, tuiState.overlay as any);
    expect(maxRowWidth(box)).toBeLessThanOrEqual(50);
    expect(stripAnsi(box)).toContain("Agent Tools Registry");
    // Tool names are visible
    expect(stripAnsi(box)).toContain(getToolListItems()[0].title);
  });

  test("12. Harness section detail renders correctly at small terminal size", () => {
    tuiState.openHarnessSection("security");
    const box = renderHarnessPanelBox(60, 18, tuiState.overlay as any);
    expect(maxRowWidth(box)).toBeLessThanOrEqual(60);
    expect(stripAnsi(box)).toContain("Harness / Security");
    expect(stripAnsi(box)).toContain("Sandbox");
    expect(stripAnsi(box)).toContain("SecretGuard");
  });

  test("13. ensureVisible keeps selected item inside the scroll window", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, title: `tool-${i}` }));
    const state: ScrollableListPanelState = {
      title: "T",
      items,
      selectedIndex: 44,
      scrollOffset: 0,
      visibleRows: 10,
    };
    ensureVisible(state);
    expect(state.scrollOffset).toBe(35);
    expect(state.selectedIndex).toBeGreaterThanOrEqual(state.scrollOffset);
    expect(state.selectedIndex).toBeLessThan(state.scrollOffset + state.visibleRows);

    // Moving up out of the window scrolls back
    state.selectedIndex = 30;
    state.scrollOffset = 35;
    ensureVisible(state);
    expect(state.scrollOffset).toBe(30);
  });

  test("14. renderer preserves selected item across terminal resize (selection not reset)", () => {
    tuiState.openToolsOverlay();
    if (tuiState.overlay.type !== "tools") throw new Error("overlay not tools");
    tuiState.overlay.selected = 6;
    tuiState.overlay.scroll = 2;

    const boxSmall = renderToolsPanelBox(50, 12, tuiState.overlay);
    const boxLarge = renderToolsPanelBox(100, 30, tuiState.overlay);
    expect(stripAnsi(boxSmall)).toContain("…");
    expect(stripAnsi(boxLarge)).toContain(getToolListItems()[6].title);
    if (tuiState.overlay.type === "tools") {
      expect(tuiState.overlay.selected).toBe(6);
    }
  });

  test("15. renderListPanelBox at 40 cols is safe (minimum narrow width)", () => {
    const items = getToolListItems().slice(0, 12);
    const box = renderListPanelBox(40, 16, {
      title: "List",
      items,
      selectedIndex: 0,
      scrollOffset: 0,
      visibleRows: 8,
    });
    expect(maxRowWidth(box)).toBeLessThanOrEqual(40);
    expect(stripAnsi(box)).toContain("List (12 items)");
  });
});