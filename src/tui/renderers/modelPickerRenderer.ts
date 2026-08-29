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
  const boxW = Math.min(65, Math.max(30, cols - 4));
  const boxH = Math.min(18, Math.max(8, rows - 6));
  const startRow = Math.floor((rows - boxH) / 2);
  const startCol = Math.floor((cols - boxW) / 2);

  const out: string[] = [];

  // Top border with Title
  out.push(T.goto(startRow, startCol));
  const title = ` Select Model (${state.filteredModels.length}) `;
  const topBorder = A.fgBorder + "┌─" + A.bold + A.fgCyan + title + A.reset + A.fgBorder + "─".repeat(Math.max(0, boxW - 2 - title.length - 2)) + "┐" + A.reset;
  out.push(topBorder);

  // Search input row
  out.push(T.goto(startRow + 1, startCol));
  const searchInput = state.modelSearchQuery ? state.modelSearchQuery + "█" : A.fgMuted + "Type to filter..." + A.reset;
  const searchLabel = A.fgSubtext + " Filter: " + A.reset + searchInput;
  const searchPad = Math.max(0, boxW - 2 - stripAnsi(searchLabel).length);
  out.push(A.fgBorder + "│" + A.reset + searchLabel + " ".repeat(searchPad) + A.fgBorder + "│" + A.reset);

  // Separator
  out.push(T.goto(startRow + 2, startCol));
  out.push(A.fgBorder + "├" + "─".repeat(boxW - 2) + "┤" + A.reset);

  // Models list
  const listRows = Math.max(1, boxH - 5);
  const listStart = Math.max(0, Math.min(state.modelPickerIdx - Math.floor(listRows / 2), Math.max(0, state.filteredModels.length - listRows)));
  const visible = state.filteredModels.slice(listStart, listStart + listRows);

  for (let i = 0; i < listRows; i++) {
    out.push(T.goto(startRow + 3 + i, startCol));
    const modelIdx = listStart + i;
    const model = visible[i];
    if (!model) {
      out.push(A.fgBorder + "│" + " ".repeat(boxW - 2) + "│" + A.reset);
    } else {
      const selected = modelIdx === state.modelPickerIdx;
      const isCurrent = model === state.currentModel;
      const marker = selected ? A.fgCyan + "● " + A.reset : isCurrent ? A.fgGreen + "✓ " + A.reset : "  ";
      const tags = getModelTags(model);
      const text = truncate(model, boxW - 10 - tags.length);
      const fg = selected ? A.bold + A.fgCyan : isCurrent ? A.fgGreen : A.fgText;
      const bg = selected ? A.bgOverlay : "";
      const tagsFmt = tags ? " " + A.fgMuted + tags + A.reset : "";
      const lineContent = marker + fg + text + A.reset + tagsFmt;
      const textPad = Math.max(0, boxW - 2 - stripAnsi(lineContent).length - 1);
      out.push(A.fgBorder + "│" + A.reset + bg + " " + lineContent + " ".repeat(textPad) + A.reset + A.fgBorder + "│" + A.reset);
    }
  }

  // Footer navigation hint & bottom border
  out.push(T.goto(startRow + boxH - 2, startCol));
  const hint = A.fgMuted + " ↑↓ navigate │ Enter select │ Esc close" + A.reset;
  const hintPad = Math.max(0, boxW - 2 - stripAnsi(hint).length);
  out.push(A.fgBorder + "│" + A.reset + hint + " ".repeat(hintPad) + A.fgBorder + "│" + A.reset);

  out.push(T.goto(startRow + boxH - 1, startCol));
  out.push(A.fgBorder + "└" + "─".repeat(boxW - 2) + "┘" + A.reset);

  return out.join("");
}
