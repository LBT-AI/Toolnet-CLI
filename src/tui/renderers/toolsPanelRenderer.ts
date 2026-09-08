import { A } from "../../term";
import { truncate, wrapText } from "../layout";
import { renderListPanelBox, computeVisibleRows, type ScrollableListPanelState } from "./listPanelRenderer";
import { getToolListItems, getToolById, type ToolInfo } from "../../lib/toolsCatalog";
import { composeBox, computeBoxGeometry } from "./composeBox";
import type { Overlay } from "../types";

function buildListState(cols: number, rows: number, overlay: Extract<Overlay, { type: "tools" }>): ScrollableListPanelState {
  const items = getToolListItems(overlay.query);
  const selectedIndex = Math.min(Math.max(0, overlay.selected), Math.max(0, items.length - 1));
  if (overlay.selected !== selectedIndex) overlay.selected = selectedIndex;
  return {
    title: "Agent Tools Registry",
    items,
    selectedIndex,
    scrollOffset: overlay.scroll,
    visibleRows: computeVisibleRows(rows),
    searchQuery: overlay.query || "",
    hint: " ↑↓ Navigate │ Enter Details │ Esc Close",
  };
}

export function renderToolsPanelBox(
  cols: number,
  rows: number,
  overlay: Extract<Overlay, { type: "tools" | "tool-detail" }>
): string {
  if (overlay.type === "tool-detail") {
    const tool = getToolById(overlay.toolId);
    if (!tool) return renderListPanelBox(cols, rows, {
      title: "Agent Tools Registry",
      items: [{ id: "notfound", title: "Tool not found", subtitle: "", description: overlay.toolId }],
      selectedIndex: 0,
      scrollOffset: 0,
      visibleRows: computeVisibleRows(rows),
      hint: " Esc Close",
    });
    return renderToolDetailBox(cols, rows, tool);
  }
  return renderListPanelBox(cols, rows, buildListState(cols, rows, overlay));
}

export function renderToolDetailBox(cols: number, rows: number, tool: ToolInfo): string {
  const isNarrow = cols < 60;
  const { boxW } = computeBoxGeometry(cols, rows, 4, true, isNarrow ? 46 : 58);

  const body: string[] = [];

  const catFmt = A.fgCyan + truncate(tool.category, Math.max(8, boxW - 16)) + A.reset;
  body.push(A.fgSubtext + "Category  " + A.reset + catFmt);
  body.push(A.fgSubtext + "Status    " + A.reset + A.fgGreen + "● Enabled" + A.reset + A.fgMuted + "  (" + tool.source + ")" + A.reset);
  body.push("");

  const descLines = wrapText(tool.description || "(no description)", Math.max(10, boxW - 8)).slice(0, 6);
  body.push(A.bold + A.fgText + "Description" + A.reset);
  for (const line of descLines) body.push("  " + A.fgSubtext + line + A.reset);
  body.push("");

  body.push(A.bold + A.fgText + "Parameters" + A.reset);
  const paramNames = Object.keys(tool.parameters);
  if (paramNames.length === 0) {
    body.push(A.fgMuted + "  (none)" + A.reset);
  } else {
    const shown = paramNames.slice(0, 8);
    for (const name of shown) {
      const param = tool.parameters[name];
      const type = truncate(param?.type || "any", 12);
      const desc = isNarrow ? "" : truncate(param?.description || "", Math.max(6, boxW - 30));
      const req = tool.required.includes(name) ? A.fgYellow + "required" + A.reset : A.fgMuted + "optional" + A.reset;
      body.push("  " + A.fgText + truncate(name, 16).padEnd(16, " ") + A.reset + " " + A.fgSubtext + type.padEnd(12, " ") + A.reset + " " + req + (desc ? " " + A.fgMuted + desc + A.reset : ""));
    }
    if (paramNames.length > 8) body.push(A.fgMuted + "  … " + (paramNames.length - 8) + " more" + A.reset);
  }

  return composeBox(cols, rows, {
    title: "Tool · " + truncate(tool.name, 40),
    body,
    footer: "esc back to list",
  }).join("");
}