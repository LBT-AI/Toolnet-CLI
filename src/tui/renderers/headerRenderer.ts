import { A } from "../../term";
import { truncate, stripAnsi } from "../layout";

export function renderHeader(
  cols: number,
  state: {
    currentModel: string;
    agentMode: string;
    bypassMode: boolean;
    bypassLevel: string;
    lastTokens: string;
  }
): string {
  const bypassLabel = state.bypassMode ? A.fgRed + `[Bypass:${state.bypassLevel.toUpperCase()}] ` + A.reset : "";
  const modeLabel = A.fgSubtext + "[" + A.fgText + state.agentMode + A.fgSubtext + "] " + bypassLabel + A.reset;
  const modelLabel = A.fgSubtext + "Model: " + A.fgText + truncate(state.currentModel, 30) + A.reset;
  const gwLabel = A.fgSubtext + " │ GW: " + A.fgGreen + "●" + A.reset + " ";
  const tokenLabel = state.lastTokens ? A.fgSubtext + "│ Tokens: " + A.fgYellow + state.lastTokens + A.reset + " " : "";

  const headerRight = modelLabel + gwLabel + tokenLabel + modeLabel;
  const headerRightStripped = stripAnsi(headerRight);
  const padding = Math.max(0, cols - headerRightStripped.length);

  return " ".repeat(padding) + headerRight + A.reset + "\r\n";
}
