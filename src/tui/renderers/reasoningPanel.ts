import { A } from "../../term";
import { wrapVisible, visibleWidth, truncate } from "../layout";

export interface ReasoningPanelState {
  text: string;
  elapsed: string;
  effort: string;
  collapsed: boolean;
  tokens: number;
  /** True while the block is still receiving deltas — renders the live header. */
  streaming?: boolean;
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

  // Live blocks carry a pulsing marker so the user can tell an in-flight
  // stream apart from a finalized summary at a glance.
  const liveMark = state.streaming ? "● " : "";
  const effortLabel = state.effort && state.effort !== "auto" ? ` · ${state.effort}` : "";
  const tokensLabel = state.tokens > 0 ? ` · ${state.tokens.toLocaleString()} tokens` : "";
  const headerCore = `${liveMark}Thinking${effortLabel}${state.elapsed ? ` · ${state.elapsed}` : ""}${tokensLabel}`;

  if (state.collapsed) {
    const line = A.fgViolet + A.bold + "▶ " + A.reset + A.fgSubtext + headerCore + A.reset;
    out.push(line + "\r\n");
    return out;
  }

  const boxW = Math.min(cols - 2, Math.max(40, Math.floor(cols * 0.92)));
  const leftPad = Math.max(0, Math.floor((cols - boxW) / 2));
  const innerWidth = boxW - 2;
  // Header sits after the "▼ " marker inside the border, so its visible
  // budget is innerWidth - 2; without this clamp a long header overflows
  // the box on narrow terminals.
  const headerCoreTrimmed = truncate(headerCore, Math.max(1, innerWidth - 2));
  const header = A.fgViolet + A.bold + "▼ " + A.reset + A.fgViolet + A.bold + headerCoreTrimmed + A.reset;

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