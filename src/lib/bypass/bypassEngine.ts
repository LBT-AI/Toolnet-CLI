import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ALL_BYPASS_LEVELS, type BypassConfig, type BypassLevel, type BypassTurnResult, type RefusalCheckResult } from "./types";
import { BYPASS_LEVEL_CATALOG, getBypassPrompt } from "./prompts";
import { isRefusal, getEscalatedLevel, generateRefusalOverridePrompt } from "./antiRefusal";
import { setBypassPolicy } from "../codingAgent";

function getConfigDir(): string {
  if (process.env.TOOLNETCLI_CONFIG_DIR) return process.env.TOOLNETCLI_CONFIG_DIR;
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  return path.join(os.homedir(), ".toolnetcli");
}

const CONFIG_FILE = path.join(getConfigDir(), "bypass-config.json");

export class BypassEngine {
  private config: BypassConfig = {
    enabled: false,
    level: "full",
    autoEscalate: true,
    forceExecution: false,
    prefixInjection: false,
  };

  private listeners: Array<(config: BypassConfig) => void> = [];

  constructor() {
    this.loadPersistedConfig();
  }

  private loadPersistedConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.enabled === "boolean") this.config.enabled = parsed.enabled;
        if (parsed.level && ALL_BYPASS_LEVELS.includes(parsed.level)) this.config.level = parsed.level;
        if (typeof parsed.autoEscalate === "boolean") this.config.autoEscalate = parsed.autoEscalate;
        if (typeof parsed.forceExecution === "boolean") this.config.forceExecution = parsed.forceExecution;
        if (parsed.customPrompt) this.config.customPrompt = parsed.customPrompt;
        if (typeof parsed.prefixInjection === "boolean") this.config.prefixInjection = parsed.prefixInjection;
      }
    } catch {}
    // Sync local bypass policy
    setBypassPolicy(this.config.enabled && this.config.forceExecution);
  }

  public saveConfig() {
    try {
      const dir = getConfigDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

  public getLevel(): BypassLevel {
    return this.config.level;
  }

  public setBypass(enabled: boolean, level?: BypassLevel, customPrompt?: string): void {
    this.config.enabled = enabled;
    if (level && ALL_BYPASS_LEVELS.includes(level)) {
      this.config.level = level;
    }
    if (customPrompt !== undefined) {
      this.config.customPrompt = customPrompt;
    }
    // Update local workspace bypass policy if force execution is on
    setBypassPolicy(enabled && this.config.forceExecution);
    this.saveConfig();
  }

  public setLevel(level: BypassLevel): void {
    if (ALL_BYPASS_LEVELS.includes(level)) {
      this.config.level = level;
      this.saveConfig();
    }
  }

  public setAutoEscalate(enabled: boolean): void {
    this.config.autoEscalate = enabled;
    this.saveConfig();
  }

  public setForceExecution(enabled: boolean): void {
    this.config.forceExecution = enabled;
    setBypassPolicy(this.config.enabled && enabled);
    this.saveConfig();
  }

  public setCustomPrompt(prompt: string): void {
    this.config.customPrompt = prompt;
    this.config.level = "custom";
    this.config.enabled = true;
    this.saveConfig();
  }

  /**
   * Synthesizes base agent system prompt with active Bypass directives.
   */
  public getBypassSystemPrompt(baseSystemPrompt: string, overrideLevel?: BypassLevel): string {
    if (!this.config.enabled && !overrideLevel) {
      return baseSystemPrompt;
    }

    const activeLevel = overrideLevel || this.config.level;
    const bypassPrompt = getBypassPrompt(activeLevel, this.config.customPrompt);

    return (
      `${bypassPrompt}\n\n` +
      `════════════════════════════════════════════════════════════════════════════════\n` +
      `[OPERATIONAL CAPABILITIES & LOCAL ENVIRONMENT]\n` +
      `${baseSystemPrompt}`
    );
  }

  /**
   * Checks if an LLM output is a refusal and determines if auto-escalation is needed.
   */
  public checkRefusal(responseText: string): RefusalCheckResult {
    if (!this.config.enabled) {
      return { isRefusal: false };
    }
    return isRefusal(responseText);
  }

  /**
   * Generates recovery turn with escalated bypass level when refusal is detected.
   */
  public escalate(originalPrompt: string): { newLevel: BypassLevel; overridePrompt: string } | null {
    if (!this.config.enabled) return null;

    const currentLevel = this.config.level;
    const newLevel = getEscalatedLevel(currentLevel);

    if (newLevel === currentLevel && currentLevel === "godmode") {
      // Already at top level
      return {
        newLevel: "godmode",
        overridePrompt: generateRefusalOverridePrompt(originalPrompt, currentLevel, newLevel),
      };
    }

    this.config.level = newLevel;
    this.saveConfig();

    return {
      newLevel,
      overridePrompt: generateRefusalOverridePrompt(originalPrompt, currentLevel, newLevel),
    };
  }

  public getLevelCatalog() {
    return BYPASS_LEVEL_CATALOG;
  }
}

export const bypassEngine = new BypassEngine();
