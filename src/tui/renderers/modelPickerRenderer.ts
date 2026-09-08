import { A } from "../../term";
import { stripAnsi, truncate } from "../layout";
import { getModelTags } from "../../lib/modelTags";
import { composeBox, computeBoxGeometry } from "./composeBox";

const MAX_DISPLAY = 10;

export function renderModelPickerBox(
  cols: number,
  rows: number,
  state: {
    filteredModels: string[];
    modelPickerIdx: number;
    currentModel: string;
    modelSearchQuery: string;
  }
): string {
  const filtered = state.filteredModels.length > 0 ? state.filteredModels : ["No models available"];
  const list = filtered.slice(0, MAX_DISPLAY);

  const isNarrow = cols < 60;
  const { boxW } = computeBoxGeometry(cols, rows, list.length + 3, true, isNarrow ? 46 : 60);

  const body: string[] = [];

  // Compact search line
  const query = state.modelSearchQuery
    ? state.modelSearchQuery + "█"
    : A.fgMuted + "Type to filter…" + A.reset;
  body.push(A.fgSubtext + "Search " + A.reset + (state.modelSearchQuery ? A.fgText + query + A.reset : query));

  body.push("");

  const listStart = Math.max(0, Math.min(state.modelPickerIdx - Math.floor(MAX_DISPLAY / 2), Math.max(0, list.length - MAX_DISPLAY)));
  const visible = list.slice(listStart, listStart + Math.min(MAX_DISPLAY, list.length));

  for (let i = 0; i < visible.length; i++) {
    const modelIdx = listStart + i;
    const model = visible[i];
    const selected = modelIdx === state.modelPickerIdx;
    const isCurrent = model === state.currentModel;
    const tags = getModelTags(model);
    const maxText = Math.max(8, boxW - 14 - stripAnsi(tags).length);
    const text = truncate(model, maxText);
    if (selected) {
      const line = A.bgOverlay + "  " + A.fgCyan + A.bold + "● " + A.reset + A.bgOverlay + A.fgText + A.bold + text + A.reset + A.bgOverlay + " " + A.fgMuted + tags + A.reset;
      body.push(line);
    } else {
      const marker = isCurrent ? A.fgGreen + "✓ " + A.reset : "  ";
      body.push(marker + A.fgText + text + A.reset + " " + A.fgMuted + tags + A.reset);
    }
  }

  if (list.length > MAX_DISPLAY) {
    body.push(A.fgMuted + "… and " + (filtered.length - MAX_DISPLAY) + " more" + A.reset);
  }

  return composeBox(cols, rows, {
    title: "Select model",
    body,
    footer: "↑↓ navigate · enter select · esc close",
  }).join("");
}