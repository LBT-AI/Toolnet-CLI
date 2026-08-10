import { A, T, write, getSize } from "../term";

export class ProviderPickerState {
  show = false;
  idx = 0;
  list = ["toolnet", "openai", "anthropic", "gemini", "groq", "cohere", "openrouter", "deepseek", "minimax"];

  open(setStatus: (s: string) => void, renderAll: () => void) {
    this.show = true;
    this.idx = 0;
    setStatus("↑↓ navigate  Enter select  Esc cancel");
    renderAll();
  }

  handleKey(hex: string, callbacks: { renderAll: () => void, setStatus: (s: string) => void, onSelect: (sel: string) => void }) {
    if (hex === "1b5b41" || hex === "1b4f41") { // Up
      this.idx = this.idx <= 0 ? this.list.length - 1 : this.idx - 1;
      callbacks.renderAll(); 
      this.render();
    } else if (hex === "1b5b42" || hex === "1b4f42") { // Down
      this.idx = this.idx >= this.list.length - 1 ? 0 : this.idx + 1;
      callbacks.renderAll(); 
      this.render();
    } else if (hex === "0d" || hex === "0a") { // Enter
      const sel = this.list[this.idx];
      this.show = false;
      callbacks.onSelect(sel);
    } else if (hex === "1b") { // Esc
      this.show = false;
      callbacks.setStatus("");
      callbacks.renderAll();
    }
  }

  render() {
    const { cols, rows } = getSize();
    const boxW = Math.min(50, cols - 4);
    const boxH = Math.min(15, rows - 6);
    const startRow = Math.floor((rows - boxH) / 2);
    const startCol = Math.floor((cols - boxW) / 2);

    const out: string[] = [];
    out.push(T.goto(startRow, startCol));
    out.push(A.bgSurface + A.fgMagenta + A.bold + "┌" + "─".repeat(boxW - 2) + "┐" + A.reset);

    out.push(T.goto(startRow + 1, startCol));
    const titleText = " Select Provider ";
    const titlePad = Math.max(0, boxW - 2 - titleText.length);
    out.push(A.bgSurface + A.fgMagenta + A.bold + "│" + titleText + " ".repeat(titlePad) + "│" + A.reset);

    out.push(T.goto(startRow + 2, startCol));
    out.push(A.bgSurface + A.fgMagenta + "│" + "─".repeat(boxW - 2) + "│" + A.reset);

    const listRows = boxH - 4;
    const listStart = Math.max(0, this.idx - Math.floor(listRows / 2));
    const visible = this.list.slice(listStart, listStart + listRows);

    for (let i = 0; i < listRows; i++) {
      out.push(T.goto(startRow + 3 + i, startCol));
      const modelIdx = listStart + i;
      const model = visible[i];
      if (!model) {
        out.push(A.bgSurface + A.fgMagenta + "│" + " ".repeat(boxW - 2) + "│" + A.reset);
      } else {
        const isSel = modelIdx === this.idx;
        const text = isSel ? " ▶ " + model : "   " + model;
        const pad = Math.max(0, boxW - 2 - text.length);
        if (isSel) {
          // Changed A.bgPrimary to A.bgOverlay since A.bgPrimary is not defined in A
          out.push(A.bgOverlay + A.fgMagenta + A.bold + "│" + text + " ".repeat(pad) + "│" + A.reset);
        } else {
          out.push(A.bgSurface + A.fgText + "│" + text + " ".repeat(pad) + "│" + A.reset);
        }
      }
    }

    out.push(T.goto(startRow + boxH - 1, startCol));
    out.push(A.bgSurface + A.fgMagenta + A.bold + "└" + "─".repeat(boxW - 2) + "┘" + A.reset);
    write(out.join(""));
  }
}

export const providerPicker = new ProviderPickerState();
