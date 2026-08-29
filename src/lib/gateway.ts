import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

/**
 * Legacy ToolNet Gateway client.
 *
 * Kept for backward compatibility and for the optional ToolNet provider.
 * Core agent/TUI code should prefer src/providers/ abstraction.
 */

// --- Legacy auth helpers (only used by GatewayClient when connecting to ToolNet gateway) ---

const LEGACY_APP_NAME = "toolnetapi";
const CLI_TOKEN_HEADER = "x-9r-cli-token";
const CLI_TOKEN_SALT = "9r-cli-auth";

function getLegacyDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), LEGACY_APP_NAME);
  }
  return path.join(os.homedir(), `.${LEGACY_APP_NAME}`);
}

const LEGACY_DATA_DIR = getLegacyDataDir();
const MACHINE_ID_FILE = path.join(LEGACY_DATA_DIR, "machine-id");
const AUTH_DIR = path.join(LEGACY_DATA_DIR, "auth");
const CLI_SECRET_FILE = path.join(AUTH_DIR, "cli-secret");
const MACHINE_ID_SALT = "9r-cli-auth";

let cachedCliToken: string | null = null;
let cachedCliSecret: string | null = null;

function loadRawMachineId(): string {
  try {
    const raw = fs.readFileSync(MACHINE_ID_FILE, "utf8").trim();
    if (raw) return raw;
  } catch {}
  return "";
}

function loadCliSecret(): string {
  if (cachedCliSecret) return cachedCliSecret;
  try {
    cachedCliSecret = fs.readFileSync(CLI_SECRET_FILE, "utf8").trim();
    if (cachedCliSecret) return cachedCliSecret;
  } catch {}
  cachedCliSecret = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(CLI_SECRET_FILE, cachedCliSecret, { mode: 0o600 });
  } catch {}
  return cachedCliSecret;
}

function getCliToken(): string {
  if (cachedCliToken !== null) return cachedCliToken;
  const raw = loadRawMachineId();
  const secret = loadCliSecret();
  cachedCliToken = raw
    ? crypto.createHash("sha256").update(raw + CLI_TOKEN_SALT + secret).digest("hex").substring(0, 16)
    : "";
  return cachedCliToken;
}

function getAuthHeaders(): Record<string, string> {
  const token = getCliToken();
  if (!token) return {};
  return { [CLI_TOKEN_HEADER]: token };
}

export interface ApiResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
}

export interface ProviderConnection {
  id: string;
  provider: string;
  providerId: string;
  name?: string;
  displayName?: string;
  email?: string;
  testStatus?: string;
  isActive?: boolean;
  priority?: number;
  defaultModel?: string;
  createdAt?: string;
}

export interface Combo {
  id: string;
  name: string;
  models: string[];
  kind?: string;
  createdAt?: string;
}

export interface ApiKey {
  id: string;
  key: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  isActive?: boolean;
}

export interface GatewaySettings {
  rtkEnabled?: boolean;
  headroomEnabled?: boolean;
  headroomUrl?: string;
  authMode?: string;
  requireLogin?: boolean;
  hasPassword?: boolean;
  jailbreakEnabled?: boolean;
  jailbreakLevel?: string;
  jailbreakCustomPrompt?: string;
}

export interface VersionInfo {
  currentVersion: string;
  latestVersion?: string;
  hasUpdate?: boolean;
}

export interface ModelInfo {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface ModelsResponse {
  object: string;
  data: ModelInfo[];
}

export class GatewayClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/+$/, "");
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      ...getAuthHeaders(),
    };

    if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
      headers["Content-Type"] = "application/json";
    }

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });

      const text = await res.text();

      if (res.status >= 400) {
        let errMsg = `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(text);
          errMsg = parsed.error || errMsg;
        } catch {}
        return { success: false, error: errMsg, statusCode: res.status };
      }

      try {
        const parsed = JSON.parse(text);
        return { success: true, data: parsed as T, statusCode: res.status };
      } catch {
        return { success: true, data: text as unknown as T, statusCode: res.status };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Network error: ${msg}` };
    }
  }

  async checkConnection(): Promise<boolean> {
    try {
      const res = await this.health();
      return res.success;
    } catch {
      return false;
    }
  }

  async health(): Promise<ApiResult<{ ok: boolean }>> {
    return this.request("GET", "/api/health");
  }

  async getVersion(): Promise<ApiResult<VersionInfo>> {
    return this.request("GET", "/api/version");
  }

  async getProviders(): Promise<ApiResult<{ connections: ProviderConnection[] }>> {
    return this.request("GET", "/api/providers");
  }

  async testProvider(id: string): Promise<ApiResult<{ valid: boolean; error?: string }>> {
    return this.request("POST", `/api/providers/${encodeURIComponent(id)}/test`);
  }

  async deleteProvider(id: string): Promise<ApiResult<{ message: string }>> {
    return this.request("DELETE", `/api/providers/${encodeURIComponent(id)}`);
  }

  async getOAuthDeviceCode(provider: string, startUrl?: string): Promise<ApiResult<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    codeVerifier?: string;
    extraData?: Record<string, unknown>;
  }>> {
    let qs = "";
    if (startUrl) qs = `?start_url=${encodeURIComponent(startUrl)}`;
    return this.request("GET", `/api/oauth/${encodeURIComponent(provider)}/device-code${qs}`);
  }

  async pollOAuthToken(provider: string, data: {
    deviceCode: string;
    codeVerifier?: string;
    extraData?: Record<string, unknown>;
  }): Promise<ApiResult<{ success: boolean; connection?: ProviderConnection; pending?: boolean }>> {
    return this.request("POST", `/api/oauth/${encodeURIComponent(provider)}/poll`, {
      deviceCode: data.deviceCode,
      codeVerifier: data.codeVerifier,
      extraData: data.extraData,
    });
  }

  async createApiKeyProvider(data: {
    provider: string;
    apiKey: string;
    name?: string;
    priority?: number;
  }): Promise<ApiResult<{ connection: ProviderConnection }>> {
    return this.request("POST", "/api/providers", data);
  }

  async getCombos(): Promise<ApiResult<{ combos: Combo[] }>> {
    return this.request("GET", "/api/combos");
  }

  async createCombo(data: { name: string; models: string[] }): Promise<ApiResult<Combo>> {
    return this.request("POST", "/api/combos", data);
  }

  async updateCombo(id: string, data: { name?: string; models?: string[] }): Promise<ApiResult<Combo>> {
    return this.request("PUT", `/api/combos/${encodeURIComponent(id)}`, data);
  }

  async deleteCombo(id: string): Promise<ApiResult<{ success: boolean }>> {
    return this.request("DELETE", `/api/combos/${encodeURIComponent(id)}`);
  }

  async getApiKeys(): Promise<ApiResult<{ keys: ApiKey[] }>> {
    return this.request("GET", "/api/keys");
  }

  async createApiKey(name: string): Promise<ApiResult<ApiKey>> {
    return this.request("POST", "/api/keys", { name });
  }

  async deleteApiKey(id: string): Promise<ApiResult<{ message: string }>> {
    return this.request("DELETE", `/api/keys/${encodeURIComponent(id)}`);
  }

  async getSettings(): Promise<ApiResult<GatewaySettings>> {
    return this.request("GET", "/api/settings");
  }

  async updateSettings(data: Partial<GatewaySettings>): Promise<ApiResult<GatewaySettings>> {
    return this.request("PATCH", "/api/settings", data);
  }

  async getAvailableModels(): Promise<ApiResult<ModelsResponse>> {
    return this.request("GET", "/v1/models");
  }

  async authStatus(): Promise<ApiResult<{ requireLogin: boolean; authMode: string }>> {
    return this.request("GET", "/api/auth/status");
  }

  async getCliToolsAllStatuses(): Promise<ApiResult<Record<string, unknown>>> {
    return this.request("GET", "/api/cli-tools/all-statuses");
  }

  async getCoworkSettings(): Promise<ApiResult<Record<string, unknown>>> {
    return this.request("GET", "/api/cli-tools/cowork-settings");
  }

  async probeMcpTools(url: string): Promise<ApiResult<{ tools: { name: string; description?: string }[] }>> {
    return this.request("POST", "/api/cli-tools/cowork-mcp-tools", { url });
  }

  async getMcpRegistry(refresh = false): Promise<ApiResult<{
    servers: { name: string; title: string; description?: string; url: string; transport: string; oauth: boolean; toolNames: string[] }[];
    total: number;
  }>> {
    const qs = refresh ? "?refresh=1" : "";
    return this.request("GET", `/api/cli-tools/cowork-mcp-registry${qs}`);
  }

  async getClaudeSettings(): Promise<ApiResult<Record<string, unknown>>> {
    return this.request("GET", "/api/cli-tools/claude-settings");
  }

  async updateClaudeSettings(data: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
    return this.request("POST", "/api/cli-tools/claude-settings", data);
  }
}

/**
 * Detect gateway URL from environment or legacy config.
 * Returns null if no gateway is configured (no hard-coded default).
 *
 * This is used by backward-compatible code paths only.
 * New code should use src/providers/registry.
 */
export function detectGatewayUrl(): string | null {
  // Check environment variable
  if (process.env.TOOLNET_API_URL) return process.env.TOOLNET_API_URL;

  // Check legacy gateway-url file
  const urlFile = path.join(LEGACY_DATA_DIR, "gateway-url");
  try {
    const url = fs.readFileSync(urlFile, "utf8").trim();
    if (url) return url;
  } catch {}

  return null;
}

let _globalGateway: GatewayClient | null = null;

/**
 * Create a GatewayClient instance. Only call when user has explicitly
 * configured a ToolNet gateway URL.
 */
export function createGateway(baseUrl: string): GatewayClient {
  const gw = new GatewayClient(baseUrl);
  _globalGateway = gw;
  return gw;
}

export function getGateway(): GatewayClient | null {
  return _globalGateway;
}
