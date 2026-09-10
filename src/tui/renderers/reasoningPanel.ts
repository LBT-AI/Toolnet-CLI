import { A } from "../../term";
import { wrapVisible, visibleWidth, truncate } from "../layout";

export interface ReasoningPanelState {
  text: string;
  elapsed: string;
  effort: string;
  collapsed: boolean;
  tokens: number;
}

/**
 * Collapsible Thinking panel. Only rendered when the upstream API actually
 * provided reasoning content — the label says "Reasoning summary" when the
 * content is a short summary and full "Thinking" otherwise. Never fabricates
 * content for models that do not reason.
 */
export function renderReasoningPanel(cols: number, state: ReasoningPanelState): string[] {
  const out: string[] = [];
  if (!state.text && !state.collapsed) return out;

  const effortLabel = state.effort && state.effort !== "auto" ? ` · ${state.effort}` : "";
  const tokensLabel = state.tokens > 0 ? ` · ${state.tokens.toLocaleString()} tokens` : "";
  const headerCore = `Thinking${effortLabel}${state.elapsed ? ` · ${state.elapsed}` : ""}${tokensLabel}`;

  if (state.collapsed) {
    const line = A.fgCyan + A.bold + "▶ " + A.reset + A.fgSubtext + headerCore + A.reset;
    out.push(line + "\r\n");
    return out;
  }

  const boxW = Math.min(cols - 2, Math.max(40, Math.floor(cols * 0.92)));
  const leftPad = Math.max(0, Math.floor((cols - boxW) / 2));
  const innerWidth = boxW - 2;
  const header = A.fgCyan + A.bold + "▼ " + A.reset + A.fgCyan + A.bold + headerCore + A.reset;

  out.push(" ".repeat(leftPad) + A.fgBorder + "╭" + "─".repeat(innerWidth) + "╮" + A.reset + "\r\n");
  out.push(
    " ".repeat(leftPad) + A.fgBorder + "│" + A.reset + header +
    " ".repeat(Math.max(0, innerWidth - visibleWidth(header))) + A.fgBorder + "│" + A.reset + "\r\n"
  );

  const maxLines = 6;
  const descMax = Math.max(10, innerWidth - 4);
  const wrapped = wrapVisible(state.text.trim(), descMax);
  const shown = wrapped.slice(0, maxLines);
  for (const line of shown) {
    out.push(
      " ".repeat(leftPad) + A.fgBorder + "│" + A.reset +
      A.fgSubtext + "  " + truncate(line, descMax) + A.reset +
      " ".repeat(Math.max(0, innerWidth - 2 - visibleWidth(line))) + A.fgBorder + "│" + A.reset + "\r\n"
    );
  }
  if (wrapped.length > maxLines) {
    out.push(
      " ".repeat(leftPad) + A.fgBorder + "│" + A.reset +
      A.fgMuted + "  … " + (wrapped.length - maxLines) + " more" + A.reset +
      " ".repeat(Math.max(0, innerWidth - 8)) + A.fgBorder + "│" + A.reset + "\r\n"
    );
  }
  out.push(" ".repeat(leftPad) + A.fgBorder + "╰" + "─".repeat(innerWidth) + "╯" + A.reset + "\r\n");
  return out;
}