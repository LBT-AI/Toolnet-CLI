import { A } from "../../term";
import { stripAnsi, truncate } from "../layout";
import { composeBox, computeBoxGeometry } from "./composeBox";

export interface ListItem {
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  status?: "enabled" | "disabled" | "active";
}

export interface ScrollableListPanelState {
  title: string;
  items: ListItem[];
  selectedIndex: number;
  scrollOffset: number;
  visibleRows: number;
  searchQuery?: string;
  hint?: string;
}

const MAX_DISPLAY = 12;

/** Clamp the scroll window so the selected item is always visible. */
export function ensureVisible(state: ScrollableListPanelState): void {
  const count = state.items.length;
  if (count === 0) {
    state.scrollOffset = 0;
    return;
  }
  const sel = Math.min(Math.max(0, state.selectedIndex), count - 1);
  if (sel < state.scrollOffset) {
    state.scrollOffset = Math.max(0, sel);
    return;
  }
  const bottom = state.scrollOffset + state.visibleRows;
  if (sel < bottom) return;
  state.scrollOffset = sel - state.visibleRows + 1;
}

/** Number of item rows that fit given terminal rows (reserved chrome accounted). */
export function computeVisibleRows(terminalRows: number): number {
  return Math.max(3, terminalRows - 8);
}

function statusDot(status?: ListItem["status"]): string {
  if (status === "enabled") return A.fgGreen + "●" + A.reset;
  if (status === "disabled") return A.fgMuted + "○" + A.reset;
  if (status === "active") return A.fgCyan + "●" + A.reset;
  return " ";
}

/**
 * Shared design-system scrollable list overlay: rounded corners, dim border,
 * compact rows, subtle highlight on the selected row. Narrow terminals drop
 * the description column and the header count so nothing wraps.
 */
export function renderListPanelBox(
  cols: number,
  rows: number,
  state: ScrollableListPanelState
): string {
  const isNarrow = cols < 60;
  const { boxW } = computeBoxGeometry(cols, rows, 8, true, isNarrow ? 46 : 58);

  const list = state.items;
  const titleText = list.length > 0
    ? `${state.title} (${list.length}${list.length === 1 ? " item" : " items"})`
    : state.title;

  // Fit into the content viewport: search row + items + "more" row + box chrome.
  const effVisible = Math.max(
    1,
    Math.min(state.visibleRows, MAX_DISPLAY, Math.max(1, rows - 8))
  );

  const bounded = {
    ...state,
    visibleRows: effVisible,
    selectedIndex: Math.min(Math.max(0, state.selectedIndex), Math.max(0, list.length - 1)),
  };
  ensureVisible(bounded);
  const listStart = bounded.scrollOffset;
  const visibleCount = Math.min(list.length - listStart, effVisible);

  const body: string[] = [];

  if (state.searchQuery !== undefined) {
    const query = state.searchQuery
      ? state.searchQuery + "█"
      : A.fgMuted + "Type to filter…" + A.reset;
    body.push(A.fgSubtext + "Search " + A.reset + (state.searchQuery ? A.fgText + query + A.reset : query));
  }

  if (list.length === 0) {
    body.push(A.fgMuted + "No items" + A.reset);
  }

  for (let i = 0; i < visibleCount; i++) {
    const itemIdx = listStart + i;
    const item = list[itemIdx];
    const selected = itemIdx === bounded.selectedIndex;

    const nameMax = isNarrow ? Math.max(8, Math.floor((boxW - 12) * 0.6)) : 20;
    const catMax = isNarrow ? Math.max(6, boxW - 12 - nameMax) : 12;
    const nameText = truncate(item.title, nameMax);
    const categoryText = item.subtitle ? truncate(item.subtitle, catMax) : "";

    let descPart = "";
    if (!isNarrow && item.description) {
      const descMax = Math.max(4, boxW - nameMax - catMax - 22);
      const d = truncate(item.description, descMax);
      descPart = " " + A.fgMuted + d + A.reset;
    }

    if (selected) {
      const line =
        A.bgOverlay + "  " + A.fgCyan + A.bold + "❯ " + A.reset +
        A.bgOverlay + statusDot(item.status) + " " + A.bgOverlay + A.bold + A.fgText + nameText + A.reset +
        (categoryText ? A.bgOverlay + " " + A.fgSubtext + categoryText + A.reset : "") +
        descPart;
      body.push(line);
    } else {
      body.push("   " + statusDot(item.status) + " " + A.fgText + nameText + A.reset + (categoryText ? " " + A.fgSubtext + categoryText + A.reset : "") + descPart);
    }
  }

  if (list.length > listStart + visibleCount) {
    body.push(A.fgMuted + "… and " + (list.length - listStart - visibleCount) + " more" + A.reset);
  }

  return composeBox(cols, rows, {
    title: titleText,
    body,
    footer: state.hint || "↑↓ navigate · enter open · esc close",
  }).join("");
}