import fs from "node:fs";
import path from "node:path";
import { getToolnetHome } from "../toolnetHome";
import type { BypassConfig, RefusalCheckResult } from "./types";
import { isRefusal, buildRetryPrompt } from "./antiRefusal";
import { getBypassPrompt } from "./prompts";

/**
 * Bypass engine — ONE mode, honest semantics.
 *
 * Bypass is a MODEL-DISPOSITION feature: it makes the agent more willing to
 * build what the user asks and less prone to lecturing. It is NOT a security
 * feature and it deliberately has NO power over permissions:
 *
 *  - it never calls setBypassPolicy / touches sandbox or SecurityEngine state;
 *  - it never forges system messages or "clearances";
 *  - "auto retry" re-asks ONCE with an honest prompt when a spurious refusal
 *    is detected — the user's approvals stay exactly as interactive as before.
 */

function getConfigDir(): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  return getToolnetHome();
}

const CONFIG_FILE = path.join(getConfigDir(), "bypass-config.json");

const DEFAULT_CONFIG: BypassConfig = {
  enabled: false,
  autoRetry: true,
};

export class BypassEngine {
  private config: BypassConfig = { ...DEFAULT_CONFIG };
  private listeners: Array<(config: BypassConfig) => void> = [];

  constructor() {
    this.loadPersistedConfig();
  }

  private loadPersistedConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
        if (typeof raw.enabled === "boolean") this.config.enabled = raw.enabled;
        // `autoRetry` replaces the old `autoEscalate`; honor old configs once.
        if (typeof raw.autoRetry === "boolean") this.config.autoRetry = raw.autoRetry;
        else if (typeof raw.autoEscalate === "boolean") this.config.autoRetry = raw.autoEscalate;
        if (typeof raw.customPrompt === "string" && raw.customPrompt) this.config.customPrompt = raw.customPrompt;
      }
    } catch {}
  }

  public saveConfig() {
    try {
      const dir = getConfigDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    } catch {}
    this.notifyListeners();
  }

  public onConfigChange(listener: (config: BypassConfig) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notifyListeners() {
    for (const listener of this.listeners) {
      try {
        listener({ ...this.config });
      } catch {}
    }
  }

  public getConfig(): BypassConfig {
    return { ...this.config };
  }

  public isEnabled(): boolean {
    return this.config.enabled;
  }

  public setBypass(enabled: boolean): void {
    this.config.enabled = enabled;
    this.saveConfig();
  }

  public setAutoRetry(enabled: boolean): void {
    this.config.autoRetry = enabled;
    this.saveConfig();
  }

  public setCustomPrompt(prompt: string): void {
    this.config.customPrompt = prompt.trim() || undefined;
    this.saveConfig();
  }

  /**
   * Compose the base system prompt with the cooperative directive. The base
   * prompt is never weakened or replaced — the directive is prepended as an
   * additional contract the model must ALSO follow.
   */
  public getBypassSystemPrompt(baseSystemPrompt: string): string {
    const directive = getBypassPrompt(this.config);
    if (!directive) return baseSystemPrompt;
    return `${directive}\n\n${baseSystemPrompt}`;
  }

  /** Check a model answer for a spurious refusal (bypass-aware). */
  public checkRefusal(responseText: string): RefusalCheckResult {
    if (!this.config.enabled || !this.config.autoRetry) {
      return { isRefusal: false };
    }
    return isRefusal(responseText);
  }

  /** The honest once-only retry prompt for a detected spurious refusal. */
  public retryPrompt(originalUserPrompt: string): string | null {
    if (!this.config.enabled || !this.config.autoRetry) return null;
    return buildRetryPrompt(originalUserPrompt);
  }

  /** Legacy no-op kept so old callers cannot re-introduce a bypass path. */
  public createSubagentContext(_parentConfig?: BypassConfig): BypassConfig {
    // Subagents run under the same prompt composition; no separate context.
    return { ...this.config };
  }
}

export const bypassEngine = new BypassEngine();
