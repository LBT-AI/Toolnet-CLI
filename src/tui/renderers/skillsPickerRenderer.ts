import { A } from "../../term";
import { stripAnsi, truncate } from "../layout";
import type { SkillInfo } from "../../lib/skillsLoader";
import { composeBox, computeBoxGeometry } from "./composeBox";

export interface SkillsPickerState {
  filteredSkills: SkillInfo[];
  skillsPickerIdx: number;
  skillsSearchQuery: string;
  selectedSkillDetail: SkillInfo | null;
  isLoading?: boolean;
}

const MAX_DISPLAY = 10;

export function renderSkillsPickerBox(
  cols: number,
  rows: number,
  state: SkillsPickerState
): string {
  if (state.selectedSkillDetail) {
    return renderSkillDetailBox(cols, rows, state.selectedSkillDetail, state.isLoading);
  }

  const isNarrow = cols < 60;
  const { boxW } = computeBoxGeometry(cols, rows, Math.min(state.filteredSkills.length, MAX_DISPLAY) + 3, true, isNarrow ? 46 : 56);

  const body: string[] = [];

  const query = state.skillsSearchQuery
    ? state.skillsSearchQuery + "█"
    : A.fgMuted + "Type to filter…" + A.reset;
  body.push(A.fgSubtext + "Search " + A.reset + (state.skillsSearchQuery ? A.fgText + query + A.reset : query));
  body.push("");

  const countStr = `${state.filteredSkills.length} skill${state.filteredSkills.length === 1 ? "" : "s"}`;
  const title = `Skills (${countStr})`;

  const listStart = Math.max(0, Math.min(state.skillsPickerIdx - Math.floor(MAX_DISPLAY / 2), Math.max(0, state.filteredSkills.length - MAX_DISPLAY)));
  const visible = state.filteredSkills.slice(listStart, listStart + Math.min(MAX_DISPLAY, state.filteredSkills.length));

  for (let i = 0; i < visible.length; i++) {
    const skillIdx = listStart + i;
    const skill = visible[i];
    const selected = skillIdx === state.skillsPickerIdx;
    const statusDot = skill.enabled ? A.fgGreen + "●" + A.reset : A.fgMuted + "○" + A.reset;

    let sourceBadge = "";
    if (skill.source === "workspace") sourceBadge = A.fgCyan + "· workspace" + A.reset;
    else if (skill.source === "global") sourceBadge = A.fgViolet + "· global" + A.reset;
    else sourceBadge = A.fgYellow + "· toolnet" + A.reset;

    const maxNameLen = 20;
    const paddedName = (skill.id || skill.name).padEnd(maxNameLen, " ").slice(0, maxNameLen);
    const descMaxLen = Math.max(6, boxW - maxNameLen - 22);
    const descText = truncate(skill.description || "", descMaxLen);

    if (selected) {
      const fgName = skill.enabled ? A.bold + A.fgText : A.fgMuted;
      body.push(
        A.bgOverlay + "  " + A.fgCyan + "● " + A.reset +
        A.bgOverlay + statusDot + " " + A.bgOverlay + fgName + paddedName + A.reset + " " + A.fgSubtext + descText + A.reset +
        " " + sourceBadge
      );
    } else {
      const nameColor = skill.enabled ? A.bold + A.fgText : A.fgMuted;
      body.push("   " + statusDot + " " + nameColor + paddedName + A.reset + " " + A.fgSubtext + descText + A.reset + " " + sourceBadge);
    }
  }

  if (state.filteredSkills.length > MAX_DISPLAY) {
    body.push(A.fgMuted + "… and " + (state.filteredSkills.length - MAX_DISPLAY) + " more" + A.reset);
  }

  return composeBox(cols, rows, {
    title,
    body,
    footer: "↑↓ navigate · enter view · esc close",
  }).join("");
}

function renderSkillDetailBox(
  cols: number,
  rows: number,
  skill: SkillInfo,
  isLoading?: boolean
): string {
  const isNarrow = cols < 60;
  const { boxW } = computeBoxGeometry(cols, rows, 8, true, isNarrow ? 46 : 58);

  const body: string[] = [];

  let statusStr = skill.enabled
    ? A.fgGreen + A.bold + "● Enabled" + A.reset + A.fgMuted + " (space toggle)" + A.reset
    : A.fgRed + A.bold + "○ Disabled" + A.reset + A.fgMuted + " (space toggle)" + A.reset;
  if (skill.isOfflineCache) statusStr += A.fgYellow + " [offline]" + A.reset;

  let sourceText = skill.source;
  if (skill.source === "workspace") sourceText = A.fgCyan + "workspace" + A.reset;
  else if (skill.source === "global") sourceText = A.fgViolet + "global" + A.reset;
  else sourceText = A.fgYellow + "toolnet" + A.reset;

  const val = (label: string) => A.fgSubtext + label + A.reset;
  body.push(val("ID") + "          " + A.bold + A.fgText + skill.id + A.reset);
  body.push(val("Source") + "      " + sourceText);
  if (skill.version) body.push(val("Version") + "     " + A.fgCyan + "v" + skill.version + A.reset);
  body.push(val("Status") + "      " + statusStr);
  body.push(val("Path") + "        " + A.fgMuted + truncate(skill.filepath || "", boxW - 16) + A.reset);
  body.push(val("Description") + " " + truncate(skill.description || "(no description)", boxW - 18));
  body.push("");
  body.push(A.bold + A.fgText + "Instructions / Workflow" + A.reset);

  if (isLoading) {
    body.push("  " + A.fgCyan + "Fetching full SKILL.md instructions…" + A.reset);
  } else {
    const rawLines = (skill.instructions || skill.description || "(No instructions)")
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .slice(0, 3);
    for (const l of rawLines) body.push("  " + A.fgSubtext + truncate(l, boxW - 8) + A.reset);
  }

  return composeBox(cols, rows, {
    title: "Skill · " + truncate(skill.name, 36),
    body,
    footer: "space/e toggle · esc/backspace back",
  }).join("");
}