/**
 * `/mcp` namespace picker UX.
 *
 * Typing `/mcp` must open an interactive picker (subcommands, then servers) —
 * NOT execute a handler and NOT dump help into the transcript. Selection
 * completes the composer; the final Enter runs the completed command. All of
 * this is local UI: no provider call, no agent turn, no transcript mutation.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tuiState } from "../state";
import {
  handleKey,
  getInputState,
  setInputState,
  resetInputState,
  getSuggestions,
  getActiveSuggestions,
} from "../input/inputHandler";
import { getMcpPickerItems } from "../mcpPicker";
import { renderSuggestionsPopup } from "../renderers/suggestRenderer";
import { stripAnsi } from "../layout";
import { sendMessage } from "../events/agentWiring";

function typeString(text: string, cb: { renderAll: () => void; sendMessage: (t: string) => void }) {
  for (const ch of text) {
    handleKey(Buffer.from(ch, "utf8"), cb);
  }
}

describe("MCP namespace picker", () => {
  beforeEach(() => {
    resetInputState();
    tuiState.cmdSuggestIdx = 0;
    tuiState.cmdSuggestDismissedFor = null;
    tuiState.messages = [];
    tuiState.isStreaming = false;
    // The composer only submits (non-`/exit`) input when the app is ready.
    tuiState.appState = "ready";
  });

  afterEach(() => {
    resetInputState();
    tuiState.cmdSuggestDismissedFor = null;
    tuiState.messages = [];
  });

  it("treats /mcp as a namespace and leaves other commands alone", () => {
    expect(getMcpPickerItems("/mcp")).not.toBeNull();
    expect(getMcpPickerItems("/mcp ")).not.toBeNull();
    expect(getMcpPickerItems("/mcp show")).not.toBeNull();
    expect(getMcpPickerItems("/mcp show toolnet-skills")).toEqual([]);
    expect(getMcpPickerItems("/mcp list")).toEqual([]);
    // Out of namespace -> top-level palette untouched.
    expect(getMcpPickerItems("/model")).toBeNull();
    expect(getMcpPickerItems("/mpc")).toBeNull();
  });

  it("typing /mcp opens the subcommand picker without executing or mutating the transcript", () => {
    const sent: string[] = [];
    typeString("/mcp", { renderAll: () => {}, sendMessage: (t) => sent.push(t) });

    expect(getInputState().buffer).toBe("/mcp");
    const items = getActiveSuggestions("/mcp");
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.complete === true)).toBe(true);
    expect(items.map((i) => i.name)).toContain("show");

    // Nothing ran, nothing was appended.
    expect(sent).toEqual([]);
    expect(tuiState.messages).toEqual([]);
    expect(tuiState.messages.some((m) => m.content?.includes("MCP — Status"))).toBe(false);
  });

  it("keeps the picker open for a trailing space and filters by prefix", () => {
    expect(getActiveSuggestions("/mcp ").length).toBeGreaterThan(0);
    const filtered = getActiveSuggestions("/mcp s");
    expect(filtered.map((i) => i.name)).toEqual(["show"]);
  });

  it("Enter COMPLETES the composer instead of executing; Down+Enter selects the right subcommand", () => {
    const sent: string[] = [];
    const cb = { renderAll: () => {}, sendMessage: (t: string) => sent.push(t) };

    typeString("/mcp", cb);
    // First item is `list`; complete it.
    handleKey(Buffer.from("0d", "hex"), cb);
    expect(getInputState().buffer).toBe("/mcp list ");
    expect(sent).toEqual([]);

    // Now navigate: pick `show` (index 1) and complete.
    setInputState("/mcp");
    tuiState.cmdSuggestIdx = 0;
    handleKey(Buffer.from("1b5b42", "hex"), cb); // Down -> show
    expect(tuiState.cmdSuggestIdx).toBe(1);
    handleKey(Buffer.from("0d", "hex"), cb);
    expect(getInputState().buffer).toBe("/mcp show ");
    expect(sent).toEqual([]);

    // A complete command with no more picker levels submits on Enter.
    setInputState("/mcp list");
    expect(getActiveSuggestions("/mcp list")).toEqual([]);
    handleKey(Buffer.from("0d", "hex"), cb);
    expect(sent).toEqual(["/mcp list"]);
  });

  it("offers the live server registry as the second level", () => {
    setInputState("/mcp show ");
    const servers = getActiveSuggestions("/mcp show ");
    expect(servers.length).toBeGreaterThan(0);
    const builtin = servers.find((s) => s.id === "toolnet-skills");
    expect(builtin).toBeDefined();
    expect(builtin!.complete).toBe(true);
  });

  it("selecting a server completes the stable serverId and closes the picker", () => {
    const sent: string[] = [];
    const cb = { renderAll: () => {}, sendMessage: (t: string) => sent.push(t) };

    setInputState("/mcp show ");
    const servers = getActiveSuggestions("/mcp show ");
    tuiState.cmdSuggestIdx = servers.findIndex((s) => s.id === "toolnet-skills");
    expect(tuiState.cmdSuggestIdx).toBeGreaterThanOrEqual(0);
    handleKey(Buffer.from("0d", "hex"), cb);

    expect(getInputState().buffer).toBe("/mcp show toolnet-skills");
    expect(sent).toEqual([]);
    // Complete command -> no more picker levels.
    expect(getActiveSuggestions("/mcp show toolnet-skills")).toEqual([]);

    // Next Enter submits the completed command.
    handleKey(Buffer.from("0d", "hex"), cb);
    expect(sent).toEqual(["/mcp show toolnet-skills"]);
  });

  it("Esc closes the picker but preserves the composer text", () => {
    typeString("/mcp", { renderAll: () => {}, sendMessage: () => {} });
    handleKey(Buffer.from("1b", "hex"), { renderAll: () => {}, sendMessage: () => {} });

    expect(getInputState().buffer).toBe("/mcp");
    expect(getActiveSuggestions("/mcp")).toEqual([]);
    // Editing re-arms the picker (the dismissed text no longer matches).
    handleKey(Buffer.from("20", "hex"), { renderAll: () => {}, sendMessage: () => {} }); // space
    expect(getInputState().buffer).toBe("/mcp ");
    expect(getActiveSuggestions("/mcp ").length).toBeGreaterThan(0);
  });

  it("renders the namespace picker on the 52x20 mobile target", () => {
    const items = getSuggestions("/mcp");
    const out = renderSuggestionsPopup(52, 8, items, 0, "\x1b[36m", true);
    const joined = stripAnsi(out.join("")).replace(/\r/g, "");
    expect(joined).toContain("show");
    expect(joined).toContain("Enter select");
  });

  it("a submitted invalid command appends exactly one error row", async () => {
    await sendMessage("/mpc");
    const rows = tuiState.messages.filter((m) => m.content?.includes("Unknown command: /mpc"));
    expect(rows.length).toBe(1);
  });
});
