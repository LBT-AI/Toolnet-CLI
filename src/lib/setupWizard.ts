/**
 * First-run / manual setup wizard for ToolNet CLI.
 *
 * v1.2.2 HOTFIX — the broken interview is gone:
 *   - "First run detected — launching setup wizard…"            (removed)
 *   - "Configuration already exists. Re-run setup?"              (removed)
 *   - Connection Mode / direct / skip / "Choose mode"            (removed)
 *
 * New flow is short and resume-aware:
 *
 *   ToolNet CLI
 *
 *   Select provider:
 *   > ToolNet
 *     OpenAI
 *     Anthropic
 *     Gemini
 *     Custom
 *
 *   API Key:   [hidden]
 *   Model:     [from the provider's real model list, or manual id]
 *   ✓ Configuration saved
 *
 * The wizard is launched at startup ONLY when there is no usable
 * configuration (provider + key + model). Partial/broken config resumes at
 * the first missing step instead of restarting from scratch, and nothing is
 * persisted until the full minimum-usable configuration is confirmed —
 * Esc/Ctrl+C aborts cleanly with no writes (atomic save at the end).
 */

import { loadAppConfig, updateAppConfig, resetAppConfigCache, type AppConfig } from "./appConfig";
import { saveCliKey } from "./keys";
import {
  getActiveProviderConfig,
  getDefaultProviderConfig,
  resolveApiKey,
  addProvider,
  setActiveProvider,
  autoRestoreActiveProvider,
  createProviderInstance,
  resetProvidersConfigCache,
} from "../providers";
import type { ModelInfo, ProviderConfig } from "../providers/types";
import { write } from "../term";

// ---------------------------------------------------------------------------
// Public result / state types
// ---------------------------------------------------------------------------

export interface WizardResult {
  completed: boolean;
  providerId: string | null;
  model: string;
  config: AppConfig | null;
}

export type MissingStep = "provider" | "key" | "model";

export interface SetupState {
  /** True when nothing usable is configured (no active provider at all). */
  fresh: boolean;
  /** True only when provider + key + model are all present. */
  usable: boolean;
  /** Steps that still need to be completed, in wizard order. */
  missing: MissingStep[];
  providerConfig: ProviderConfig | null;
  config: AppConfig;
}

export interface WizardIO {
  print(text: string): void;
  select(prompt: string, options: string[]): Promise<{ value: string; index: number; aborted: boolean }>;
  hiddenInput(prompt: string): Promise<{ value: string; aborted: boolean }>;
  textInput(prompt: string, opts?: { default?: string }): Promise<{ value: string; aborted: boolean }>;
}

// ---------------------------------------------------------------------------
// Known provider list (target first-run UX)
// ---------------------------------------------------------------------------

const PROVIDER_CHOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "toolnet", label: "ToolNet" },
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "gemini", label: "Gemini" },
  { id: "custom", label: "Custom" },
];

const MANUAL_MODEL_LABEL = "Enter a model id manually";

const FORBIDDEN_STARTUP_TEXT = [
  "First run detected",
  "Configuration already exists",
  "Re-run setup",
  "Connection Mode",
  "direct/skip",
  "Choose mode",
];

// ---------------------------------------------------------------------------
// TTY helpers
// ---------------------------------------------------------------------------

export function isTty(): boolean {
  try {
    return Boolean(process.stdin?.isTTY);
  } catch {
    return false;
  }
}

export type RawKey =
  | { type: "up" }
  | { type: "down" }
  | { type: "enter" }
  | { type: "esc" }
  | { type: "ctrl-c" }
  | { type: "backspace" }
  | { type: "char"; ch: string };

/**
 * Buffered raw-mode key reader. Assembles chunked bytes into discrete keys
 * so arrow keys arriving split across stdin chunks are handled correctly.
 */
export class RawKeyReader {
  private buffer: Buffer = Buffer.alloc(0);
  private handler: (key: RawKey) => void = () => {};
  private escTimer: ReturnType<typeof setTimeout> | null = null;
  private onData = (chunk: Buffer) => this.feed(chunk);
  private onEnd = () => this.handler({ type: "ctrl-c" });

  attach(): void {
    process.stdin.on("data", this.onData);
    process.stdin.on("end", this.onEnd);
  }

  detach(): void {
    process.stdin.off("data", this.onData);
    process.stdin.off("end", this.onEnd);
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
  }

  onKey(h: (key: RawKey) => void): void {
    this.handler = h;
  }

  feed(chunk: Buffer): RawKey[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out: RawKey[] = [];
    while (this.buffer.length > 0) {
      const b = this.buffer[0];
      if (b === 0x1b) {
        if (this.buffer.length >= 3 && this.buffer[1] === 0x5b) {
          const c = this.buffer[2];
          this.buffer = this.buffer.slice(3);
          if (c === 0x41) out.push({ type: "up" });
          else if (c === 0x42) out.push({ type: "down" });
          // right/left arrows and other CSI sequences are intentionally ignored
          continue;
        }
        if (this.buffer.length === 1) {
          // A lone ESC may still be the start of an escape sequence — wait.
          if (this.escTimer) clearTimeout(this.escTimer);
          this.escTimer = setTimeout(() => {
            this.escTimer = null;
            if (this.buffer.length === 1 && this.buffer[0] === 0x1b) {
              this.buffer = Buffer.alloc(0);
              this.handler({ type: "esc" });
            }
          }, 60);
          break;
        }
        this.buffer = this.buffer.slice(1);
        out.push({ type: "esc" });
        continue;
      }
      if (b === 0x0d || b === 0x0a) {
        this.buffer = this.buffer.slice(1);
        out.push({ type: "enter" });
        continue;
      }
      if (b === 0x03) {
        this.buffer = this.buffer.slice(1);
        out.push({ type: "ctrl-c" });
        continue;
      }
      if (b === 0x7f || b === 0x08) {
        this.buffer = this.buffer.slice(1);
        out.push({ type: "backspace" });
        continue;
      }
      let len = 1;
      if ((b & 0xe0) === 0xc0) len = 2;
      else if ((b & 0xf0) === 0xe0) len = 3;
      else if ((b & 0xf8) === 0xf0) len = 4;
      if (this.buffer.length < len) break;
      const ch = this.buffer.slice(0, len).toString("utf8");
      this.buffer = this.buffer.slice(len);
      out.push({ type: "char", ch });
    }
    for (const k of out) this.handler(k);
    return out;
  }
}

function ttySelect(prompt: string, options: string[]): Promise<{ value: string; index: number; aborted: boolean }> {
  return new Promise((resolve) => {
    let idx = 0;
    let first = true;
    let done = false;
    const reader = new RawKeyReader();
    const prevRaw = Boolean(process.stdin.isRaw);
    if (!prevRaw) process.stdin.setRawMode(true);
    reader.attach();

    const finish = (value: string, aborted: boolean) => {
      if (done) return;
      done = true;
      reader.detach();
      if (!prevRaw) {
        try {
          process.stdin.setRawMode(false);
        } catch {}
      }
      write("\n");
      resolve({ value, index: idx, aborted });
    };

    const render = () => {
      const lines = options.map((o, i) => (i === idx ? "> " : "  ") + o).join("\n");
      if (!first) {
        write("\x1b[" + options.length + "A\x1b[J");
      }
      first = false;
      write(lines + "\n");
    };

    write(prompt + "\n");
    render();

    reader.onKey((key) => {
      if (key.type === "up") {
        idx = (idx + options.length - 1) % options.length;
        render();
      } else if (key.type === "down") {
        idx = (idx + 1) % options.length;
        render();
      } else if (key.type === "enter") {
        finish(options[idx] ?? "", false);
      } else if (key.type === "esc" || key.type === "ctrl-c") {
        finish("", true);
      }
    });
  });
}

function ttySecretInput(prompt: string, hidden: boolean, fallbackDefault?: string): Promise<{ value: string; aborted: boolean }> {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const reader = new RawKeyReader();
    const prevRaw = Boolean(process.stdin.isRaw);
    if (!prevRaw) process.stdin.setRawMode(true);
    reader.attach();

    const finish = (value: string, aborted: boolean) => {
      if (done) return;
      done = true;
      reader.detach();
      if (!prevRaw) {
        try {
          process.stdin.setRawMode(false);
        } catch {}
      }
      write("\n");
      resolve({ value, aborted });
    };

    write(prompt + " ");
    reader.onKey((key) => {
      if (key.type === "enter") {
        finish(buf.trim() || fallbackDefault || "", false);
      } else if (key.type === "esc" || key.type === "ctrl-c") {
        finish("", true);
      } else if (key.type === "backspace") {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          write("\b \b");
        }
      } else if (key.type === "char") {
        buf += key.ch;
        if (hidden) {
          write("•");
        } else {
          write(key.ch);
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Non-TTY (piped / plain stdin) helpers
// ---------------------------------------------------------------------------

// The whole piped input is read once and consumed line-by-line. This keeps
// `toolnet config init < answers.txt` working: every prompt resolves from the
// already-available buffer instead of racing against readline's line events.
let pipedInput: string[] | null = null;
let pipedCursor = 0;

async function readPipedLine(): Promise<{ value: string; aborted: boolean }> {
  if (pipedInput === null) {
    let data = "";
    try {
      for await (const chunk of process.stdin) data += chunk.toString("utf8");
    } catch {
      // stdin is not iterable in this runtime — fall back to an empty answer.
    }
    pipedInput = data.split(/\r?\n/);
  }
  if (pipedCursor >= pipedInput.length) return { value: "", aborted: true };
  const line = pipedInput[pipedCursor++];
  return { value: (line ?? "").trim(), aborted: false };
}

function lineSelect(prompt: string, options: string[]): Promise<{ value: string; index: number; aborted: boolean }> {
  return (async () => {
    console.log(prompt);
    options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
    const { value, aborted } = await readPipedLine();
    if (aborted) return { value: "", index: 0, aborted: true };
    const trimmed = value.trim();
    const num = /^\d+$/.test(trimmed) ? Number(trimmed) - 1 : -1;
    const byName = options.findIndex(
      (o) => o.toLowerCase() === trimmed.toLowerCase() || o.toLowerCase().startsWith(trimmed.toLowerCase())
    );
    const index = num >= 0 && num < options.length ? num : byName;
    if (index < 0) return { value: options[0] ?? "", index: 0, aborted: false };
    return { value: options[index], index, aborted: false };
  })();
}

function lineInput(prompt: string, hidden: boolean, fallbackDefault?: string): Promise<{ value: string; aborted: boolean }> {
  return (async () => {
    const { value, aborted } = await readPipedLine();
    if (aborted) return { value: "", aborted: true };
    const trimmed = value.trim();
    const suffix = fallbackDefault ? ` [${fallbackDefault}]` : "";
    console.log(prompt + (hidden ? "" : suffix));
    return { value: trimmed || fallbackDefault || "", aborted: false };
  })();
}

function createConsoleIO(): WizardIO {
  if (!isTty()) {
    return {
      print: (t) => console.log(t),
      select: lineSelect,
      hiddenInput: (p) => lineInput(p, true),
      textInput: (p, o) => lineInput(p, false, o?.default),
    };
  }
  return {
    print: (t) => console.log(t),
    select: ttySelect,
    hiddenInput: (p) => ttySecretInput(p, true),
    textInput: (p, o) => ttySecretInput(p, false, o?.default),
  };
}

// ---------------------------------------------------------------------------
// Configuration state analysis
// ---------------------------------------------------------------------------

/**
 * True only when the configuration is actually usable by the agent:
 * an active provider that still exists + a resolveable key + a model.
 * Empty / default configs and config.json-only files are NOT "configured".
 */
export function hasUsableConfiguration(): boolean {
  return analyzeSetupState().usable;
}

/**
 * Inspects the current on-disk state and reports which wizard steps still
 * need to be completed. Does not mutate config (except the harmless,
 * self-healing activation of a provider that already has a real key).
 */
export function analyzeSetupState(): SetupState {
  const { config } = loadAppConfig();
  let providerConfig = getActiveProviderConfig();
  if (!providerConfig) {
    // A real key (stored or env) is already usable state — surface it
    // instead of forcing the wizard on a user who IS configured.
    providerConfig = autoRestoreActiveProvider();
  }

  const missing: MissingStep[] = [];
  if (!providerConfig) {
    missing.push("provider");
  } else {
    if (!resolveApiKey(providerConfig)) missing.push("key");
    const model = config.defaultModel?.trim() || providerConfig.defaultModel?.trim() || "";
    if (!model) missing.push("model");
  }

  return {
    fresh: !providerConfig,
    usable: missing.length === 0,
    missing,
    providerConfig,
    config,
  };
}

/** Startup gate: interactive + TTY + no usable configuration. */
export function shouldAutoLaunchSetup(): boolean {
  if (!isTty()) return false;
  return !analyzeSetupState().usable;
}

// ---------------------------------------------------------------------------
// Wizard flow (testable core — inject any WizardIO)
// ---------------------------------------------------------------------------

function persistSetup(providerId: string, providerConfig: ProviderConfig, newKey: string | null, model: string): void {
  resetProvidersConfigCache();
  resetAppConfigCache();

  const finalConfig: ProviderConfig = {
    ...providerConfig,
    id: providerId,
    defaultModel: model,
  };

  if (newKey) saveCliKey(providerId, newKey);
  addProvider(finalConfig);
  setActiveProvider(providerId);
  updateAppConfig({
    provider: providerId,
    keyProvider: providerId,
    baseUrl: finalConfig.baseUrl,
    defaultModel: model,
  });
}

export interface WizardFlowOptions {
  forceAll?: boolean;
  /** Injectable for tests — defaults to the provider's real model list. */
  fetchModels?: (config: ProviderConfig) => Promise<ModelInfo[]>;
}

export async function runSetupWizardFlow(io: WizardIO, opts: WizardFlowOptions = {}): Promise<WizardResult> {
  const { forceAll = false } = opts;
  const fetchModels = opts.fetchModels ?? ((cfg) => createProviderInstance(cfg).listModels());
  const state = analyzeSetupState();
  const abort = (): WizardResult => ({ completed: false, providerId: null, model: "", config: null });

  // ---- 1. Provider ----
  // Decided dynamically (not from the snapshot of `state.missing`): picking a
  // provider makes the provider/key/model steps resolve in order, and each one
  // is skipped only when it is genuinely already satisfied.
  const storedProvider = state.providerConfig ? { ...state.providerConfig } : null;
  let providerId: string | null = storedProvider?.id ?? null;
  let providerConfig: ProviderConfig | null = storedProvider;
  // The model is always confirmed when the user (re)selected the provider in
  // this run — a provider's built-in defaultModel is a fallback, not a choice.
  let providerSelected = false;

  if (forceAll || !providerConfig) {
    providerSelected = true;
    const sel = await io.select("\nToolNet CLI\n\nSelect provider:", PROVIDER_CHOICES.map((c) => c.label));
    if (sel.aborted) return abort();
    const choice = PROVIDER_CHOICES.find((c) => c.label === sel.value);
    if (!choice) return abort();

    if (choice.id === "custom") {
      const idRes = await io.textInput("\nCustom provider ID (e.g. myproxy):");
      if (idRes.aborted) return abort();
      const clean = idRes.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      if (!clean) return abort();
      const urlRes = await io.textInput("\nBase URL (e.g. https://api.example.com/v1):", {
        default: "https://api.openai.com/v1",
      });
      if (urlRes.aborted) return abort();
      providerId = clean;
      providerConfig = getDefaultProviderConfig(clean);
      providerConfig.baseUrl = urlRes.value.trim() || "https://api.openai.com/v1";
    } else {
      providerId = choice.id;
      // Keep the stored base URL / defaults if the user re-picks the same
      // provider; otherwise fall back to the provider's baseline.
      providerConfig = storedProvider && storedProvider.id === choice.id ? storedProvider : getDefaultProviderConfig(choice.id);
    }
  }

  if (!providerId || !providerConfig) return abort();

  // ---- 2. API key ----
  let newKey: string | null = null;
  const existingKey = resolveApiKey(providerConfig);
  if (forceAll || !existingKey) {
    const keyRes = await io.hiddenInput("\nAPI Key:");
    if (keyRes.aborted) return abort();
    if (!keyRes.value.trim()) return abort();
    newKey = keyRes.value.trim();
  }
  const effectiveKey = newKey ?? existingKey;
  if (!effectiveKey) return abort();

  // ---- 3. Fetch the provider's real model list, then pick ----
  io.print("\nFetching models…");
  let models: ModelInfo[] = [];
  try {
    models = await fetchModels({ ...providerConfig, apiKey: newKey ?? undefined });
  } catch {
    models = [];
  }
  const modelIds = Array.from(new Set((models || []).filter((m) => m && m.id).map((m) => m.id)));

  const storedModel = state.config.defaultModel?.trim() || providerConfig.defaultModel?.trim() || "";
  let model: string;
  if (forceAll || providerSelected || !storedModel) {
    if (modelIds.length > 0) {
      const ms = await io.select("\nModel:", [...modelIds, MANUAL_MODEL_LABEL]);
      if (ms.aborted) return abort();
      if (ms.value === MANUAL_MODEL_LABEL) {
        const manual = await io.textInput("\nModel id:");
        if (manual.aborted || !manual.value.trim()) return abort();
        model = manual.value.trim();
      } else {
        model = ms.value;
      }
    } else {
      const manual = await io.textInput("\nModel id (could not fetch the provider model list):");
      if (manual.aborted || !manual.value.trim()) return abort();
      model = manual.value.trim();
    }
  } else {
    model = storedModel || modelIds[0] || "";
    if (!model) return abort();
  }
  if (!model) return abort();

  // ---- 4. Persist — only after the minimum-usable config is confirmed ----
  persistSetup(providerId, providerConfig, newKey, model);
  io.print("\n✓ Configuration saved\n");
  return {
    completed: true,
    providerId,
    model,
    config: loadAppConfig().config,
  };
}

/** Interactive setup entrypoint (TTY-aware). */
export async function runSetupWizard(opts: { forceAll?: boolean } = {}): Promise<WizardResult> {
  return runSetupWizardFlow(createConsoleIO(), opts);
}

/** Non-interactive hint when stdin has no TTY. */
export function printSetupHint(): void {
  console.log(
    "\n\x1b[33mFirst-run setup required.\x1b[0m Run:\n" +
      "  toolnet config init\n\n" +
      "Or set API key manually:\n" +
      "  export ANTHROPIC_API_KEY=sk-...\n" +
      "  export OPENAI_API_KEY=sk-...\n"
  );
}

/** For regression tests: asserts the removed first-run strings are gone. */
export function forbiddenStartupStrings(): string[] {
  return FORBIDDEN_STARTUP_TEXT;
}