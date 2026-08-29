import { A, T } from "../../term";
import { truncate, stripAnsi } from "../layout";
import { getCliKey, maskApiKey, StoredKeyInfo } from "../../lib/keys";
import { listProviders } from "../../providers/registry";

export interface KeyManagerProviderItem {
  id: string;
  name: string;
  isConfigured: boolean;
  maskedKey: string;
}

export const DEFAULT_KEY_PROVIDERS = [
  "toolnet",
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "groq",
  "openrouter",
  "alibaba",
  "together",
  "mistral",
  "xai",
  "minimax",
  "cohere",
];

export function getKeyManagerProviders(): KeyManagerProviderItem[] {
  const items: KeyManagerProviderItem[] = [];
  const seen = new Set<string>();

  // 1. First add registry providers
  try {
    const reg = listProviders();
    for (const p of reg) {
      const id = p.id.toLowerCase();
      if (!seen.has(id)) {
        seen.add(id);
        const rawKey = p.apiKey || (p.apiKeyEnv ? process.env[p.apiKeyEnv] : null) || getCliKey(id);
        items.push({
          id,
          name: p.name || id,
          isConfigured: Boolean(rawKey),
          maskedKey: rawKey ? maskApiKey(rawKey) : "",
        });
      }
    }
  } catch {}

  // 2. Add standard known providers
  for (const id of DEFAULT_KEY_PROVIDERS) {
    if (!seen.has(id)) {
      seen.add(id);
      const rawKey = getCliKey(id);
      items.push({
        id,
        name: id,
        isConfigured: Boolean(rawKey),
        maskedKey: rawKey ? maskApiKey(rawKey) : "",
      });
    }
  }

  return items;
}

export function renderKeyManagerBox(
  cols: number,
  rows: number,
  state: {
    keyManagerIdx: number;
    keyManagerInput: { provider: string; buffer: string } | null;
    keyManagerConfirmDelete?: string | null;
  }
): string {
  const boxW = Math.min(65, Math.max(40, cols - 4));
  const out: string[] = [];

  // Mode 1: Inputting Key Mode
  if (state.keyManagerInput) {
    const inputH = 7;
    const startRow = Math.floor((rows - inputH) / 2);
    const startCol = Math.floor((cols - boxW) / 2);

    out.push(T.goto(startRow, startCol));
    const title = ` Set Key: ${state.keyManagerInput.provider} `;
    out.push(A.fgBorder + "┌─" + A.bold + A.fgCyan + title + A.reset + A.fgBorder + "─".repeat(Math.max(0, boxW - 2 - title.length - 2)) + "┐" + A.reset);

    out.push(T.goto(startRow + 1, startCol));
    const hint = " Enter API Key (input will be masked):";
    out.push(A.fgBorder + "│" + A.reset + A.fgSubtext + hint + " ".repeat(Math.max(0, boxW - 2 - stripAnsi(hint).length)) + A.fgBorder + "│" + A.reset);

    out.push(T.goto(startRow + 2, startCol));
    const masked = "•".repeat(state.keyManagerInput.buffer.length) + "█";
    const lineContent = " " + A.fgYellow + (state.keyManagerInput.buffer.length > 0 ? masked : "█ (paste key here)") + A.reset;
    out.push(A.fgBorder + "│" + A.reset + lineContent + " ".repeat(Math.max(0, boxW - 2 - stripAnsi(lineContent).length)) + A.fgBorder + "│" + A.reset);

    out.push(T.goto(startRow + 3, startCol));
    out.push(A.fgBorder + "├" + "─".repeat(boxW - 2) + "┤" + A.reset);

    out.push(T.goto(startRow + 4, startCol));
    const navHint = " Enter: Save Key │ Esc: Cancel";
    out.push(A.fgBorder + "│" + A.reset + A.fgMuted + navHint + " ".repeat(Math.max(0, boxW - 2 - stripAnsi(navHint).length)) + A.fgBorder + "│" + A.reset);

    out.push(T.goto(startRow + 5, startCol));
    out.push(A.fgBorder + "└" + "─".repeat(boxW - 2) + "┘" + A.reset);

    return out.join("");
  }

  // Mode 2: Confirm Delete Key Mode
  if (state.keyManagerConfirmDelete) {
    const confirmH = 6;
    const startRow = Math.floor((rows - confirmH) / 2);
    const startCol = Math.floor((cols - boxW) / 2);

    out.push(T.goto(startRow, startCol));
    const title = " Delete API Key ";
    out.push(A.fgRed + "┌─" + A.bold + title + A.reset + A.fgRed + "─".repeat(Math.max(0, boxW - 2 - title.length - 2)) + "┐" + A.reset);

    out.push(T.goto(startRow + 1, startCol));
    const msg = ` Delete stored key for \x1b[1m${state.keyManagerConfirmDelete}\x1b[0m?`;
    out.push(A.fgRed + "│" + A.reset + msg + " ".repeat(Math.max(0, boxW - 2 - stripAnsi(msg).length)) + A.fgRed + "│" + A.reset);

    out.push(T.goto(startRow + 2, startCol));
    const choices = " [Y] Confirm Delete   [N / Esc] Cancel";
    out.push(A.fgRed + "│" + A.reset + A.bold + choices + A.reset + " ".repeat(Math.max(0, boxW - 2 - stripAnsi(choices).length)) + A.fgRed + "│" + A.reset);

    out.push(T.goto(startRow + 3, startCol));
    out.push(A.fgRed + "└" + "─".repeat(boxW - 2) + "┘" + A.reset);

    return out.join("");
  }

  // Mode 3: Normal Key Manager List
  const providers = getKeyManagerProviders();
  const boxH = Math.min(18, Math.max(10, rows - 6));
  const startRow = Math.floor((rows - boxH) / 2);
  const startCol = Math.floor((cols - boxW) / 2);

  // Top border with Title
  out.push(T.goto(startRow, startCol));
  const title = " API Keys ";
  out.push(A.fgBorder + "┌─" + A.bold + A.fgCyan + title + A.reset + A.fgBorder + "─".repeat(Math.max(0, boxW - 2 - title.length - 2)) + "┐" + A.reset);

  // Column Header
  out.push(T.goto(startRow + 1, startCol));
  const colHeader = "  " + A.bold + "Provider".padEnd(18) + "Status" + A.reset;
  const colPad = Math.max(0, boxW - 2 - stripAnsi(colHeader).length);
  out.push(A.fgBorder + "│" + A.reset + colHeader + " ".repeat(colPad) + A.fgBorder + "│" + A.reset);

  // Separator
  out.push(T.goto(startRow + 2, startCol));
  out.push(A.fgBorder + "├" + "─".repeat(boxW - 2) + "┤" + A.reset);

  // Provider Key List
  const listRows = Math.max(1, boxH - 5);
  const listStart = Math.max(0, Math.min(state.keyManagerIdx - Math.floor(listRows / 2), Math.max(0, providers.length - listRows)));
  const visible = providers.slice(listStart, listStart + listRows);

  for (let i = 0; i < listRows; i++) {
    out.push(T.goto(startRow + 3 + i, startCol));
    const provIdx = listStart + i;
    const item = visible[i];

    if (!item) {
      out.push(A.fgBorder + "│" + " ".repeat(boxW - 2) + "│" + A.reset);
    } else {
      const selected = provIdx === state.keyManagerIdx;
      const marker = selected ? A.fgCyan + "● " + A.reset : "  ";
      const nameFg = selected ? A.bold + A.fgCyan : A.fgText;
      const nameStr = truncate(item.name, 16).padEnd(16);

      let statusStr = "";
      if (item.isConfigured) {
        statusStr = A.fgGreen + `Configured ` + A.fgMuted + item.maskedKey + A.reset;
      } else {
        statusStr = A.fgSubtext + A.dim + `Not configured` + A.reset;
      }

      const lineContent = marker + nameFg + nameStr + A.reset + " " + statusStr;
      const bg = selected ? A.bgOverlay : "";
      const textPad = Math.max(0, boxW - 2 - stripAnsi(lineContent).length);
      out.push(A.fgBorder + "│" + A.reset + bg + lineContent + " ".repeat(textPad) + A.reset + A.fgBorder + "│" + A.reset);
    }
  }

  // Footer Navigation hints
  out.push(T.goto(startRow + boxH - 2, startCol));
  const navHint = A.fgMuted + " Enter/A: Set Key │ D: Delete │ ↑↓: Move │ Esc: Close" + A.reset;
  const navPad = Math.max(0, boxW - 2 - stripAnsi(navHint).length);
  out.push(A.fgBorder + "│" + A.reset + navHint + " ".repeat(navPad) + A.fgBorder + "│" + A.reset);

  out.push(T.goto(startRow + boxH - 1, startCol));
  out.push(A.fgBorder + "└" + "─".repeat(boxW - 2) + "┘" + A.reset);

  return out.join("");
}
