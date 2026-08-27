import { A, T } from "../../term";
import { truncate, stripAnsi } from "../layout";
import { getModelTags } from "../../lib/modelTags";

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
  const boxW = Math.min(60, cols - 4);
  const boxH = Math.min(20, rows - 6);
  const startRow = Math.floor((rows - boxH) / 2);
  const startCol = Math.floor((cols - boxW) / 2);

  const out: string[] = [];

  // Top border
  out.push(T.goto(startRow, startCol));
  out.push(A.bgSurface + A.fgBlue + A.bold + "┌" + "─".repeat(boxW - 2) + "┐" + A.reset);

  // Title
  out.push(T.goto(startRow + 1, startCol));
  const titleText = " Select Model (" + state.filteredModels.length + " available) ";
  const titlePad = Math.max(0, boxW - 2 - titleText.length);
  out.push(A.bgSurface + A.fgBlue + A.bold + "│" + titleText + " ".repeat(titlePad) + "│" + A.reset);

  // Search bar
  out.push(T.goto(startRow + 2, startCol));
  const searchInput = state.modelSearchQuery + "█";
  const searchDisp = " Search: " + searchInput;
  const searchPad = Math.max(0, boxW - 2 - searchDisp.length);
  out.push(A.bgSurface + A.fgBlue + "│" + A.fgText + searchDisp + " ".repeat(searchPad) + A.fgBlue + "│" + A.reset);

  // Separator
  out.push(T.goto(startRow + 3, startCol));
  out.push(A.bgSurface + A.fgBlue + "│" + "─".repeat(boxW - 2) + "│" + A.reset);

  // Models list
  const listRows = boxH - 5;
  const listStart = Math.max(0, state.modelPickerIdx - Math.floor(listRows / 2));
  const visible = state.filteredModels.slice(listStart, listStart + listRows);

  for (let i = 0; i < listRows; i++) {
    out.push(T.goto(startRow + 4 + i, startCol));
    const modelIdx = listStart + i;
    const model = visible[i];
    if (!model) {
      out.push(A.bgSurface + A.fgBlue + "│" + " ".repeat(boxW - 2) + "│" + A.reset);
    } else {
      const selected = modelIdx === state.modelPickerIdx;
      const current = model === state.currentModel;
      const marker = selected ? "▸ " : current ? "✔ " : "  ";
      const tags = getModelTags(model);
      const text = truncate(marker + model, boxW - 3 - tags.length);
      const textPad = Math.max(0, boxW - 3 - stripAnsi(text).length - tags.length);
      const fg = selected ? A.fgYellow + A.bold : current ? A.fgGreen : A.fgText;
      const bg = selected ? A.bgOverlay : A.bgSurface;
      const tagsFmt = tags ? A.fgSubtext + A.dim + tags + A.reset : "";
      out.push(bg + A.fgBlue + "│" + fg + " " + text + tagsFmt + " ".repeat(textPad) + A.reset + A.bgSurface + A.fgBlue + "│" + A.reset);
    }
  }

  // Bottom border
  out.push(T.goto(startRow + boxH - 1, startCol));
  out.push(A.bgSurface + A.fgBlue + "└" + "─".repeat(boxW - 2) + "┘" + A.reset);

  return out.join("");
}
