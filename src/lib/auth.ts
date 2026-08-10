import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".toolnet");
const TOKEN_FILE = path.join(CONFIG_DIR, "auth_token");

export function getStoredToken(): string | null {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return null;
  }
}

export function storeToken(token: string) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
}

export function clearToken() {
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch {}
}

export async function login(
  password: string,
  baseUrl = "http://localhost:20127"
): Promise<{ success: boolean; error?: string; token?: string }> {
  try {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    const data = await res.json();

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
  baseUrl = "http://localhost:20127"
): Promise<boolean> {
  const token = getStoredToken();
  if (!token) return false;

  try {
    const res = await fetch(`${baseUrl}/api/auth/status`, {
      headers: { Cookie: `auth_token=${token}` },
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.requireLogin !== true;
  } catch {
    return false;
  }
}
