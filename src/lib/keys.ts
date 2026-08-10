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

const KEYS_FILE = path.join(getDataDir(), "cli-keys.json");

export function loadCliKeys(): Record<string, string> {
  try {
    const raw = fs.readFileSync(KEYS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveCliKey(provider: string, key: string): void {
  const keys = loadCliKeys();
  keys[provider] = key;
  try {
    fs.mkdirSync(getDataDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.error("Failed to save CLI key:", err);
  }
}

export function getCliKey(provider: string): string | null {
  const keys = loadCliKeys();
  return keys[provider] || null;
}
