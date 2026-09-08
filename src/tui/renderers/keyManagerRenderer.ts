import { A } from "../../term";
import { stripAnsi, truncate } from "../layout";
import { getCliKey, maskApiKey, StoredKeyInfo } from "../../lib/keys";
import { listProviders } from "../../providers/registry";
import { composeBox, computeBoxGeometry, maskLine } from "./composeBox";

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
    keyManagerInput: { provider: string; buffer: string; cursor?: number } | null;
    keyManagerConfirmDelete?: string | null;
  }
): string {
  // Mode 1: Inputting Key Mode
  if (state.keyManagerInput) {
    const hasValue = state.keyManagerInput.buffer.length > 0;
    const masked = maskLine(state.keyManagerInput.buffer, state.keyManagerInput.cursor ?? state.keyManagerInput.buffer.length, Math.max(10, Math.min(56, cols - 14)));
    const body = [
      A.fgSubtext + state.keyManagerInput.provider + A.reset,
      "",
      (hasValue ? A.fgText + "> " + masked + A.reset : A.fgMuted + "> " + "•".repeat(6) + A.reset),
      "",
    ];
    return composeBox(cols, rows, {
      title: "Set API key",
      body,
      footer: hasValue ? "Enter save · esc cancel" : "Paste key · enter save · esc cancel",
    }).join("");
  }

  // Mode 2: Confirm Delete Key Mode (destructive — red accent is appropriate)
  if (state.keyManagerConfirmDelete) {
    const body = [
      A.fgSubtext + "Delete the stored key for " + A.reset + A.bold + A.fgText + state.keyManagerConfirmDelete + A.reset + A.fgSubtext + "?" + A.reset,
      "",
      A.fgRed + A.bold + "   y  confirm delete" + A.reset + A.fgSubtext + "   n / esc  cancel" + A.reset,
    ];
    return composeBox(cols, rows, {
      title: "Delete API key",
      body,
      accent: A.fgRed,
      borderColor: A.fgBorder,
    }).join("");
  }

  // Mode 3: Normal Key Manager List
  const providers = getKeyManagerProviders();
  const isNarrow = cols < 60;
  const { boxW } = computeBoxGeometry(cols, rows, Math.min(providers.length, 10) + 3, true, isNarrow ? 46 : 56);

  const body: string[] = [];
  body.push(A.fgSubtext + "Provider" + " ".repeat(Math.max(0, 16 - 8)) + "Status" + A.reset);
  body.push("");

  const listStart = Math.max(0, Math.min(state.keyManagerIdx - 5, Math.max(0, providers.length - 10)));
  const visible = providers.slice(listStart, listStart + 10);

  for (let i = 0; i < visible.length; i++) {
    const provIdx = listStart + i;
    const item = visible[i];
    if (!item) continue;
    const selected = provIdx === state.keyManagerIdx;
    const nameStr = truncate(item.name, 16).padEnd(16);
    const statusStr = item.isConfigured
      ? A.fgGreen + "configured" + (isNarrow ? "" : " · " + A.fgMuted + item.maskedKey) + A.reset
      : A.fgMuted + "not configured" + A.reset;
    if (selected) {
      body.push(A.bgOverlay + "  " + A.fgCyan + A.bold + "● " + A.reset + A.bgOverlay + A.bold + A.fgText + nameStr + A.reset + "  " + statusStr);
    } else {
      body.push("   " + A.fgText + nameStr + A.reset + "  " + statusStr);
    }
  }

  if (providers.length > 10) body.push(A.fgMuted + "… and " + (providers.length - 10) + " more" + A.reset);

  return composeBox(cols, rows, {
    title: "API keys",
    body,
    footer: "enter/a set · d delete · ↑↓ move · esc close",
  }).join("");
}
