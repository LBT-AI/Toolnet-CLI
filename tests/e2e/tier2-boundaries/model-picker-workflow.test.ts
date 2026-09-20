/**
 * Hierarchical /model workflow semantics.
 *
 * Core contract under test:
 *   - /model opens the PROVIDER stage; picking a provider is navigation only
 *     (pendingProviderId), never a runtime mutation;
 *   - provider+model commit happens together and only on model selection;
 *   - Esc closes the whole workflow with zero state mutation; Backspace on an
 *     empty search returns to the provider stage with the cursor preserved;
 *   - arrow keys never leak into the search query; unconfigured providers are
 *     never silently activated.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as appConfig from "../../../src/lib/appConfig";
import * as registry from "../../../src/providers/registry";
import { modelCatalog } from "../../../src/core/models/catalog";
import { tuiState } from "../../../src/tui/state";
import {
  handleModelPickerKey,
  commitModelSelection,
  resolveModelArg,
} from "../../../src/tui/modelPickerWorkflow";

const ORIG_ENV = process.env.TOOLNETCLI_CONFIG_DIR;
let home = "";

const noop = () => {};
const cb = { renderAll: noop };

function key(s: string): { hex: string; s: string } {
  return { hex: Buffer.from(s, "latin1").toString("hex"), s };
}
const UP = key("\u001b[A");
const DOWN = key("\u001b[B");
const LEFT = key("\u001b[D");
const ENTER = key("\r");
const ESC = key("\u001b");
const BACKSPACE = key("\u007f");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "toolnet-picker-"));
  mkdirSync(join(home, "cache"), { recursive: true });
  process.env.TOOLNETCLI_CONFIG_DIR = home;
  appConfig.resetAppConfigCache();
  registry.resetProvidersConfigCache();

  // Reset picker state between tests.
  tuiState.showModelPicker = false;
  tuiState.modelPickerStage = "provider";
  tuiState.pendingProviderId = null;
  tuiState.modelSearchQuery = "";
  tuiState.modelSearchCursor = 0;
  tuiState.providerPickerIdx = 0;
  tuiState.modelPickerIdx = 0;
  tuiState.availableModels = [];
  tuiState.filteredModels = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (ORIG_ENV === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR;
  else process.env.TOOLNETCLI_CONFIG_DIR = ORIG_ENV;
  registry.resetProvidersConfigCache();
});

/** Configure exactly one provider so the workflow has a valid target. */
function configureToolnet(): void {
  registry.saveProvidersConfig({
    schemaVersion: 1,
    providers: [registry.getDefaultProviderConfig("toolnet")],
    activeProviderId: null,
  });
  registry.resetProvidersConfigCache();
}

describe("Hierarchical /model workflow", () => {
  it("1. /model opens the provider stage first", async () => {
    await tuiState.openModelPicker();
    expect(tuiState.showModelPicker).toBe(true);
    expect(tuiState.modelPickerStage).toBe("provider");
    expect(tuiState.providerEntries.length).toBeGreaterThan(0);
  });

  it("2-3. selecting a provider filters models to that provider only", async () => {
    configureToolnet();
    modelCatalog.replaceProviderModels("toolnet", [
      { id: "toolnet/a", providerId: "toolnet", apiModelId: "a", capabilities: {}, status: "active" },
      { id: "toolnet/b", providerId: "toolnet", apiModelId: "b", capabilities: {}, status: "active" },
    ]);
    modelCatalog.replaceProviderModels("gemini", [
      { id: "gemini/g", providerId: "gemini", apiModelId: "g", capabilities: {}, status: "active" },
    ]);

    await tuiState.openModelPicker();
    // Navigate to the configured toolnet row and open it.
    const row = tuiState.providerEntries.findIndex((p) => p.id === "toolnet");
    while (tuiState.providerEntries[tuiState.providerPickerIdx].id !== "toolnet") {
      handleModelPickerKey(DOWN.hex, DOWN.s, cb);
    }
    expect(row).toBe(tuiState.providerPickerIdx);
    handleModelPickerKey(ENTER.hex, ENTER.s, cb);

    expect(tuiState.modelPickerStage).toBe("model");
    expect(tuiState.pendingProviderId).toBe("toolnet");
    expect(tuiState.availableModels).toEqual(["a", "b"]);
    expect(tuiState.availableModels).not.toContain("g");
  });

  it("4. provider + model commit atomically", async () => {
    configureToolnet();
    modelCatalog.replaceProviderModels("toolnet", [
      { id: "toolnet/x", providerId: "toolnet", apiModelId: "x", capabilities: {}, status: "active" },
    ]);
    await tuiState.openModelPicker();
    handleModelPickerKey(ENTER.hex, ENTER.s, cb); // first configured provider (toolnet only)
    handleModelPickerKey(ENTER.hex, ENTER.s, cb); // select model x

    const active = registry.getActiveProviderConfig();
    expect(active?.id).toBe("toolnet");
    expect(tuiState.currentModel).toBe("x");
    expect(tuiState.showModelPicker).toBe(false);
    expect(tuiState.pendingProviderId).toBeNull();
  });

  it("5. Esc from model list leaves active provider/model unchanged", async () => {
    configureToolnet();
    registry.setActiveProvider("toolnet");
    modelCatalog.replaceProviderModels("toolnet", [
      { id: "toolnet/x", providerId: "toolnet", apiModelId: "x", capabilities: {}, status: "active" },
    ]);
    await tuiState.openModelPicker();
    handleModelPickerKey(ENTER.hex, ENTER.s, cb); // enter toolnet model stage
    expect(tuiState.pendingProviderId).toBe("toolnet");

    handleModelPickerKey(ESC.hex, ESC.s, cb);
    expect(tuiState.showModelPicker).toBe(false);
    expect(tuiState.pendingProviderId).toBeNull();
    // No half-switch: still the previously active provider.
    expect(registry.getActiveProviderConfig()?.id).toBe("toolnet");
  });

  it("6. Backspace on empty search returns to provider stage with cursor preserved", async () => {
    configureToolnet();
    modelCatalog.replaceProviderModels("toolnet", [
      { id: "toolnet/x", providerId: "toolnet", apiModelId: "x", capabilities: {}, status: "active" },
    ]);
    await tuiState.openModelPicker();
    // Park the provider cursor on the CONFIGURED toolnet row, then enter.
    const parked = tuiState.providerEntries.findIndex((p) => p.id === "toolnet");
    while (tuiState.providerPickerIdx !== parked) handleModelPickerKey(DOWN.hex, DOWN.s, cb);
    handleModelPickerKey(ENTER.hex, ENTER.s, cb);
    expect(tuiState.modelPickerStage).toBe("model");

    handleModelPickerKey(BACKSPACE.hex, BACKSPACE.s, cb);
    expect(tuiState.modelPickerStage).toBe("provider");
    expect(tuiState.providerPickerIdx).toBe(parked);
    expect(tuiState.pendingProviderId).toBeNull();
  });

  it("7. Backspace on non-empty search edits the query instead of navigating", async () => {
    configureToolnet();
    modelCatalog.replaceProviderModels("toolnet", [
      { id: "toolnet/xy", providerId: "toolnet", apiModelId: "xy", capabilities: {}, status: "active" },
      { id: "toolnet/xz", providerId: "toolnet", apiModelId: "xz", capabilities: {}, status: "active" },
    ]);
    await tuiState.openModelPicker();
    handleModelPickerKey(ENTER.hex, ENTER.s, cb);
    // NOTE: a/d/e are single-key actions while the filter is empty, so the
    // filter query here starts with a non-action character.
    handleModelPickerKey(key("x").hex, "x", cb);
    handleModelPickerKey(key("y").hex, "y", cb);
    expect(tuiState.modelSearchQuery).toBe("xy");
    expect(tuiState.filteredModels).toEqual(["xy"]);

    handleModelPickerKey(BACKSPACE.hex, BACKSPACE.s, cb);
    expect(tuiState.modelSearchQuery).toBe("x");
    expect(tuiState.modelPickerStage).toBe("model");
  });

  it("8. Left moves the search cursor; Left at start goes back", async () => {
    configureToolnet();
    modelCatalog.replaceProviderModels("toolnet", [
      { id: "toolnet/xy", providerId: "toolnet", apiModelId: "xy", capabilities: {}, status: "active" },
    ]);
    await tuiState.openModelPicker();
    handleModelPickerKey(ENTER.hex, ENTER.s, cb);

    handleModelPickerKey(key("x").hex, "x", cb);
    handleModelPickerKey(key("y").hex, "y", cb);
    expect(tuiState.modelSearchCursor).toBe(2);
    handleModelPickerKey(LEFT.hex, LEFT.s, cb);
    expect(tuiState.modelSearchCursor).toBe(1);
    // Insert between x|y
    handleModelPickerKey(key("z").hex, "z", cb);
    expect(tuiState.modelSearchQuery).toBe("xzy");

    // Cursor at start → back navigation. ("xzy" → "xz" → "x" → "")
    handleModelPickerKey(BACKSPACE.hex, BACKSPACE.s, cb);
    handleModelPickerKey(BACKSPACE.hex, BACKSPACE.s, cb);
    handleModelPickerKey(BACKSPACE.hex, BACKSPACE.s, cb);
    expect(tuiState.modelSearchQuery).toBe("");
    handleModelPickerKey(LEFT.hex, LEFT.s, cb);
    expect(tuiState.modelPickerStage).toBe("provider");
  });

  it("arrows never leak into the search query", async () => {
    configureToolnet();
    modelCatalog.replaceProviderModels("toolnet", [
      { id: "toolnet/x", providerId: "toolnet", apiModelId: "x", capabilities: {}, status: "active" },
    ]);
    await tuiState.openModelPicker();
    handleModelPickerKey(ENTER.hex, ENTER.s, cb);
    handleModelPickerKey(DOWN.hex, DOWN.s, cb);
    handleModelPickerKey(UP.hex, UP.s, cb);
    expect(tuiState.modelSearchQuery).toBe("");
    expect(tuiState.modelPickerIdx).toBe(0);
  });

  it("unconfigured provider is never silently activated", async () => {
    await tuiState.openModelPicker();
    const geminiRow = tuiState.providerEntries.findIndex((p) => p.id === "gemini");
    expect(tuiState.providerEntries[geminiRow].configured).toBe(false);
    while (tuiState.providerPickerIdx !== geminiRow) handleModelPickerKey(DOWN.hex, DOWN.s, cb);
    handleModelPickerKey(ENTER.hex, ENTER.s, cb);
    // Workflow stays open, no pending id, nothing activated.
    expect(tuiState.modelPickerStage).toBe("provider");
    expect(tuiState.pendingProviderId).toBeNull();
    expect(registry.getActiveProviderConfig()).toBeNull();
  });

  it("resolveModelArg splits nested OpenRouter refs on the provider boundary only", () => {
    configureToolnet();
    const resolved = resolveModelArg("openrouter/anthropic/claude-sonnet-4", ["toolnet", "openrouter"]);
    expect(resolved).toEqual({
      providerId: "openrouter",
      apiModelId: "anthropic/claude-sonnet-4",
    });
    // Bare id falls back to the active provider (none configured here → null).
    expect(resolveModelArg("bare-model", ["toolnet"])).toBeNull();
  });

  it("commitModelSelection failure leaves runtime untouched and reports visibly", async () => {
    tuiState.showModelPicker = true;
    await commitModelSelection("ghost", "m");
    // Still nothing activated: the toast carries the failure instead.
    expect(registry.getActiveProviderConfig()).toBeNull();
    expect(tuiState.currentModel).not.toBe("m");
    tuiState.showModelPicker = false;
  });
});
