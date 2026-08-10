import { A } from "../../term";
import { store } from "../store";
import { truncate } from "../utils/string";

export function renderHeader(cols: number): string {
  // Dynamic Theme Color
  let primaryColor = A.fgCyan;
  if (store.bypassMode) {
    primaryColor = A.fgRed;
  } else if (store.agentMode === "Plan") {
    primaryColor = A.fgYellow;
  }

  const bypassLabel = store.bypassMode ? A.fgRed + "[Jailbreak] " + A.reset : "";
  const modeLabel = A.fgSubtext + "[" + A.fgText + store.agentMode + A.fgSubtext + "] " + bypassLabel + A.reset;
  const modelLabel = A.fgSubtext + "Model: " + A.fgText + truncate(store.currentModel, 30) + A.reset;
  const gwLabel = A.fgSubtext + " │ GW: " + A.fgGreen + "●" + A.reset + " ";
  const tokenLabel = store.lastTokens ? A.fgSubtext + "│ Tokens: " + A.fgYellow + store.lastTokens + A.reset + " " : "";
  const headerRight = modelLabel + gwLabel + tokenLabel + modeLabel;
  
  const headerRightStripped = headerRight.replace(/\x1b\[[^m]*m/g, "");
  const padding = Math.max(0, cols - headerRightStripped.length);

  return " ".repeat(padding) + headerRight + A.reset + "\r\n";
}
