import { getSize } from "../term";
import { A } from "../term";
import { truncate } from "../tui/layout";
import { composeBox, computeBoxGeometry } from "../tui/renderers/composeBox";

const MAX_DISPLAY = 10;

export class ProviderPickerState {
  show = false;
  idx = 0;
  list = [
    "toolnet",
    "alibaba",
    "openai",
    "anthropic",
    "gemini",
    "deepseek",
    "groq",
    "openrouter",
    "together",
    "mistral",
    "xai",
    "minimax",
    "cohere",
  ];

  open(setStatus: (s: string) => void, renderAll: () => void) {
    this.show = true;
    this.idx = 0;
    setStatus("");
    renderAll();
  }

  handleKey(hex: string, callbacks: { renderAll: () => void, setStatus: (s: string) => void, onSelect: (sel: string) => void }) {
    if (hex === "1b5b41" || hex === "1b4f41") { // Up
      this.idx = this.idx <= 0 ? this.list.length - 1 : this.idx - 1;
      callbacks.renderAll();
    } else if (hex === "1b5b42" || hex === "1b4f42") { // Down
      this.idx = this.idx >= this.list.length - 1 ? 0 : this.idx + 1;
      callbacks.renderAll();
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

  /** Pure renderer — returns the box as a string (never writes to stdout). */
  renderToString(): string {
    const { cols, rows } = getSize();
    const isNarrow = cols < 60;
    const { boxW } = computeBoxGeometry(cols, rows, Math.min(this.list.length, MAX_DISPLAY) + 3, true, isNarrow ? 40 : 48);

    const body: string[] = [];
    const listStart = Math.max(0, this.idx - Math.floor(MAX_DISPLAY / 2));
    const visible = this.list.slice(listStart, listStart + Math.min(MAX_DISPLAY, this.list.length));

    for (let i = 0; i < visible.length; i++) {
      const modelIdx = listStart + i;
      const model = visible[i];
      const isSel = modelIdx === this.idx;
      const text = truncate(model, boxW - 10);
      if (isSel) {
        body.push(A.bgOverlay + "  " + A.fgViolet + A.bold + "● " + A.reset + A.bgOverlay + A.bold + A.fgText + text + A.reset);
      } else {
        body.push("   " + A.fgText + text + A.reset);
      }
    }

    if (this.list.length > MAX_DISPLAY) {
      body.push(A.fgMuted + "… and " + (this.list.length - MAX_DISPLAY) + " more" + A.reset);
    }

    return composeBox(cols, rows, {
      title: "Select provider",
      body,
      footer: "↑↓ navigate · enter select · esc cancel",
      accent: A.fgViolet,
    }).join("");
  }
}

export const providerPicker = new ProviderPickerState();