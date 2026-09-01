import { A, T } from "../../term";
import { stripAnsi, truncate } from "../layout";

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

/**
 * Renders the interactive Session Manager & Picker modal popup.
 */
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

  const boxW = Math.min(100, Math.max(60, cols - 4));
  const boxH = Math.min(22, Math.max(12, rows - 4));
  const startCol = Math.max(1, Math.floor((cols - boxW) / 2));
  const startRow = Math.max(2, Math.floor((rows - boxH) / 2));

  const out: string[] = [];
  let curRow = startRow;

  const pushLine = (content: string) => {
    out.push(T.goto(curRow++, startCol));
    const stripped = stripAnsi(content);
    const pad = Math.max(0, boxW - 2 - stripped.length);
    out.push(
      A.fgBorder + "│" + A.reset +
      content +
      " ".repeat(pad) +
      A.fgBorder + "│" + A.reset
    );
  };

  // Header Title
  const countLabel = ` (${filteredSessions.length} session${filteredSessions.length === 1 ? "" : "s"})`;
  const titleText = ` Sessions${countLabel} `;
  const titleBarLen = Math.max(0, boxW - 4 - stripAnsi(titleText).length);
  const topBorder =
    A.fgBorder + "┌─" + A.bold + A.fgCyan + titleText + A.reset + A.fgBorder + "─".repeat(titleBarLen) + "┐" + A.reset;
  out.push(T.goto(curRow++, startCol) + topBorder);

  // Search / Filter bar
  const queryDisplay = sessionSearchQuery
    ? `${sessionSearchQuery}▌`
    : `${A.fgMuted}Type to filter sessions...${A.reset}`;
  pushLine(` Filter: ${queryDisplay}`);

  // Divider
  out.push(T.goto(curRow++, startCol));
  out.push(A.fgBorder + "├" + "─".repeat(boxW - 2) + "┤" + A.reset);

  const listRows = Math.max(1, startRow + boxH - 2 - curRow);

  if (filteredSessions.length === 0) {
    const emptyMsg = sessionSearchQuery
      ? `   ${A.fgMuted}No sessions matching "${sessionSearchQuery}"${A.reset}`
      : `   ${A.fgMuted}(No saved sessions found)${A.reset}`;
    pushLine(emptyMsg);
    for (let i = 1; i < listRows; i++) pushLine("");
  } else {
    // Windowed scrolling calculation
    const visibleCount = listRows;
    let viewStart = 0;
    if (sessionPickerIdx >= visibleCount) {
      viewStart = sessionPickerIdx - visibleCount + 1;
    }
    const viewEnd = Math.min(filteredSessions.length, viewStart + visibleCount);

    for (let i = viewStart; i < viewEnd; i++) {
      const isSel = i === sessionPickerIdx;
      const s = filteredSessions[i];
      const isCur = s.sessionId === currentSessionId || s.isCurrent;

      const bullet = isSel ? `${A.fgGreen}●${A.reset}` : ` `;
      const currentBadge = isCur ? ` ${A.fgCyan}(current)${A.reset}` : "";

      // Model & Provider info
      const providerPart = s.provider ? s.provider : "";
      const modelPart = s.model ? s.model : "";
      let comboPart = "";
      if (providerPart && modelPart) {
        comboPart = `${providerPart}/${modelPart}`;
      } else if (modelPart) {
        comboPart = modelPart;
      } else if (providerPart) {
        comboPart = providerPart;
      } else {
        comboPart = "no model";
      }

      const msgsPart = `${s.messagesCount} msgs`;
      const timePart = formatRelativeTime(s.updatedAt);

      // Workspace note if different from current
      let wsPart = "";
      if (s.workspace && currentWorkspace && s.workspace !== currentWorkspace) {
        const shortWs = s.workspace.split("/").filter(Boolean).slice(-2).join("/");
        wsPart = ` [${shortWs}]`;
      }

      // Metadata string
      const maxComboLen = 30;
      const cleanCombo = truncate(comboPart, maxComboLen);
      const metaStr = `${A.fgSubtext}· ${cleanCombo} · ${msgsPart} · ${timePart}${wsPart}${A.reset}`;

      // Left part (Session ID / Name)
      const maxNameLen = Math.max(20, boxW - 50);
      const cleanName = truncate(s.name ? `${s.name} (${s.sessionId})` : s.sessionId, maxNameLen);
      const idStyled = isSel
        ? `${A.bold}${A.fgText}${cleanName}${A.reset}`
        : `${A.fgText}${cleanName}${A.reset}`;

      const fullLineContent = ` ${bullet} ${idStyled}${currentBadge}  ${metaStr}`;
      pushLine(fullLineContent);
    }

    const rendered = viewEnd - viewStart;
    for (let i = rendered; i < listRows; i++) {
      pushLine("");
    }
  }

  // Footer bar with shortcuts
  const footerText = " ↑↓ Navigate │ Enter Resume │ D Delete │ Esc Close ";
  const botBarLen = Math.max(0, boxW - 2 - stripAnsi(footerText).length);
  const bottomBorder =
    A.fgBorder + "└" + A.fgSubtext + footerText + A.fgBorder + "─".repeat(botBarLen) + "┘" + A.reset;
  out.push(T.goto(curRow, startCol) + bottomBorder);

  return out.join("");
}
