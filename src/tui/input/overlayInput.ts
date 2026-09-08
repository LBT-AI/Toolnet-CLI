import { tuiState } from "../state";
import { getSize } from "../../term";
import { computeVisibleRows } from "../renderers/listPanelRenderer";
import { getToolListItems, getToolById } from "../../lib/toolsCatalog";
import { getHarnessSections, getHarnessSectionDetail } from "../../lib/harnessCatalog";

const UP = ["1b5b41", "1b4f41"];
const DOWN = ["1b5b42", "1b4f42"];
const PGUP = ["1b5b357e"];
const PGDN = ["1b5b367e"];
const HOME = ["1b5b48", "1b4f48", "1b5b317e", "1b5b377e", "01"];
const END = ["1b5b46", "1b4f46", "1b5b347e", "1b5b387e", "05"];
const ESC = ["1b"];
const BACKSPACE = ["7f", "08"];
const ENTER = ["0d", "0a"];
const CTRLC = ["03"];

function matches(hex: string, codes: string[]): boolean {
  return codes.includes(hex);
}

function closeOverlay(): void {
  tuiState.overlay = { type: "none" };
  tuiState.setStatus(""); // return to the "● Ready │ Mode: …" line; the footer
  // bar already shows Provider/Model/Workspace, so the status line must not
  // echo a duplicate-looking "Provider │ Model" bar.
  tuiState.requestRender();
}

function visibleRows(): number {
  return computeVisibleRows(getSize().rows);
}

export function overlayIsActive(): boolean {
  return tuiState.overlay.type !== "none";
}

function handleToolsList(hex: string, s: string): boolean {
  const overlay = tuiState.overlay;
  if (overlay.type !== "tools") return false;
  const query = overlay.query || "";
  const items = getToolListItems(query);
  const count = items.length;
  const sel = Math.min(Math.max(0, overlay.selected), Math.max(0, count - 1));

  if (matches(hex, CTRLC) || (matches(hex, ESC) && !query)) {
    closeOverlay();
    return true;
  }
  if (matches(hex, ESC)) {
    overlay.query = "";
    overlay.selected = 0;
    overlay.scroll = 0;
    tuiState.requestRender();
    return true;
  }
  if (matches(hex, ENTER)) {
    const item = items[sel];
    if (item) {
      tuiState.overlay = { type: "tool-detail", toolId: item.id };
      tuiState.setStatus("");
      tuiState.requestRender();
    }
    return true;
  }
  if (matches(hex, BACKSPACE)) {
    if (query.length > 0) {
      overlay.query = query.slice(0, -1);
      overlay.selected = 0;
      overlay.scroll = 0;
      tuiState.requestRender();
    }
    return true;
  }

  const page = visibleRows();
  if (matches(hex, UP) || s.toLowerCase() === "k") {
    overlay.selected = sel <= 0 ? Math.max(0, count - 1) : sel - 1;
    tuiState.requestRender();
    return true;
  }
  if (matches(hex, DOWN) || s.toLowerCase() === "j") {
    overlay.selected = sel >= count - 1 ? 0 : sel + 1;
    tuiState.requestRender();
    return true;
  }
  if (matches(hex, PGUP)) {
    overlay.selected = Math.max(0, sel - page);
    tuiState.requestRender();
    return true;
  }
  if (matches(hex, PGDN)) {
    overlay.selected = Math.min(Math.max(0, count - 1), sel + page);
    tuiState.requestRender();
    return true;
  }
  if (matches(hex, HOME)) {
    overlay.selected = 0;
    tuiState.requestRender();
    return true;
  }
  if (matches(hex, END)) {
    overlay.selected = Math.max(0, count - 1);
    tuiState.requestRender();
    return true;
  }

  if (s.length >= 1 && !s.startsWith("\x1b") && s >= " " && s <= "~") {
    overlay.query = query + s;
    overlay.selected = 0;
    overlay.scroll = 0;
    tuiState.requestRender();
    return true;
  }
  return true;
}

function handleToolDetail(hex: string, s: string): boolean {
  const overlay = tuiState.overlay;
  if (overlay.type !== "tool-detail") return false;
  if (matches(hex, CTRLC)) {
    closeOverlay();
    return true;
  }
  if (matches(hex, ESC) || matches(hex, BACKSPACE) || s.toLowerCase() === "b" || matches(hex, ENTER)) {
    const tool = getToolById(overlay.toolId);
    const items = getToolListItems();
    const idx = tool ? Math.max(0, items.findIndex((i) => i.id === tool.name)) : 0;
    tuiState.overlay = {
      type: "tools",
      selected: idx,
      scroll: Math.max(0, idx - Math.floor(visibleRows() / 2)),
      query: "",
    };
    tuiState.setStatus("");
    tuiState.requestRender();
    return true;
  }
  return true;
}

function handleHarnessList(hex: string, s: string): boolean {
  const overlay = tuiState.overlay;
  if (overlay.type !== "harness") return false;
  const query = overlay.query || "";
  const items = getHarnessSections(query);
  const count = items.length;
  const sel = Math.min(Math.max(0, overlay.selected), Math.max(0, count - 1));

  if (matches(hex, CTRLC) || (matches(hex, ESC) && !query)) {
    closeOverlay();
    return true;
  }
  if (matches(hex, ESC)) {
    overlay.query = "";
    overlay.selected = 0;
    overlay.scroll = 0;
    tuiState.requestRender();
    return true;
  }
  if (matches(hex, ENTER)) {
    const item = items[sel];
    if (item) {
      tuiState.overlay = { type: "harness-detail", section: item.id };
      tuiState.setStatus("");
      tuiState.requestRender();
    }
    return true;
  }
  if (matches(hex, BACKSPACE)) {
    if (query.length > 0) {
      overlay.query = query.slice(0, -1);
      overlay.selected = 0;
      overlay.scroll = 0;
      tuiState.requestRender();
    }
    return true;
  }

  const page = visibleRows();
  if (matches(hex, UP) || s.toLowerCase() === "k") {
    overlay.selected = sel <= 0 ? Math.max(0, count - 1) : sel - 1;
    tuiState.requestRender();
    return true;
  }
  if (matches(hex, DOWN) || s.toLowerCase() === "j") {
    overlay.selected = sel >= count - 1 ? 0 : sel + 1;
    tuiState.requestRender();
    return true;
  }
  if (matches(hex, PGUP)) {
    overlay.selected = Math.max(0, sel - page);
    tuiState.requestRender();
    return true;
  }
  if (matches(hex, PGDN)) {
    overlay.selected = Math.min(Math.max(0, count - 1), sel + page);
    tuiState.requestRender();
    return true;
  }
  if (matches(hex, HOME)) {
    overlay.selected = 0;
    tuiState.requestRender();
    return true;
  }
  if (matches(hex, END)) {
    overlay.selected = Math.max(0, count - 1);
    tuiState.requestRender();
    return true;
  }

  if (s.length >= 1 && !s.startsWith("\x1b") && s >= " " && s <= "~") {
    overlay.query = query + s;
    overlay.selected = 0;
    overlay.scroll = 0;
    tuiState.requestRender();
    return true;
  }
  return true;
}

function handleHarnessDetail(hex: string, s: string): boolean {
  const overlay = tuiState.overlay;
  if (overlay.type !== "harness-detail") return false;
  if (matches(hex, CTRLC)) {
    closeOverlay();
    return true;
  }
  if (matches(hex, ESC) || matches(hex, BACKSPACE) || s.toLowerCase() === "b" || matches(hex, ENTER)) {
    const detail = getHarnessSectionDetail(overlay.section);
    const items = getHarnessSections();
    const idx = detail ? Math.max(0, items.findIndex((i) => i.id === detail.id)) : 0;
    tuiState.overlay = {
      type: "harness",
      selected: idx,
      scroll: Math.max(0, idx - Math.floor(visibleRows() / 2)),
      query: "",
    };
    tuiState.setStatus("");
    tuiState.requestRender();
    return true;
  }
  return true;
}

/**
 * Guard-clause handler for when the Tools / Harness panel overlay is active.
 * Returns true if the key was consumed (it is always consumed while an
 * overlay is active — nothing may leak into the chat input below).
 */
export function handleOverlayKey(hex: string, s: string): boolean {
  switch (tuiState.overlay.type) {
    case "tools":
      return handleToolsList(hex, s);
    case "tool-detail":
      return handleToolDetail(hex, s);
    case "harness":
      return handleHarnessList(hex, s);
    case "harness-detail":
      return handleHarnessDetail(hex, s);
    default:
      return false;
  }
}