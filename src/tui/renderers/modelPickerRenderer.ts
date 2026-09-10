import { A } from "../../term";
import { stripAnsi, truncate } from "../layout";
import { getModelTags } from "../../lib/modelTags";
import { getModelCapabilities } from "../../lib/reasoning";
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
  const total = filtered.length;
  const winSize = Math.min(MAX_DISPLAY, total);
  // Defensive clamp: index must never escape [0, total-1].
  const idx = Math.max(0, Math.min(state.modelPickerIdx, total - 1));
  // Auto-scroll: keep the selection centered in the window, clamped to bounds.
  const listStart = Math.max(0, Math.min(idx - Math.floor(winSize / 2), Math.max(0, total - winSize)));
  const visible = filtered.slice(listStart, listStart + winSize);

  const isNarrow = cols < 60;
  const { boxW } = computeBoxGeometry(cols, rows, winSize + 3, true, isNarrow ? 46 : 60);

  const body: string[] = [];

  // Compact search line
  const query = state.modelSearchQuery
    ? state.modelSearchQuery + "█"
    : A.fgMuted + "Type to filter…" + A.reset;
  body.push(A.fgSubtext + "Search " + A.reset + (state.modelSearchQuery ? A.fgText + query + A.reset : query));

  body.push("");

  for (let i = 0; i < visible.length; i++) {
    const modelIdx = listStart + i;
    const model = visible[i];
    const selected = modelIdx === state.modelPickerIdx;
    const isCurrent = model === state.currentModel;
    const tags = getModelTags(model);
    // Capability badge — from the API's model metadata (not name guessing).
    // Narrow terminals get a compact "R" marker right after the name (so it
    // is never pushed off the end of the row by the descriptive tags).
    const caps = getModelCapabilities(model);
    const capBadge = caps?.reasoning
      ? isNarrow
        ? A.fgCyan + A.bold + " R" + A.reset
        : A.fgCyan + A.bold + "  THINKING" + A.reset
      : "";
    const maxText = Math.max(8, boxW - 14 - stripAnsi(tags + capBadge).length);
    let text = truncate(model, maxText);
    if (isNarrow && caps?.reasoning) {
      // Keep "R" glued to the model id on mobile even when the row is tight.
      const nameCap = Math.max(6, boxW - 18 - stripAnsi(tags).length);
      text = truncate(model, nameCap);
      text += capBadge;
    }
    if (selected) {
      const line = A.bgOverlay + "  " + A.fgCyan + A.bold + "● " + A.reset + A.bgOverlay + A.fgText + A.bold + text + A.reset + A.bgOverlay + " " + A.fgMuted + tags + capBadge + A.reset;
      body.push(line);
    } else {
      const marker = isCurrent ? A.fgGreen + "✓ " + A.reset : "  ";
      body.push(marker + A.fgText + text + A.reset + " " + A.fgMuted + tags + capBadge + A.reset);
    }
  }

  if (total > winSize) {
    body.push(A.fgMuted + "… and " + (total - winSize) + " more" + A.reset);
  }

  return composeBox(cols, rows, {
    title: "Select model",
    body,
    footer: "↑↓ navigate · enter select · esc close",
  }).join("");
}