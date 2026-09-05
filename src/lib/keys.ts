import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getToolnetKeysPath } from "./toolnetHome";

function getDataDir(): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  // Phase 3: canonical home (win32 included — one root everywhere).
  return path.dirname(getToolnetKeysPath());
}

function getKeysFile(): string {
  return getToolnetKeysPath();
}
const LEGACY_KEYS_FILE = path.join(os.homedir(), ".toolnetapi", "cli-keys.json");

const PROVIDER_ALIASES: Record<string, string[]> = {
  alibaba: ["alibaba", "dashscope", "qwen", "aliyun", "ali"],
  dashscope: ["dashscope", "alibaba", "qwen", "aliyun", "ali"],
  qwen: ["qwen", "alibaba", "dashscope", "aliyun", "ali"],
  openai: ["openai", "gpt"],
  anthropic: ["anthropic", "claude"],
  gemini: ["gemini", "google"],
  deepseek: ["deepseek"],
  groq: ["groq"],
  openrouter: ["openrouter"],
  minimax: ["minimax"],
  cohere: ["cohere"],
  together: ["together"],
  mistral: ["mistral"],
  xai: ["xai", "grok"],
  toolnet: ["toolnet", "default", "gateway"],
};

const ENV_KEY_MAP: Record<string, string[]> = {
  alibaba: ["DASHSCOPE_API_KEY", "ALIBABA_API_KEY", "QWEN_API_KEY"],
  dashscope: ["DASHSCOPE_API_KEY", "ALIBABA_API_KEY", "QWEN_API_KEY"],
  qwen: ["DASHSCOPE_API_KEY", "ALIBABA_API_KEY", "QWEN_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  groq: ["GROQ_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  cohere: ["COHERE_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  xai: ["XAI_API_KEY"],
  toolnet: ["TOOLNET_API_KEY", "TOOLNET_TOKEN"],
};

export function loadCliKeys(): Record<string, string> {
  try {
    const keysFile = getKeysFile();
    if (fs.existsSync(keysFile)) {
      const raw = fs.readFileSync(keysFile, "utf8");
      return JSON.parse(raw);
    }
  } catch {}

  try {
    if (fs.existsSync(LEGACY_KEYS_FILE)) {
      const raw = fs.readFileSync(LEGACY_KEYS_FILE, "utf8");
      return JSON.parse(raw);
    }
  } catch {}

  return {};
}

export function saveCliKey(provider: string, key: string): void {
  const normProvider = provider.toLowerCase().trim();
  const keys = loadCliKeys();
  keys[normProvider] = key.trim();
  try {
    const dataDir = getDataDir();
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(getKeysFile(), JSON.stringify(keys, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.error("Failed to save CLI key:", err);
  }
}

export function deleteCliKey(provider: string): boolean {
  const normProvider = provider.toLowerCase().trim();
  const keys = loadCliKeys();
  const aliases = PROVIDER_ALIASES[normProvider] || [normProvider];
  let deleted = false;

  for (const alias of aliases) {
    if (keys[alias] !== undefined) {
      delete keys[alias];
      deleted = true;
    }
  }

  if (deleted) {
    try {
      const dataDir = getDataDir();
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(getKeysFile(), JSON.stringify(keys, null, 2), { encoding: "utf8", mode: 0o600 });
    } catch {}
  }

  return deleted;
}

export function getCliKey(provider: string): string | null {
  const normProvider = provider.toLowerCase().trim();
  const keys = loadCliKeys();

  // 1. Direct match in storage
  if (keys[normProvider]) return keys[normProvider];

  // 2. Alias match in storage
  const aliases = PROVIDER_ALIASES[normProvider] || [];
  for (const alias of aliases) {
    if (keys[alias]) return keys[alias];
  }

  // 3. Environment variables match
  const envVars = ENV_KEY_MAP[normProvider] || [];
  for (const envVar of envVars) {
    const val = process.env[envVar];
    if (val) return val.trim();
  }

  return null;
}

export function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}••••••••${key.slice(-4)}`;
}

export interface StoredKeyInfo {
  provider: string;
  maskedKey: string;
  source: "stored" | "env";
  envVar?: string;
}

export function listAllCliKeys(): StoredKeyInfo[] {
  const keys = loadCliKeys();
  const result: StoredKeyInfo[] = [];
  const seenProviders = new Set<string>();

  // Stored keys
  for (const [provider, key] of Object.entries(keys)) {
    if (key) {
      result.push({
        provider,
        maskedKey: maskApiKey(key),
        source: "stored",
      });
      seenProviders.add(provider.toLowerCase());
    }
  }

  // Environment keys
  for (const [provider, envVars] of Object.entries(ENV_KEY_MAP)) {
    if (seenProviders.has(provider)) continue;
    for (const envVar of envVars) {
      const val = process.env[envVar];
      if (val) {
        result.push({
          provider,
          maskedKey: maskApiKey(val),
          source: "env",
          envVar,
        });
        seenProviders.add(provider);
        break;
      }
    }
  }

  return result;
}
