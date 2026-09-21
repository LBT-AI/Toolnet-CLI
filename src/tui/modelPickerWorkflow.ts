/**
 * Hierarchical /model workflow: provider list → provider's model list →
 * atomic commit of BOTH provider and model.
 *
 * Invariants:
 *   - Picking a provider is NAVIGATION ONLY (`pendingProviderId`); the active
 *     provider/model pair changes exclusively in `commitModelSelection`, when
 *     a model is chosen. Esc/back discards the pending id — the runtime is
 *     never left half-switched.
 *   - Back and Esc are distinct: Backspace/Left return to the provider stage
 *     (cursor preserved, model query cleared); Esc closes the whole workflow
 *     with no state mutation.
 *   - Model ids may contain slashes (OpenRouter): selection works on the
 *     canonical `providerId/apiModelId` pair, never a naive split.
 *   - This module is the ONLY place that mutates provider/model state from
 *     the picker; it delegates runtime activation to the canonical
 *     provider registry, never to TUI-local logic.
 */

import { tuiState } from "./state";
import { parseModelRef } from "../core/models/ref";
import {
  setActiveProvider,
  getActiveProviderConfig,
  listProviders,
} from "../providers/registry";
import {
  listCustomModelsForProvider,
  isCustomModel,
  removeCustomModel,
} from "../core/models/customModels";
import { modelCatalog } from "../core/models/catalog";
import {
  buildModelPickerRows,
  getSelectableRows,
} from "./renderers/modelPickerRenderer";

interface PickerCallbacks {
  renderAll: () => void;
}

const PLACEHOLDER_MARKERS = [
  "No models",
  "Provider offline",
  "Gateway offline",
  "Error",
  "No matches",
  "No provider",
  "Loading...",
];

/** Route one already-decoded key event into the active picker stage. */
export function handleModelPickerKey(
  hex: string,
  s: string,
  callbacks: PickerCallbacks,
): void {
  if (tuiState.modelPickerStage === "provider") {
    handleProviderStageKey(hex, callbacks);
    return;
  }
  handleModelStageKey(hex, s, callbacks);
}

// ── Provider stage (navigation only) ────────────────────────────────────────

function handleProviderStageKey(hex: string, callbacks: PickerCallbacks): void {
  const entries = tuiState.providerEntries;
  if (hex === "1b5b41" || hex === "1b4f41") {
    const len = Math.max(1, entries.length);
    tuiState.providerPickerIdx = (tuiState.providerPickerIdx - 1 + len) % len;
    callbacks.renderAll();
    return;
  }
  if (hex === "1b5b42" || hex === "1b4f42") {
    const len = Math.max(1, entries.length);
    tuiState.providerPickerIdx = (tuiState.providerPickerIdx + 1) % len;
    callbacks.renderAll();
    return;
  }
  if (hex === "0d" || hex === "0a") {
    const entry = entries[tuiState.providerPickerIdx];
    if (!entry) return;
    if (!entry.configured) {
      // Never silently activate an unconfigured provider: surface the setup
      // path instead. The workflow stays open and state remains untouched.
      tuiState.setStatus(`Provider '${entry.id}' is not configured — use /provider or /key to set it up`);
      callbacks.renderAll();
      return;
    }
    enterModelStage(entry.id, callbacks);
    return;
  }
  if (hex === "1b") {
    closeWorkflow(callbacks);
    return;
  }
}

/** Navigation into a provider's model list — no runtime mutation here. */
function enterModelStage(providerId: string, callbacks: PickerCallbacks): void {
  tuiState.pendingProviderId = providerId;
  tuiState.modelPickerStage = "model";
  tuiState.modelSearchQuery = "";
  tuiState.modelSearchCursor = 0;

  const key = providerId.toLowerCase();
  const catalogModels = modelCatalog
    .listByProvider(key)
    .map((m) => m.apiModelId);
  const customModels = listCustomModelsForProvider(providerId)
    .map((m) => m.apiModelId);
  const models = Array.from(new Set([...catalogModels, ...customModels]))
    .sort((a, b) => a.localeCompare(b));
  // Custom models are appended by the catalog merge already; keep the
  // availableModels surface as apiModelIds scoped to this provider.
  tuiState.availableModels = models;
  tuiState.filteredModels = [...models];
  tuiState.modelPickerIdx = 0;
  tuiState.setStatus("");
  callbacks.renderAll();
}

// ── Model stage (search + back + atomic commit) ─────────────────────────────

function handleModelStageKey(hex: string, s: string, callbacks: PickerCallbacks): void {
  // Back navigation: search field owns Backspace/Left only while it has text
  // or cursor movement; an empty field returns to the provider stage.
  if (hex === "7f" || hex === "08") {
    if (tuiState.modelSearchQuery.length > 0) {
      tuiState.modelSearchQuery = tuiState.modelSearchQuery.slice(0, -1);
      refilterModels();
    } else {
      backToProviderStage(callbacks);
    }
    callbacks.renderAll();
    return;
  }
  if (hex === "1b5b44" || hex === "1b4f44") {
    if (tuiState.modelSearchCursor > 0) {
      tuiState.modelSearchCursor -= 1;
    } else {
      backToProviderStage(callbacks);
    }
    callbacks.renderAll();
    return;
  }
  const selectable = getSelectableRows(
    buildModelPickerRows({
      filteredModels: tuiState.filteredModels,
      availableModels: tuiState.availableModels,
      modelSearchQuery: tuiState.modelSearchQuery,
    }),
  );
  const selectableCount = Math.max(1, selectable.length);

  if (hex === "1b5b41" || hex === "1b4f41") {
    tuiState.modelPickerIdx = (tuiState.modelPickerIdx - 1 + selectableCount) % selectableCount;
    callbacks.renderAll();
    return;
  }
  if (hex === "1b5b42" || hex === "1b4f42") {
    tuiState.modelPickerIdx = (tuiState.modelPickerIdx + 1) % selectableCount;
    callbacks.renderAll();
    return;
  }
  if (hex === "0d" || hex === "0a") {
    const selected = selectable[tuiState.modelPickerIdx];
    if (selected && selected.type === "action" && selected.action === "add-model") {
      void quickAddModel(callbacks);
      return;
    }
    void commitHighlightedModel(callbacks);
    return;
  }
  if (hex === "1b") {
    // Esc closes the ENTIRE workflow — never just the model stage.
    closeWorkflow(callbacks);
    return;
  }
  // Single-key actions (a add · d remove · e edit) are active only while the
  // filter is empty — with a query in progress the same keys are search text.
  if (tuiState.modelSearchQuery.length === 0) {
    if (s === "d") {
      removeHighlightedCustomModel(callbacks);
      return;
    }
    if (s === "e") {
      editHighlightedCustomModel(callbacks);
      return;
    }
    if (s === "a") {
      void quickAddModel(callbacks);
      return;
    }
  }
  // Printable characters append to the search filter at the cursor.
  if (s.length === 1 && s >= " " && s <= "~") {
    insertSearchChar(s);
    callbacks.renderAll();
    return;
  }
}

function refilterModels(): void {
  const query = tuiState.modelSearchQuery.toLowerCase();
  tuiState.filteredModels = tuiState.availableModels.filter((m) =>
    m.toLowerCase().includes(query),
  );
  tuiState.modelPickerIdx = 0;
  tuiState.modelSearchCursor = Math.min(
    tuiState.modelSearchCursor,
    tuiState.modelSearchQuery.length,
  );
}

function insertSearchChar(ch: string): void {
  const q = tuiState.modelSearchQuery;
  const at = Math.min(tuiState.modelSearchCursor, q.length);
  tuiState.modelSearchQuery = q.slice(0, at) + ch + q.slice(at);
  tuiState.modelSearchCursor = at + 1;
  refilterModels();
}

function backToProviderStage(callbacks: PickerCallbacks): void {
  // Pending id stays uncommitted — returning to provider selection is safe.
  tuiState.pendingProviderId = null;
  tuiState.modelPickerStage = "provider";
  tuiState.modelSearchQuery = "";
  tuiState.modelSearchCursor = 0;
  tuiState.availableModels = [];
  tuiState.filteredModels = [];
  tuiState.modelPickerIdx = 0;
  tuiState.setStatus("");
  callbacks.renderAll();
}

function closeWorkflow(callbacks: PickerCallbacks): void {
  tuiState.showModelPicker = false;
  tuiState.modelPickerStage = "provider";
  tuiState.pendingProviderId = null;
  tuiState.modelSearchQuery = "";
  tuiState.modelSearchCursor = 0;
  tuiState.availableModels = [];
  tuiState.filteredModels = [];
  tuiState.modelPickerIdx = 0;
  tuiState.setStatus("");
  callbacks.renderAll();
}

// ── Atomic commit ───────────────────────────────────────────────────────────

async function commitHighlightedModel(callbacks: PickerCallbacks): Promise<void> {
  const selectable = getSelectableRows(
    buildModelPickerRows({
      filteredModels: tuiState.filteredModels,
      availableModels: tuiState.availableModels,
      modelSearchQuery: tuiState.modelSearchQuery,
    }),
  );
  const selected = selectable[tuiState.modelPickerIdx];
  if (!selected || selected.type !== "model") {
    return;
  }
  const apiModelId = selected.apiModelId;
  if (!apiModelId || PLACEHOLDER_MARKERS.some((marker) => apiModelId.includes(marker))) {
    return;
  }
  const pending = tuiState.pendingProviderId;
  if (!pending) {
    closeWorkflow(callbacks);
    return;
  }
  await commitModelSelection(pending, apiModelId, callbacks);
}

/**
 * The ONLY runtime mutation of the workflow: activate provider AND model
 * together. Runs after picker close so a failed activation never leaves a
 * half-switched UI; errors surface as a toast with state untouched.
 */
export async function commitModelSelection(
  providerId: string,
  apiModelId: string,
  callbacks?: PickerCallbacks,
): Promise<void> {
  const renderAll = callbacks?.renderAll ?? (() => tuiState.requestRender());
  const previous = getActiveProviderConfig();
  const sameProvider = previous?.id.toLowerCase() === providerId.toLowerCase();
  try {
    // Only already-configured providers may be activated. setActiveProvider
    // happily materializes a default config for unknown ids — correct for the
    // key-setup flow, but the model workflow must never create a provider.
    if (!sameProvider) {
      const configured = listProviders().some(
        (p) => p.id.toLowerCase() === providerId.toLowerCase(),
      );
      if (!configured) {
        throw new Error(`provider '${providerId}' is not configured — add it with /provider or /key first`);
      }
      const ok = setActiveProvider(providerId);
      if (!ok) throw new Error(`provider '${providerId}' could not be activated`);
    }
    tuiState.currentModel = apiModelId;
    tuiState.showModelPicker = false;
    tuiState.modelPickerStage = "provider";
    tuiState.pendingProviderId = null;
    tuiState.modelSearchQuery = "";
    tuiState.modelSearchCursor = 0;
    tuiState.availableModels = [];
    tuiState.filteredModels = [];
    tuiState.setStatus("");
    tuiState.showToast(`Model: ${providerId}/${apiModelId}`);
    renderAll();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    tuiState.showToast(`⚠️ Model switch failed: ${msg}`);
    renderAll();
  }
}

// ── Custom-model actions (picker: d / e) ────────────────────────────────────

function removeHighlightedCustomModel(callbacks: PickerCallbacks): void {
  const providerId = tuiState.pendingProviderId;
  if (!providerId) return;
  const selectable = getSelectableRows(
    buildModelPickerRows({
      filteredModels: tuiState.filteredModels,
      availableModels: tuiState.availableModels,
      modelSearchQuery: tuiState.modelSearchQuery,
    }),
  );
  const selected = selectable[tuiState.modelPickerIdx];
  if (!selected || selected.type !== "model") return;
  const apiModelId = selected.apiModelId;
  if (!apiModelId || PLACEHOLDER_MARKERS.some((m) => apiModelId.includes(m))) return;
  if (!isCustomModel(providerId, apiModelId)) {
    // Discovered-only models are not deletable: no tombstones, no hidden lists.
    tuiState.showToast(`'${apiModelId}' is not a custom model — use provider config to disable it`);
    callbacks.renderAll();
    return;
  }
  const removed = removeCustomModel(providerId, apiModelId);
  if (removed) {
    modelCatalog.remove(`${providerId}/${apiModelId}`);
    tuiState.availableModels = tuiState.availableModels.filter((m) => m !== apiModelId);
    refilterModels();
    tuiState.showToast(`Removed custom model ${providerId}/${apiModelId}`);
  }
  callbacks.renderAll();
}

async function editHighlightedCustomModel(callbacks: PickerCallbacks): Promise<void> {
  const providerId = tuiState.pendingProviderId;
  if (!providerId) return;
  const selectable = getSelectableRows(
    buildModelPickerRows({
      filteredModels: tuiState.filteredModels,
      availableModels: tuiState.availableModels,
      modelSearchQuery: tuiState.modelSearchQuery,
    }),
  );
  const selected = selectable[tuiState.modelPickerIdx];
  if (!selected || selected.type !== "model") return;
  const apiModelId = selected.apiModelId;
  if (!apiModelId) return;
  if (!isCustomModel(providerId, apiModelId)) {
    tuiState.showToast(`'${apiModelId}' is not a custom model — only custom entries can be edited`);
    callbacks.renderAll();
    return;
  }
  const entry = listCustomModelsForProvider(providerId).find(
    (e) => e.apiModelId === apiModelId,
  );
  const nextName = await tuiState.openSecretInput({
    title: `Edit display name — ${providerId}/${apiModelId}`,
    placeholder: entry?.displayName ?? apiModelId,
  });
  tuiState.showModelPicker = true;
  tuiState.modelPickerStage = "model";
  if (nextName && entry) {
    const { upsertCustomModel } = await import("../core/models/customModels");
    upsertCustomModel({ ...entry, displayName: nextName.trim() || undefined });
    tuiState.showToast(`Updated ${providerId}/${apiModelId}`);
  }
  callbacks.renderAll();
}

// ── Quick add (picker: a) ───────────────────────────────────────────────────

async function quickAddModel(callbacks: PickerCallbacks): Promise<void> {
  const providerId = tuiState.pendingProviderId;
  if (!providerId) return;
  // Secret-input modal doubles as a single-field prompt: type the model id.
  const defaultPlaceholder = tuiState.modelSearchQuery.trim() || "e.g. my-org/my-model";
  const apiModelId = (await tuiState.openSecretInput({
    title: `Add model to ${providerId} — model id`,
    placeholder: defaultPlaceholder,
  })).trim();
  if (!apiModelId) {
    tuiState.showModelPicker = true;
    tuiState.modelPickerStage = "model";
    callbacks.renderAll();
    return;
  }
  const displayName = (await tuiState.openSecretInput({
    title: "Display name (optional)",
    placeholder: apiModelId,
  })).trim();

  const { upsertCustomModel } = await import("../core/models/customModels");
  upsertCustomModel({
    providerId,
    apiModelId,
    ...(displayName && displayName !== apiModelId ? { displayName } : {}),
  });

  const { modelCatalog } = await import("../core/models/catalog");
  if (!modelCatalog.get(`${providerId}/${apiModelId}`)) {
    modelCatalog.add({
      id: `${providerId}/${apiModelId}`,
      providerId: providerId.toLowerCase(),
      apiModelId,
      ...(displayName ? { displayName } : {}),
      capabilities: {},
      status: "active",
    });
  }

  // Materialize immediately so the new entry is selectable without a refresh.
  tuiState.availableModels = [...tuiState.availableModels, apiModelId]
    .filter((m, i, arr) => arr.indexOf(m) === i)
    .sort((a, b) => a.localeCompare(b));
  tuiState.modelSearchQuery = "";
  tuiState.modelSearchCursor = 0;
  tuiState.filteredModels = [...tuiState.availableModels];
  const newIdx = tuiState.filteredModels.indexOf(apiModelId);
  tuiState.modelPickerIdx = newIdx >= 0 ? newIdx : 0;
  tuiState.showModelPicker = true;
  tuiState.modelPickerStage = "model";
  tuiState.showToast(`Added custom model ${providerId}/${apiModelId}`);
  callbacks.renderAll();
}

// ── CLI form: /model <ref> with provider qualification ──────────────────────

/**
 * Resolve a `/model <arg>` reference to a provider+model pair when it is
 * provider-qualified (`openrouter/anthropic/claude`), falling back to the
 * active provider for bare ids. Returns null when unresolvable.
 */
export function resolveModelArg(
  arg: string,
  knownProviders: Iterable<string>,
): { providerId: string; apiModelId: string } | null {
  try {
    const ref = parseModelRef(arg, { knownProviders });
    // Unqualified refs keep the ACTIVE provider: resolve lazily at call time.
    const providerId = ref.providerId ?? getActiveProviderConfig()?.id;
    if (!providerId) return null;
    return { providerId, apiModelId: ref.modelId };
  } catch {
    return null;
  }
}
