import { A } from "../../term";
import { stripAnsi, truncate } from "../layout";
import { getModelTags } from "../../lib/modelTags";
import { getModelCapabilities } from "../../lib/reasoning";
import { composeBox, computeBoxGeometry } from "./composeBox";
import { isCustomModel } from "../../core/models/customModels";

const MAX_DISPLAY = 10;

/**
 * Stage 1 of the hierarchical /model workflow: compact provider list.
 * Configured providers are selectable; built-in but unconfigured ones are
 * shown with a marker and Enter refuses them (never silently activated).
 */
export function renderProviderStageBox(
  cols: number,
  rows: number,
  state: {
    entries: Array<{ id: string; name: string; configured: boolean }>;
    idx: number;
    activeProviderId?: string;
  },
): string {
  const total = state.entries.length;
  const winSize = Math.min(MAX_DISPLAY, Math.max(1, total));
  const idx = Math.max(0, Math.min(state.idx, total - 1));
  const listStart = Math.max(0, Math.min(idx - Math.floor(winSize / 2), Math.max(0, total - winSize)));
  const visible = state.entries.slice(listStart, listStart + winSize);

  const isNarrow = cols < 60;
  const { boxW } = computeBoxGeometry(cols, rows, winSize + 2, true, isNarrow ? 40 : 48);

  const body: string[] = [];
  const activeLower = state.activeProviderId?.toLowerCase();
  for (let i = 0; i < visible.length; i++) {
    const entryIdx = listStart + i;
    const entry = visible[i];
    const selected = entryIdx === idx;
    const isActive = activeLower && entry.id.toLowerCase() === activeLower;
    const name = truncate(entry.name, Math.max(6, boxW - 14));
    if (selected) {
      const line =
        A.bgOverlay + "  " + A.fgViolet + A.bold + "● " + A.reset +
        A.bgOverlay + A.fgText + A.bold + name + A.reset +
        (entry.configured ? "" : A.fgMuted + "  Not configured" + A.reset);
      body.push(line);
    } else {
      const marker = isActive ? A.fgGreen + "✓ " + A.reset : "  ";
      body.push(marker + A.fgText + name + A.reset + (entry.configured ? "" : A.fgMuted + "  Not configured" + A.reset));
    }
  }
  if (total > winSize) {
    body.push(A.fgMuted + "… and " + (total - winSize) + " more" + A.reset);
  }

  return composeBox(cols, rows, {
    title: "Select provider",
    body,
    footer: "↑↓ navigate · enter open · esc close",
  }).join("");
}

export type ModelPickerRow =
  | { type: "model"; apiModelId: string }
  | { type: "info"; text: string }
  | { type: "action"; action: "add-model"; label: string };

export type SelectableModelPickerRow =
  | { type: "model"; apiModelId: string }
  | { type: "action"; action: "add-model"; label: string };

export function buildModelPickerRows(state: {
  filteredModels: string[];
  availableModels?: string[];
  modelSearchQuery?: string;
}): ModelPickerRow[] {
  const rows: ModelPickerRow[] = [];
  const available = state.availableModels && state.availableModels.length > 0
    ? state.availableModels
    : state.filteredModels;
  const isSearching = Boolean(state.modelSearchQuery && state.modelSearchQuery.trim().length > 0);

  if (state.filteredModels.length > 0) {
    for (const apiModelId of state.filteredModels) {
      rows.push({ type: "model", apiModelId });
    }
  } else if (available.length === 0 && !isSearching) {
    rows.push({ type: "info", text: "No models available" });
  } else {
    rows.push({ type: "info", text: isSearching ? "No matching models" : "No models available" });
  }

  rows.push({ type: "action", action: "add-model", label: "+ Add model" });
  return rows;
}

export function getSelectableRows(rows: ModelPickerRow[]): SelectableModelPickerRow[] {
  return rows.filter((r): r is SelectableModelPickerRow => r.type === "model" || r.type === "action");
}

export function renderModelPickerBox(
  cols: number,
  rows: number,
  state: {
    filteredModels: string[];
    modelPickerIdx: number;
    currentModel: string;
    modelSearchQuery: string;
    pendingProviderId?: string | null;
    availableModels?: string[];
  }
): string {
  const pickerRows = buildModelPickerRows(state);
  const selectableRows = getSelectableRows(pickerRows);
  const totalSelectable = Math.max(1, selectableRows.length);
  const selectedIdx = Math.max(0, Math.min(state.modelPickerIdx, totalSelectable - 1));
  const selectedItem = selectableRows[selectedIdx];

  const modelRows = pickerRows.filter((r): r is { type: "model"; apiModelId: string } => r.type === "model");
  const infoRow = pickerRows.find((r): r is { type: "info"; text: string } => r.type === "info");

  const isNarrow = cols < 60;
  const { boxW } = computeBoxGeometry(cols, rows, 10, true, isNarrow ? 46 : 60);

  const maxViewport = Math.max(3, rows - 5);
  const maxBodyRows = Math.max(1, maxViewport - 3);

  const body: string[] = [];

  // Compact search line
  const query = state.modelSearchQuery
    ? state.modelSearchQuery + "█"
    : A.fgMuted + "Type to filter…" + A.reset;
  body.push(A.fgSubtext + "Search  " + A.reset + (state.modelSearchQuery ? A.fgText + query + A.reset : query));

  body.push("");

  if (modelRows.length === 0) {
    if (infoRow) {
      body.push("  " + A.fgMuted + infoRow.text + A.reset);
    }
  } else {
    const totalModels = modelRows.length;
    const isAddSelected = selectedItem?.type === "action";
    const selectedModelIdx = selectedItem?.type === "model"
      ? modelRows.findIndex((m) => m.apiModelId === selectedItem.apiModelId)
      : -1;

    const maxModelDisplay = Math.max(3, Math.min(8, maxBodyRows - 6));
    const winSize = Math.min(maxModelDisplay, totalModels);

    let listStart = 0;
    if (isAddSelected) {
      listStart = Math.max(0, totalModels - winSize);
    } else if (selectedModelIdx >= 0) {
      listStart = Math.max(0, Math.min(selectedModelIdx - Math.floor(winSize / 2), Math.max(0, totalModels - winSize)));
    }
    const visible = modelRows.slice(listStart, listStart + winSize);

    for (let i = 0; i < visible.length; i++) {
      const model = visible[i].apiModelId;
      const isSelected = selectedItem?.type === "model" && selectedItem.apiModelId === model;
      const isCurrent = model === state.currentModel;
      const isCustom = state.pendingProviderId
        ? isCustomModel(state.pendingProviderId, model)
        : false;
      const customBadge = isCustom ? A.fgYellow + " ★" + A.reset : "";
      const tags = getModelTags(model);
      const caps = getModelCapabilities(model);
      const capBadge = caps?.reasoning
        ? isNarrow
          ? A.fgCyan + A.bold + " R" + A.reset
          : A.fgCyan + A.bold + "  THINKING" + A.reset
        : "";
      const maxText = Math.max(8, boxW - 14 - stripAnsi(tags + capBadge).length);
      let text = truncate(model, maxText);
      if (isNarrow && caps?.reasoning) {
        const nameCap = Math.max(6, boxW - 18 - stripAnsi(tags).length);
        text = truncate(model, nameCap);
        text += capBadge;
      }
      if (isSelected) {
        const line = A.bgOverlay + "  " + A.fgCyan + A.bold + "● " + A.reset +
          A.bgOverlay + A.fgText + A.bold + text + A.reset + customBadge +
          A.bgOverlay + " " + A.fgMuted + tags + capBadge + A.reset;
        body.push(line);
      } else {
        const marker = isCurrent ? A.fgGreen + "✓ " + A.reset : "  ";
        body.push(marker + A.fgText + text + A.reset + customBadge + " " + A.fgMuted + tags + capBadge + A.reset);
      }
    }

    if (totalModels > winSize) {
      body.push(A.fgMuted + "… and " + (totalModels - winSize) + " more" + A.reset);
    }
  }

  body.push("");

  const isAddSelected = selectedItem?.type === "action";
  if (isAddSelected) {
    body.push(
      A.bgOverlay + "  " + A.fgCyan + A.bold + "● " + A.reset +
      A.bgOverlay + A.fgText + A.bold + "+ Add model" + A.reset
    );
  } else {
    body.push("  " + A.fgText + "+ Add model" + A.reset);
  }

  const footer = isNarrow
    ? "↑↓ · enter · a add · esc"
    : "↑↓ navigate · enter select · a add · ⌫ back · esc close";

  return composeBox(cols, rows, {
    title: "Select model",
    body,
    footer,
  }).join("");
}