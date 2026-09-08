import { A } from "../../term";
import { stripAnsi, truncate } from "../layout";
import { composeBox, computeBoxGeometry } from "./composeBox";

export interface SessionItem {
  sessionId: string;
  name?: string;
  model?: string;
  provider?: string;
  messagesCount: number;
  updatedAt: string;
  createdAt?: string;
  workspace?: string;
  queuedCount?: number;
  isCurrent: boolean;
}

export interface SessionPickerModalState {
  filteredSessions: SessionItem[];
  sessionPickerIdx: number;
  sessionSearchQuery: string;
  currentSessionId: string;
  currentWorkspace?: string;
}

const MAX_DISPLAY = 10;

export function formatRelativeTime(timestamp: string | number): string {
  const time = typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime();
  if (isNaN(time)) return "unknown";
  const diffMs = Date.now() - time;
  if (diffMs < 5000) return "just now";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(time).toLocaleDateString();
}

export function renderSessionPickerBox(
  cols: number,
  rows: number,
  state: SessionPickerModalState
): string {
  const {
    filteredSessions,
    sessionPickerIdx,
    sessionSearchQuery,
    currentSessionId,
    currentWorkspace,
  } = state;

  const isNarrow = cols < 60;
  const BOX_W = isNarrow ? 46 : 66;
  const boxW = Math.max(22, Math.min(BOX_W, cols - 2));
  const contentMax = boxW - 4;

  const body: string[] = [];

  const queryDisplay = sessionSearchQuery
    ? sessionSearchQuery + "█"
    : A.fgMuted + "Type to filter…" + A.reset;
  body.push(A.fgSubtext + "Search " + A.reset + (sessionSearchQuery ? A.fgText + queryDisplay + A.reset : queryDisplay));

  const countLabel = ` (${filteredSessions.length} session${filteredSessions.length === 1 ? "" : "s"})`;
  const title = "Sessions" + countLabel;

  const meta = (s: SessionItem): string => {
    const wsLen = s.workspace ? s.workspace.length + 1 : 0;
    const comboMax = Math.max(10, contentMax - 4 - wsLen - 19);
    const combo = [s.provider, s.model].filter(Boolean).join("/") || "no model";
    const ws = s.workspace ? " " + A.fgMuted + truncate(s.workspace, Math.max(10, contentMax - 4 - comboMax - 20)) + A.reset : "";
    return A.fgSubtext + truncate(combo, comboMax) + A.reset +
      A.fgMuted + " · " + s.messagesCount + " msgs · " + formatRelativeTime(s.updatedAt) + A.reset + ws;
  };

  if (filteredSessions.length === 0) {
    body.push(A.fgMuted + (sessionSearchQuery ? `No sessions matching "${sessionSearchQuery}"` : "No saved sessions found") + A.reset);
  } else {
    const visibleCount = Math.min(MAX_DISPLAY, filteredSessions.length);
    let viewStart = 0;
    if (sessionPickerIdx >= visibleCount) viewStart = sessionPickerIdx - visibleCount + 1;
    viewStart = Math.max(0, Math.min(viewStart, filteredSessions.length - visibleCount));

    for (let i = viewStart; i < viewStart + visibleCount; i++) {
      const s = filteredSessions[i];
      const isSel = i === sessionPickerIdx;
      const isCur = s.sessionId === currentSessionId || s.isCurrent;

      const maxNameLen = Math.max(16, contentMax - 12);
      const cleanName = truncate(s.name ? `${s.name} (${s.sessionId})` : s.sessionId, maxNameLen);
      const curBadge = isCur ? " " + A.fgCyan + "(current)" + A.reset : "";

      if (isSel) {
        body.push(A.bgOverlay + "  " + A.fgGreen + "● " + A.reset + A.bgOverlay + A.bold + A.fgText + cleanName + A.reset + curBadge);
        body.push(A.bgOverlay + "    " + A.bgOverlay + meta(s) + A.reset);
      } else {
        body.push("   " + A.fgText + cleanName + A.reset + curBadge);
        body.push("    " + meta(s));
      }
    }
  }

  if (filteredSessions.length > MAX_DISPLAY) {
    body.push(A.fgMuted + "… and " + (filteredSessions.length - MAX_DISPLAY) + " more" + A.reset);
  }

  return composeBox(cols, rows, {
    title,
    body,
    footer: "↑↓ navigate · enter resume · d delete · esc close",
    width: BOX_W,
  }).join("");
}