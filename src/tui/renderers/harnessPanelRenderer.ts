import { A } from "../../term";
import { truncate } from "../layout";
import { renderListPanelBox, computeVisibleRows, type ScrollableListPanelState } from "./listPanelRenderer";
import { getHarnessSections, getHarnessSectionDetail, type HarnessSectionDetail } from "../../lib/harnessCatalog";
import { composeBox, computeBoxGeometry } from "./composeBox";
import type { Overlay } from "../types";

function buildListState(cols: number, rows: number, overlay: Extract<Overlay, { type: "harness" }>): ScrollableListPanelState {
  const items = getHarnessSections(overlay.query);
  const selectedIndex = Math.min(Math.max(0, overlay.selected), Math.max(0, items.length - 1));
  if (overlay.selected !== selectedIndex) overlay.selected = selectedIndex;
  return {
    title: "ToolNet Agent Harness",
    items,
    selectedIndex,
    scrollOffset: overlay.scroll,
    visibleRows: computeVisibleRows(rows),
    searchQuery: overlay.query || "",
    hint: " ↑↓ Navigate │ Enter Open Section │ Esc Close",
  };
}

export function renderHarnessPanelBox(
  cols: number,
  rows: number,
  overlay: Extract<Overlay, { type: "harness" | "harness-detail" }>
): string {
  if (overlay.type === "harness-detail") {
    const detail = getHarnessSectionDetail(overlay.section);
    if (!detail) return renderListPanelBox(cols, rows, {
      title: "ToolNet Agent Harness",
      items: [{ id: "notfound", title: "Section not found", subtitle: "", description: overlay.section }],
      selectedIndex: 0,
      scrollOffset: 0,
      visibleRows: computeVisibleRows(rows),
      hint: " Esc Close",
    });
    return renderHarnessDetailBox(cols, rows, detail);
  }
  return renderListPanelBox(cols, rows, buildListState(cols, rows, overlay));
}

function statusBadge(status?: "enabled" | "disabled" | "active"): string {
  if (status === "enabled") return A.fgGreen + "● active" + A.reset;
  if (status === "disabled") return A.fgMuted + "○ off" + A.reset;
  if (status === "active") return A.fgCyan + "● running" + A.reset;
  return "";
}

export function renderHarnessDetailBox(cols: number, rows: number, detail: HarnessSectionDetail): string {
  const isNarrow = cols < 60;
  const { boxW } = computeBoxGeometry(cols, rows, 4, true, isNarrow ? 46 : 58);

  const labelMax = isNarrow ? 12 : 16;
  const valueMax = Math.max(10, boxW - labelMax - 20);
  const maxRows = 10;

  const body: string[] = [];
  detail.rows.slice(0, maxRows).forEach((r) => {
    const label = truncate(r.label, labelMax).padEnd(labelMax, " ");
    const value = truncate(r.value, valueMax);
    const badge = r.status ? " " + statusBadge(r.status) : "";
    body.push(" " + A.fgSubtext + label + A.reset + " " + A.bold + A.fgText + value + A.reset + badge);
  });

  if (detail.rows.length > maxRows) {
    body.push(A.fgMuted + "… and " + (detail.rows.length - maxRows) + " more" + A.reset);
  }

  return composeBox(cols, rows, {
    title: truncate(detail.title, 40),
    body,
    footer: "esc back to sections",
  }).join("");
}