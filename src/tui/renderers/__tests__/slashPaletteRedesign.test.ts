/**
 * Slash Command Palette Redesign Tests
 *
 * Validates the large command-sheet palette (Freebuff-style):
 * - exactly 37 commands from getAllCommands() (no second registry)
 * - realtime filter on /, /m, /pro (name/alias first, description fallback)
 * - ↑↓, PgUp/PgDn, Home/End, Ctrl+P/Ctrl+N navigation
 * - Enter executes the selected command, Esc closes
 * - sheet geometry at 50x20 / 60x25 / 80x30 (and 120x40, 40x20)
 * - selected item always visible inside the viewport
 * - exactly one hint/footer line (no duplicate footer/input)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tuiState } from "../../state";
import {
  handleKey,
  getInputState,
  setInputState,
  resetInputState,
  getSuggestions,
} from "../../input/inputHandler";
import { getAllCommands } from "../../../commands";
import { renderSuggestionsPopup } from "../suggestRenderer";
import { stripAnsi } from "../../layout";

const callbacks = {
  renderAll: () => {},
  sendMessage: () => {},
};

const PALETTE_SIZES: Array<[number, number]> = [
  [40, 20],
  [50, 20],
  [60, 25],
  [80, 30],
  [120, 40],
];

function popupRowsFor(rows: number): number {
  const content = Math.max(6, rows - 5);
  return Math.max(6, Math.min(content - 1, Math.floor(content * 0.72)));
}

describe("Slash Command Palette Redesign", () => {
  beforeEach(() => {
    resetInputState();
    tuiState.cmdSuggestIdx = 0;
    tuiState.showHelp = false;
    tuiState.showModelPicker = false;
    tuiState.messages = [];
  });

  afterEach(() => {
    resetInputState();
  });

  it("1. registry exposes exactly 39 commands (single source of truth)", () => {
    expect(getAllCommands().length).toBe(39);
    // Phase 80 — the model catalog view is registered in the one registry.
    expect(getAllCommands().map((command) => command.name)).toContain("catalog");
  });

  it("2. '/' lists all 39 commands; /m and /pro filter precisely", () => {
    const all = getSuggestions("/");
    expect(all.length).toBe(39);
    expect(all[0].name).toBe("/help");

    const m = getSuggestions("/m");
    expect(m.map((s) => s.name)).toEqual(["/model", "/mcp"]);

    const pro = getSuggestions("/pro");
    expect(pro.map((s) => s.name)).toEqual(["/provider"]);
  });

  it("3. description search kicks in only when nothing matches by name", () => {
    // "/orchestr" has no command name/alias match -> description finds /teamwork
    const orchestr = getSuggestions("/orchestr");
    expect(orchestr.map((s) => s.name)).toEqual(["/teamwork"]);

    // alias prefix still matches first: /perm -> sandbox (alias), policy (alias), permissions
    const perm = getSuggestions("/perm");
    expect(perm.map((s) => s.name)).toContain("/permissions");
    expect(perm.map((s) => s.name)).toContain("/sandbox");
  });

  it("4. ↑↓ and Ctrl+P/Ctrl+N navigate with wrap-around", () => {
    setInputState("/");
    expect(getSuggestions("/").length).toBe(39);

    handleKey(Buffer.from("1b5b42", "hex"), callbacks); // Down
    expect(tuiState.cmdSuggestIdx).toBe(1);
    handleKey(Buffer.from("0e", "hex"), callbacks); // Ctrl+N
    expect(tuiState.cmdSuggestIdx).toBe(2);
    handleKey(Buffer.from("1b5b41", "hex"), callbacks); // Up
    expect(tuiState.cmdSuggestIdx).toBe(1);
    handleKey(Buffer.from("10", "hex"), callbacks); // Ctrl+P
    expect(tuiState.cmdSuggestIdx).toBe(0);

    // Wrap around: Up at 0 -> last (38); Down at 38 -> 0
    handleKey(Buffer.from("1b5b41", "hex"), callbacks);
    expect(tuiState.cmdSuggestIdx).toBe(38);
    handleKey(Buffer.from("1b5b42", "hex"), callbacks);
    expect(tuiState.cmdSuggestIdx).toBe(0);
  });

  it("5. PgUp/PgDn page by 6; Home/End jump to first/last", () => {
    setInputState("/");
    handleKey(Buffer.from("1b5b367e", "hex"), callbacks); // PgDn
    expect(tuiState.cmdSuggestIdx).toBe(6);
    handleKey(Buffer.from("1b5b357e", "hex"), callbacks); // PgUp
    expect(tuiState.cmdSuggestIdx).toBe(0);

    handleKey(Buffer.from("1b5b46", "hex"), callbacks); // End
    expect(tuiState.cmdSuggestIdx).toBe(38);
    handleKey(Buffer.from("1b5b48", "hex"), callbacks); // Home
    expect(tuiState.cmdSuggestIdx).toBe(0);
  });

  it("6. Enter executes highlighted command; Esc closes and clears input", () => {
    setInputState("/");
    const sent: string[] = [];
    handleKey(Buffer.from("1b5b42", "hex"), { renderAll: () => {}, sendMessage: (t) => sent.push(t) });
    handleKey(Buffer.from("0d", "hex"), { renderAll: () => {}, sendMessage: (t) => sent.push(t) });

    expect(sent.length).toBe(1);
    expect(sent[0]).toBe("/status");
    expect(getInputState().buffer).toBe("");

    // Esc clears slash input and closes palette
    setInputState("/model");
    handleKey(Buffer.from("1b", "hex"), callbacks);
    expect(getInputState().buffer).toBe("");
    expect(tuiState.cmdSuggestIdx).toBe(0);
  });

  it("7. typing filters realtime and resets selection to 0", () => {
    setInputState("/");
    handleKey(Buffer.from("1b5b42", "hex"), callbacks); // move to index 1
    expect(tuiState.cmdSuggestIdx).toBe(1);

    // type "m" -> /model, /mcp and selection resets
    handleKey(Buffer.from("6d", "hex"), callbacks);
    expect(tuiState.cmdSuggestIdx).toBe(0);
    expect(getSuggestions(getInputState().buffer).map((s) => s.name)).toEqual(["/model", "/mcp"]);

    // Backspace back to "/" -> all 39 again
    handleKey(Buffer.from("7f", "hex"), callbacks);
    expect(getSuggestions(getInputState().buffer).length).toBe(39);
  });

  it("8. sheet geometry: full-width, 2-line rows, one hint line (no duplicate footer)", () => {
    const suggests = getSuggestions("/");
    for (const [cols, rows] of PALETTE_SIZES) {
      const out = renderSuggestionsPopup(cols, popupRowsFor(rows), suggests, 0, "\x1b[36m");
      const joined = out.join("");
      const stripped = stripAnsi(joined).replace(/\r/g, "");
      const hintCount = (stripped.match(/↑↓ navigate/g) || []).length;

      expect(hintCount, `exactly one hint at ${cols}x${rows}`).toBe(1);
      expect(stripped).toContain("╭");
      expect(stripped).toContain("╰");
      expect(stripped).toContain("/help");
      expect(stripped).toContain("1 / 39");
      // description sits on its own line under the command name
      // (border/padding chars between them are allowed; sizes vary)
      expect(stripped).toMatch(/\/help[\s│]*Show list of commands/);
    }
  });

  it("9. selected item is always visible at every index across all sizes", () => {
    const suggests = getSuggestions("/");
    for (const [cols, rows] of PALETTE_SIZES) {
      for (let idx = 0; idx < suggests.length; idx++) {
        const out = renderSuggestionsPopup(cols, popupRowsFor(rows), suggests, idx, "\x1b[36m");
        const stripped = stripAnsi(out.join(""));
        expect(stripped, `selected ${idx} visible at ${cols}x${rows}`).toContain("● " + suggests[idx].name);
      }
    }
  });

  it("10. no command name is truncated on narrow terminals (40 cols)", () => {
    const suggests = getSuggestions("/");
    // Longest names live at the end of the list — jump straight to them so
    // they are inside the viewport, then assert they render intact.
    const permissIdx = suggests.findIndex((s) => s.name === "/permissions");
    const workspaceIdx = suggests.findIndex((s) => s.name === "/workspace");
    for (const idx of [permissIdx, workspaceIdx]) {
      const out = renderSuggestionsPopup(40, popupRowsFor(20), suggests, idx, "\x1b[36m");
      const stripped = stripAnsi(out.join(""));
      expect(stripped).toContain("● " + suggests[idx].name);
    }
  });
});