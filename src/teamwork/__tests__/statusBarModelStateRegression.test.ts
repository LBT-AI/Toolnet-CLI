import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { tuiState } from "../../tui/state";
import { renderFooter } from "../../tui/renderers/statusRenderer";
import { renderSidebar } from "../../tui/renderers/sidebarRenderer";
import {
  saveProvidersConfig,
  resetProvidersConfigCache,
  setActiveProvider,
  addProvider,
  getActiveProviderConfig,
  OpenAICompatibleProvider,
} from "../../providers";
import { saveCliKey, deleteCliKey } from "../../lib/keys";
import { initCrashRecovery, checkPendingRecovery } from "../../lib/crashRecovery";
import { stripAnsi } from "../../tui/layout";

function tmpDir(): string {
  const d = path.join(os.tmpdir(), "toolnet-statusbar-test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

describe("Status Bar & Model State Lifecycle Regression Suite", () => {
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
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    } catch {}
    process.env = origEnv;
    resetProvidersConfigCache();
  });

  it("1. Fresh install: Provider is Not configured and Model is Not selected", () => {
    const footer = renderFooter(100, {
      providerName: tuiState.providerName,
      currentModel: tuiState.currentModel,
      workspacePath: "/root/project",
    });
    const stripped = stripAnsi(footer);

    expect(stripped).toContain("Provider: Not configured");
    expect(stripped).toContain("Model: Not selected");
    expect(stripped).not.toContain("openai/gpt-4o");
    expect(stripped).not.toContain("gpt-4o");
  });

  it("2. No key or unconfigured provider never falls back to hardcoded gpt-4o", async () => {
    await tuiState.refreshActiveModels();
    expect(tuiState.currentModel).toBe("");

    const footer = renderFooter(100);
    const stripped = stripAnsi(footer);
    expect(stripped).toContain("Provider: Not configured");
    expect(stripped).toContain("Model: Not selected");
    expect(stripped).not.toContain("gpt-4o");

    const sidebar = renderSidebar(tuiState.currentModel, Date.now(), 40);
    const sidebarText = stripAnsi(sidebar.join("\n"));
    expect(sidebarText).toContain("Model: Not selected");
    expect(sidebarText).not.toContain("gpt-4o");
  });

  it("3. Provider configured with key but offline/empty models displays Model: Not selected", async () => {
    saveCliKey("custom-offline", "test-key-123");
    addProvider({
      id: "custom-offline",
      name: "Custom Offline Provider",
      baseUrl: "http://127.0.0.1:59998/v1",
      apiKey: "test-key-123",
      defaultModel: "non-existent-model",
    });
    setActiveProvider("custom-offline");

    tuiState.providerName = "Custom Offline Provider";
    tuiState.currentModel = "";

    await tuiState.refreshActiveModels();

    expect(tuiState.currentModel).toBe("");
    expect(tuiState.availableModels.some(m => m.includes("No models") || m.includes("offline"))).toBe(true);

    const footer = renderFooter(100, {
      providerName: tuiState.providerName,
      currentModel: tuiState.currentModel,
      workspacePath: "/root/project",
    });
    const stripped = stripAnsi(footer);

    expect(stripped).toContain("Provider: Custom Offline");
    expect(stripped).toContain("Model: Not selected");
    expect(stripped).not.toContain("non-existent-model");
    expect(stripped).not.toContain("gpt-4o");
  });

  it("4. Selecting valid model displays exact model in status and footer", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: [
            { id: "custom-model-alpha", object: "model" },
            { id: "custom-model-beta", object: "model" },
          ],
        }));
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;

    saveCliKey("live-prov", "live-key-456");
    addProvider({
      id: "live-prov",
      name: "Live Provider",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "live-key-456",
      defaultModel: "custom-model-beta",
    });
    setActiveProvider("live-prov");

    tuiState.providerName = "Live Provider";
    await tuiState.refreshActiveModels();

    // Default model was custom-model-beta and it exists in real models list -> selected!
    expect(tuiState.currentModel).toBe("custom-model-beta");

    const footer = renderFooter(100, {
      providerName: tuiState.providerName,
      currentModel: tuiState.currentModel,
      workspacePath: "/root/project",
    });
    const stripped = stripAnsi(footer);
    expect(stripped).toContain("Provider: Live Provider");
    expect(stripped).toContain("Model: custom-model-beta");

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("5. Stale saved model not in provider registry is automatically cleared without fallback to gpt-4o", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: [
            { id: "gemini-2.0-flash", object: "model" },
          ],
        }));
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port;

    saveCliKey("gemini-test", "gemini-key-789");
    addProvider({
      id: "gemini-test",
      name: "Google Gemini",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "gemini-key-789",
      defaultModel: "gemini-2.0-flash",
    });
    setActiveProvider("gemini-test");

    // Simulate stale saved model from past session
    tuiState.providerName = "Google Gemini";
    tuiState.currentModel = "openai/gpt-4o"; // stale model from old session

    await tuiState.refreshActiveModels();

    // Stale model cleared, valid model selected
    expect(tuiState.currentModel).toBe("gemini-2.0-flash");
    expect(tuiState.currentModel).not.toBe("openai/gpt-4o");

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("6. Crash recovery without valid provider leaves model unselected", () => {
    initCrashRecovery("test-sess-999", "/root", "");

    const rec = checkPendingRecovery();
    expect(rec).not.toBeNull();
    expect(rec?.model).toBe("");
  });
});
