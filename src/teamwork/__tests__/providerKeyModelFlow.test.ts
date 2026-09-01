/**
 * Regression Test Suite: /key -> Provider -> Model Flow
 *
 * Validates:
 * 1. Fresh install -> Set Key (ToolNet) -> Auto sets active provider -> /model shows live/fallback models.
 * 2. If another active provider exists, adding a new key does not overwrite active provider.
 * 3. Invalid/empty keys do not activate provider.
 * 4. Switching provider refreshes models cleanly and updates status bar without stale cache.
 * 5. Selecting a provider in /provider without a key opens Set Key modal directly instead of dead selection.
 * 6. CLI restart restores active provider from stored keys.
 * 7. Live ToolNet /v1/models integration and offline fallback models.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import {
  saveCliKey,
  getCliKey,
  deleteCliKey,
  loadCliKeys,
} from "../../lib/keys";
import {
  syncProviderOnKeySave,
  getActiveProviderConfig,
  setActiveProvider,
  loadProvidersConfig,
  saveProvidersConfig,
  resetProvidersConfigCache,
  autoRestoreActiveProvider,
  ToolNetProvider,
  TOOLNET_DEFAULT_MODELS,
} from "../../providers";
import { tuiState } from "../../tui/state";
import { providerPicker } from "../../components/ProviderPicker";
import { handleKey } from "../../tui/input/inputHandler";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-prov-flow-"));
}

function cleanDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

describe("Provider Key Model Flow Regression Suite", () => {
  let tmpConfigDir: string;
  let origEnv: Record<string, string | undefined>;

  beforeEach(() => {
    origEnv = { ...process.env };
    tmpConfigDir = tmpDir();
    process.env.TOOLNETCLI_CONFIG_DIR = tmpConfigDir;
    process.env.DATA_DIR = tmpConfigDir;
    resetProvidersConfigCache();
    saveProvidersConfig({ schemaVersion: 1, providers: [], activeProviderId: null });

    tuiState.providerName = "";
    tuiState.gatewayUrl = null;
    tuiState.currentModel = "";
    tuiState.availableModels = [];
    tuiState.filteredModels = [];
    tuiState.showModelPicker = false;
    tuiState.showKeyManager = false;
    tuiState.keyManagerInput = null;
    providerPicker.show = false;
  });

  afterEach(() => {
    process.env = origEnv;
    cleanDir(tmpConfigDir);
    resetProvidersConfigCache();
  });

  it("1. Fresh install -> Set Key for ToolNet -> auto sets active provider & models loadable", async () => {
    // Fresh install has no active provider
    expect(getActiveProviderConfig()).toBeNull();

    // User sets API key for toolnet
    saveCliKey("toolnet", "tn-live-secret-key-12345");
    const activeProv = syncProviderOnKeySave("toolnet", "tn-live-secret-key-12345");

    expect(activeProv).not.toBeNull();
    expect(activeProv?.id).toBe("toolnet");

    // Active provider config is immediately toolnet
    const currentActive = getActiveProviderConfig();
    expect(currentActive?.id).toBe("toolnet");
    expect(currentActive?.name).toBe("ToolNet Gateway");

    // /model now has models available
    await tuiState.openModelPicker();
    expect(tuiState.availableModels.length).toBeGreaterThan(0);
    expect(tuiState.availableModels).toContain("claude-3-5-sonnet");
    expect(tuiState.showModelPicker).toBe(true);
  });

  it("2. If another valid active provider exists, adding a new key does NOT overwrite active provider", () => {
    // Initially active provider is openai
    saveCliKey("openai", "sk-openai-key-999");
    syncProviderOnKeySave("openai", "sk-openai-key-999");
    expect(getActiveProviderConfig()?.id).toBe("openai");

    // User later sets key for anthropic
    saveCliKey("anthropic", "sk-ant-key-888");
    syncProviderOnKeySave("anthropic", "sk-ant-key-888");

    // Active provider remains openai
    const currentActive = getActiveProviderConfig();
    expect(currentActive?.id).toBe("openai");
    expect(getCliKey("anthropic")).toBe("sk-ant-key-888");
  });

  it("3. Invalid or empty key does not activate provider", () => {
    const res = syncProviderOnKeySave("gemini", "   ");
    expect(res).toBeNull();
    expect(getActiveProviderConfig()).toBeNull();
  });

  it("4. Switching provider in TUI /provider refreshes models cleanly and updates status bar", async () => {
    saveCliKey("toolnet", "tn-key-1");
    saveCliKey("openai", "sk-key-2");
    syncProviderOnKeySave("toolnet", "tn-key-1");

    expect(tuiState.providerName).toBe("ToolNet Gateway");

    // Switch to openai
    setActiveProvider("openai");
    expect(getActiveProviderConfig()?.id).toBe("openai");
    expect(tuiState.providerName).toBe("OpenAI");

    // Models refreshed for new provider
    await tuiState.openModelPicker();
    expect(tuiState.availableModels).not.toContain("No provider configured");
  });

  it("5. Selecting a provider without key opens Set Key modal directly instead of dead selection", () => {
    providerPicker.show = true;
    providerPicker.list = ["toolnet", "mistral"];
    providerPicker.idx = 1; // mistral (has no key)

    let rendered = false;
    handleKey("\r", {
      renderAll: () => { rendered = true; },
      sendMessage: () => {},
    });

    // Modal opens for mistral
    expect(tuiState.showKeyManager).toBe(true);
    expect(tuiState.keyManagerInput?.provider).toBe("mistral");
    expect(tuiState.keyManagerInput?.buffer).toBe("");
    expect(rendered).toBe(true);
  });

  it("6. Selecting a provider with existing key immediately switches active provider", () => {
    saveCliKey("anthropic", "sk-ant-test-key");

    providerPicker.show = true;
    providerPicker.list = ["anthropic"];
    providerPicker.idx = 0;

    handleKey("\r", {
      renderAll: () => {},
      sendMessage: () => {},
    });

    expect(getActiveProviderConfig()?.id).toBe("anthropic");
    expect(tuiState.providerName).toBe("Anthropic");
  });

  it("7. CLI restart restores active provider from stored keys", () => {
    saveCliKey("toolnet", "tn-restart-key-777");
    resetProvidersConfigCache();
    saveProvidersConfig({ schemaVersion: 1, providers: [], activeProviderId: null });

    // Simulate startup auto-restore
    const restored = autoRestoreActiveProvider();
    expect(restored?.id).toBe("toolnet");
    expect(getActiveProviderConfig()?.id).toBe("toolnet");
  });

  it("8. ToolNetProvider lists live models from /v1/models or falls back to default models", async () => {
    // 8A. Mock live /v1/models server
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: [
            { id: "custom-toolnet-model-v1", object: "model" },
            { id: "custom-toolnet-model-v2", object: "model" },
          ],
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;

    const liveProvider = new ToolNetProvider({
      id: "toolnet",
      name: "ToolNet Gateway",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "test-token",
    });

    const liveModels = await liveProvider.listModels();
    expect(liveModels.map((m) => m.id)).toEqual([
      "custom-toolnet-model-v1",
      "custom-toolnet-model-v2",
    ]);

    await new Promise<void>((resolve) => server.close(() => resolve()));

    // 8B. Offline fallback
    const offlineProvider = new ToolNetProvider({
      id: "toolnet",
      name: "ToolNet Gateway",
      baseUrl: "http://127.0.0.1:59999/v1", // unreachable port
      apiKey: "test-token",
    });

    const fallbackModels = await offlineProvider.listModels();
    expect(fallbackModels.length).toBe(TOOLNET_DEFAULT_MODELS.length);
    expect(fallbackModels.map((m) => m.id)).toContain("claude-3-5-sonnet");
  });
});
