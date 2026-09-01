import { A, T } from "../../term";
import { truncate, stripAnsi } from "../layout";
import type { SkillInfo } from "../../lib/skillsLoader";

export interface SkillsPickerState {
  filteredSkills: SkillInfo[];
  skillsPickerIdx: number;
  skillsSearchQuery: string;
  selectedSkillDetail: SkillInfo | null;
  isLoading?: boolean;
}

export function renderSkillsPickerBox(
  cols: number,
  rows: number,
  state: SkillsPickerState
): string {
  // If viewing detail of a selected skill
  if (state.selectedSkillDetail) {
    return renderSkillDetailBox(cols, rows, state.selectedSkillDetail, state.isLoading);
  }

  const boxW = Math.min(76, Math.max(40, cols - 4));
  const boxH = Math.min(22, Math.max(10, rows - 4));
  const startRow = Math.floor((rows - boxH) / 2);
  const startCol = Math.floor((cols - boxW) / 2);

  const out: string[] = [];

  // Top border with Title: Skills (<n> skills)
  out.push(T.goto(startRow, startCol));
  const count = state.filteredSkills.length;
  const countStr = `${count} skill${count === 1 ? "" : "s"}`;
  const title = ` Skills (${countStr}) `;
  const topBorder =
    A.fgBorder +
    "┌─" +
    A.bold +
    A.fgCyan +
    title +
    A.reset +
    A.fgBorder +
    "─".repeat(Math.max(0, boxW - 2 - title.length - 2)) +
    "┐" +
    A.reset;
  out.push(topBorder);

  // Search input row
  out.push(T.goto(startRow + 1, startCol));
  const searchInput = state.skillsSearchQuery
    ? state.skillsSearchQuery + "█"
    : A.fgMuted + "Type to filter..." + A.reset;
  const searchLabel = A.fgSubtext + " Filter: " + A.reset + searchInput;
  const searchPad = Math.max(0, boxW - 2 - stripAnsi(searchLabel).length);
  out.push(A.fgBorder + "│" + A.reset + searchLabel + " ".repeat(searchPad) + A.fgBorder + "│" + A.reset);

  // Separator
  out.push(T.goto(startRow + 2, startCol));
  out.push(A.fgBorder + "├" + "─".repeat(boxW - 2) + "┤" + A.reset);

  // Skills list with source badges
  const listRows = Math.max(1, boxH - 5);
  const listStart = Math.max(
    0,
    Math.min(
      state.skillsPickerIdx - Math.floor(listRows / 2),
      Math.max(0, state.filteredSkills.length - listRows)
    )
  );
  const visible = state.filteredSkills.slice(listStart, listStart + listRows);

  for (let i = 0; i < listRows; i++) {
    out.push(T.goto(startRow + 3 + i, startCol));
    const skillIdx = listStart + i;
    const skill = visible[i];

    if (!skill) {
      out.push(A.fgBorder + "│" + " ".repeat(boxW - 2) + "│" + A.reset);
      continue;
    }

    const selected = skillIdx === state.skillsPickerIdx;
    const marker = selected ? A.fgCyan + "● " + A.reset : "  ";
    const statusDot = skill.enabled ? A.fgGreen + "●" + A.reset : A.fgMuted + "○" + A.reset;

    let sourceBadge = `· ${skill.source}`;
    if (skill.source === "workspace") {
      sourceBadge = A.fgCyan + `· workspace` + A.reset;
    } else if (skill.source === "global") {
      sourceBadge = A.fgMagenta + `· global` + A.reset;
    } else if (skill.source === "toolnet") {
      sourceBadge = A.fgYellow + `· toolnet` + A.reset;
    }

    if (skill.isOfflineCache) {
      sourceBadge += A.fgMuted + " (offline)" + A.reset;
    }

    const nameText = skill.id || skill.name;
    const maxNameLen = 22;
    const paddedName = nameText.padEnd(maxNameLen, " ").slice(0, maxNameLen);

    const descMaxLen = Math.max(10, boxW - maxNameLen - 24);
    const descText = truncate(skill.description || "", descMaxLen);

    const fgName = selected ? A.bold + A.fgCyan : skill.enabled ? A.bold + A.fgText : A.fgMuted;
    const fgDesc = selected ? A.fgSubtext : A.fgMuted;
    const bg = selected ? A.bgOverlay : "";

    const lineContent = `${marker}${statusDot} ${fgName}${paddedName}${A.reset} ${fgDesc}${descText}${A.reset} ${sourceBadge}`;
    const textPad = Math.max(0, boxW - 2 - stripAnsi(lineContent).length - 1);
    out.push(A.fgBorder + "│" + A.reset + bg + " " + lineContent + " ".repeat(textPad) + A.reset + A.fgBorder + "│" + A.reset);
  }

  // Footer navigation hint & bottom border
  out.push(T.goto(startRow + boxH - 2, startCol));
  const hint = A.fgMuted + " ↑↓ Navigate │ Enter View │ Esc Cancel │ Type to filter" + A.reset;
  const hintPad = Math.max(0, boxW - 2 - stripAnsi(hint).length);
  out.push(A.fgBorder + "│" + A.reset + hint + " ".repeat(hintPad) + A.fgBorder + "│" + A.reset);

  out.push(T.goto(startRow + boxH - 1, startCol));
  out.push(A.fgBorder + "└" + "─".repeat(boxW - 2) + "┘" + A.reset);

  return out.join("");
}

function renderSkillDetailBox(
  cols: number,
  rows: number,
  skill: SkillInfo,
  isLoading?: boolean
): string {
  const boxW = Math.min(80, Math.max(44, cols - 4));
  const boxH = Math.min(24, Math.max(14, rows - 4));
  const startRow = Math.floor((rows - boxH) / 2);
  const startCol = Math.floor((cols - boxW) / 2);

  const out: string[] = [];

  // Top border with Title
  out.push(T.goto(startRow, startCol));
  const title = ` Skill: ${skill.name} `;
  const topBorder =
    A.fgBorder +
    "┌─" +
    A.bold +
    A.fgCyan +
    title +
    A.reset +
    A.fgBorder +
    "─".repeat(Math.max(0, boxW - 2 - title.length - 2)) +
    "┐" +
    A.reset;
  out.push(topBorder);

  let curRow = startRow + 1;

  const pushLine = (formattedText: string) => {
    out.push(T.goto(curRow++, startCol));
    const pad = Math.max(0, boxW - 2 - stripAnsi(formattedText).length);
    out.push(A.fgBorder + "│" + A.reset + formattedText + " ".repeat(pad) + A.fgBorder + "│" + A.reset);
  };

  // Status text
  let statusStr = skill.enabled
    ? A.fgGreen + A.bold + "● Enabled" + A.reset + A.fgMuted + " (Press Space to toggle)" + A.reset
    : A.fgRed + A.bold + "○ Disabled" + A.reset + A.fgMuted + " (Press Space to toggle)" + A.reset;

  if (skill.isOfflineCache) {
    statusStr += A.fgYellow + " [Offline cache]" + A.reset;
  }

  // Source display
  let sourceText: string = skill.source;
  if (skill.source === "workspace") sourceText = `${A.fgCyan}workspace${A.reset} (.agents/skills)`;
  else if (skill.source === "global") sourceText = `${A.fgMagenta}global${A.reset} (~/.toolnet-cli/skills)`;
  else if (skill.source === "toolnet") sourceText = `${A.fgYellow}toolnet${A.reset} (https://skills.toolnet.tech/mcp)`;

  pushLine(` ${A.fgSubtext}ID:${A.reset}          ${A.bold}${A.fgText}${skill.id}${A.reset}`);
  pushLine(` ${A.fgSubtext}Source:${A.reset}      ${sourceText}`);
  if (skill.version) {
    pushLine(` ${A.fgSubtext}Version:${A.reset}     ${A.fgCyan}v${skill.version}${A.reset}`);
  }
  if (skill.tags && skill.tags.length > 0) {
    pushLine(` ${A.fgSubtext}Tags:${A.reset}        ${A.fgMuted}${skill.tags.join(", ")}${A.reset}`);
  }
  pushLine(` ${A.fgSubtext}Status:${A.reset}      ${statusStr}`);
  if (skill.filepath) {
    pushLine(` ${A.fgSubtext}Path:${A.reset}        ${A.fgMuted}${truncate(skill.filepath, boxW - 14)}${A.reset}`);
  }
  pushLine(` ${A.fgSubtext}Description:${A.reset} ${truncate(skill.description || "(no description)", boxW - 18)}`);

  // Divider
  out.push(T.goto(curRow++, startCol));
  out.push(A.fgBorder + "├" + "─".repeat(boxW - 2) + "┤" + A.reset);

  // Instructions header & preview
  pushLine(` ${A.bold}${A.fgText}Instructions / Workflow:${A.reset}`);
  const maxInstLines = Math.max(1, startRow + boxH - 2 - curRow);

  if (isLoading) {
    pushLine(`   ${A.fgCyan}Fetching full SKILL.md instructions from ToolNet MCP...${A.reset}`);
    for (let i = 1; i < maxInstLines; i++) pushLine("");
  } else {
    const rawLines = (skill.instructions || skill.description || "(No instructions)")
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);

    for (let i = 0; i < maxInstLines; i++) {
      const l = rawLines[i];
      if (l !== undefined) {
        pushLine(`   ${A.fgSubtext}${truncate(l, boxW - 6)}${A.reset}`);
      } else {
        pushLine("");
      }
    }
  }

  // Footer navigation hint
  out.push(T.goto(startRow + boxH - 2, startCol));
  const hint = A.fgMuted + " Space/E Toggle Enable │ Esc/Backspace Back to list" + A.reset;
  const hintPad = Math.max(0, boxW - 2 - stripAnsi(hint).length);
  out.push(A.fgBorder + "│" + A.reset + hint + " ".repeat(hintPad) + A.fgBorder + "│" + A.reset);

  // Bottom border
  out.push(T.goto(startRow + boxH - 1, startCol));
  out.push(A.fgBorder + "└" + "─".repeat(boxW - 2) + "┘" + A.reset);

  return out.join("");
}
