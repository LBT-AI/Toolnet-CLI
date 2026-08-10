import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const APP_NAME = "toolnetapi";

function getDataDir(): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

const DATA_DIR = getDataDir();
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

export interface CliConfig {
  baseUrl: string;
  defaultModel: string;
  theme: string;
  rtkEnabled: boolean;
  sandboxMode: "workspace" | "ask" | "full-access";
  sessionNames: Record<string, string>;
  sessionOrder: string[];
  lastSession: string | null;
}

export const DEFAULT_CONFIG: CliConfig = {
  baseUrl: "http://127.0.0.1:20127",
  defaultModel: "openai/gpt-4o",
  theme: "dark",
  rtkEnabled: true,
  sandboxMode: "ask",
  sessionNames: {},
  sessionOrder: [],
  lastSession: null,
};

let cachedConfig: CliConfig | null = null;

function ensureDir(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

export function loadConfig(): CliConfig {
  if (cachedConfig) return cachedConfig;
  ensureDir();
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    cachedConfig = { ...DEFAULT_CONFIG, ...parsed };
    if (cachedConfig?.baseUrl && cachedConfig.baseUrl.includes("20128")) {
      cachedConfig.baseUrl = cachedConfig.baseUrl.replace("20128", "20127");
      saveConfig();
    }
  } catch {
    cachedConfig = { ...DEFAULT_CONFIG };
  }
  return cachedConfig as CliConfig;
}

export function saveConfig(): void {
  if (!cachedConfig) return;
  ensureDir();
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cachedConfig, null, 2), "utf8");
  } catch {}
}

export function getConfig(): CliConfig {
  return loadConfig();
}

export function updateConfig(partial: Partial<CliConfig>): void {
  const cfg = loadConfig();
  Object.assign(cfg, partial);
  saveConfig();
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
