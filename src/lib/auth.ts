import fs from "node:fs";
import path from "node:path";
import { getActiveBaseUrl } from "../providers";
import { getToolnetAuthTokenPath } from "./toolnetHome";

// Phase 3: canonical home — legacy ~/.toolnet/auth_token migrated by toolnetHome.
const TOKEN_FILE = getToolnetAuthTokenPath();

export function getStoredToken(): string | null {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return null;
  }
}

export function storeToken(token: string) {
  const { ensureToolnetDir, getToolnetHome } = require("./toolnetHome");
  ensureToolnetDir(getToolnetHome());
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
}

export function clearToken() {
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch {}
}

export async function login(
  password: string,
  baseUrl?: string
): Promise<{ success: boolean; error?: string; token?: string }> {
  const targetUrl = baseUrl || getActiveBaseUrl();
  if (!targetUrl) {
    return { success: false, error: "No gateway URL configured for authentication." };
  }

  try {
    const res = await fetch(`${targetUrl.replace(/\/+$/, "")}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    const data = (await res.json()) as any;

    if (!res.ok) {
      return { success: false, error: data.error || "Login failed" };
    }

    // Extract auth_token from Set-Cookie header
    const setCookie = res.headers.get("set-cookie");
    let token = "";
    if (setCookie) {
      const match = setCookie.match(/auth_token=([^;]+)/);
      if (match) token = match[1];
    }

    if (token) storeToken(token);

    return { success: true, token };
  } catch (err) {
    return { success: false, error: `Connection failed: ${err}` };
  }
}

export async function checkAuth(
  baseUrl?: string
): Promise<boolean> {
  const token = getStoredToken();
  if (!token) return false;
  const targetUrl = baseUrl || getActiveBaseUrl();
  if (!targetUrl) return false;

  try {
    const res = await fetch(`${targetUrl.replace(/\/+$/, "")}/api/auth/status`, {
      headers: { Cookie: `auth_token=${token}` },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as any;
    return data.requireLogin !== true;
  } catch {
    return false;
  }
}
