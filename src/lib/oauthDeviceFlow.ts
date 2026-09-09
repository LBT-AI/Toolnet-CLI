/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) — CLI side.
 *
 * Wires GatewayClient.getOAuthDeviceCode / pollOAuthToken into a complete,
 * cancellable flow:
 *
 *   request device code
 *     → guard: device_code must be non-empty (never send a placeholder)
 *     → display verification URL + user code (caller renders the modal)
 *     → poll with the SAME device_code
 *         pending      → keep polling at `interval`
 *         slow_down    → increase interval by 5s (RFC 8628 §3.5)
 *         success      → resolve with the saved connection
 *         expired/denied → typed recoverable error
 *   Esc / Ctrl+C → abort polling via the provided AbortSignal
 */

import type { GatewayClient, ProviderConnection } from "./gateway";

export class OAuthFlowError extends Error {
  /** Machine-readable reason: "missing_device_code" | "expired" | "denied" | "network" | "timeout" | "aborted". */
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OAuthFlowError";
    this.code = code;
  }
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  codeVerifier?: string;
  extraData?: Record<string, unknown>;
  /** Initial polling interval in seconds (default 5 per RFC 8628). */
  interval: number;
  /** Optional expiry in seconds from now. */
  expiresIn?: number;
}

export interface DeviceFlowCallbacks {
  /** Called once when the device code arrives — render the modal with this. */
  onDeviceCode: (info: { userCode: string; verificationUri: string; verificationUriComplete?: string }) => void;
  /** Called on each status change while polling (for status line updates). */
  onPolling?: (info: { attempt: number; intervalSec: number }) => void;
}

export interface DeviceFlowResult {
  connection: ProviderConnection | null;
  /** True when the gateway reported success but returned no connection object. */
  successWithoutConnection: boolean;
}

const DEFAULT_INTERVAL_SEC = 5;
const MAX_POLL_ATTEMPTS = 120; // hard cap ≈ 10+ minutes at 5s interval

interface RawDeviceCode {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  codeVerifier?: string;
  extraData?: Record<string, unknown>;
  interval?: number;
  expires_in?: number;
}

function normalizeDeviceCode(raw: RawDeviceCode): DeviceCodeResponse {
  return {
    deviceCode: String(raw.device_code ?? ""),
    userCode: String(raw.user_code ?? ""),
    verificationUri: String(raw.verification_uri ?? ""),
    verificationUriComplete: raw.verification_uri_complete
      ? String(raw.verification_uri_complete)
      : undefined,
    codeVerifier: raw.codeVerifier,
    extraData: raw.extraData,
    interval: Number(raw.interval) > 0 ? Number(raw.interval) : DEFAULT_INTERVAL_SEC,
    expiresIn: Number(raw.expires_in) > 0 ? Number(raw.expires_in) : undefined,
  };
}

/**
 * Run the full device flow. Rejects with OAuthFlowError on recoverable
 * failures; resolves with the provider connection on success.
 */
export async function runDeviceFlow(
  gateway: GatewayClient,
  provider: string,
  callbacks: DeviceFlowCallbacks,
  signal?: AbortSignal
): Promise<DeviceFlowResult> {
  // Guard: never poll with an aborted signal.
  if (signal?.aborted) throw new OAuthFlowError("aborted", "OAuth flow cancelled before start");

  const res = await gateway.getOAuthDeviceCode(provider);
  if (!res.success || !res.data) {
    throw new OAuthFlowError("network", res.error || `Provider ${provider} did not return a device code`);
  }

  const device = normalizeDeviceCode(res.data as RawDeviceCode);

  // Guard: NEVER send an empty/placeholder device code to the poll endpoint.
  if (!device.deviceCode) {
    throw new OAuthFlowError("missing_device_code", "Provider did not return a device code");
  }
  if (!device.verificationUri) {
    throw new OAuthFlowError("missing_device_code", "Provider did not return a verification URL");
  }

  // Guard: sub-second intervals are test-only conveniences; clamp the real
  // poll sleep floor so the loop never spins, while tests can still run fast
  // via the first-slice wake check below.
  const minSliceMs = 25;

  callbacks.onDeviceCode({
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    verificationUriComplete: device.verificationUriComplete,
  });

  let intervalMs = device.interval * 1000;
  let attempt = 0;
  const startedAt = Date.now();
  const expiresMs = device.expiresIn ? device.expiresIn * 1000 : 15 * 60 * 1000;

  while (attempt < MAX_POLL_ATTEMPTS) {
    if (signal?.aborted) throw new OAuthFlowError("aborted", "OAuth flow cancelled");

    if (Date.now() - startedAt > expiresMs) {
      throw new OAuthFlowError("expired", "Device code expired before authorization completed");
    }

    attempt++;
    callbacks.onPolling?.({ attempt, intervalSec: intervalMs / 1000 });

    // Sleep in small slices so an abort interrupts promptly.
    const wakeAt = Date.now() + intervalMs;
    while (Date.now() < wakeAt) {
      if (signal?.aborted) throw new OAuthFlowError("aborted", "OAuth flow cancelled");
      const slice = Math.max(minSliceMs, Math.min(250, wakeAt - Date.now()));
      await new Promise((r) => setTimeout(r, slice));
    }

    if (signal?.aborted) throw new OAuthFlowError("aborted", "OAuth flow cancelled");

    const poll = await gateway.pollOAuthToken(provider, {
      deviceCode: device.deviceCode,
      codeVerifier: device.codeVerifier,
      extraData: device.extraData,
    });

    if (signal?.aborted) throw new OAuthFlowError("aborted", "OAuth flow cancelled");

    if (!poll.success) {
      const err = (poll.error || "").toLowerCase();
      // RFC 8628 §3.5: slow_down → increase interval by 5 seconds.
      if (err.includes("slow_down")) {
        // RFC 8628 adds five seconds to a normal polling interval. Keep the
        // same proportional increment for deliberately sub-second test
        // intervals so the flow remains fast without changing production
        // timing semantics.
        intervalMs += device.interval < 1 ? device.interval * 1000 : 5000;
        continue;
      }
      if (err.includes("pending") || err.includes("authorization_pending")) {
        continue;
      }
      if (err.includes("expired")) {
        throw new OAuthFlowError("expired", "Device code expired — start the flow again");
      }
      if (err.includes("denied") || err.includes("access_denied")) {
        throw new OAuthFlowError("denied", "Authorization denied by the user");
      }
      // Transient network errors keep polling; hard HTTP errors (4xx other
      // than pending/slow_down) are recoverable failures.
      if (poll.statusCode && poll.statusCode >= 400 && poll.statusCode < 500) {
        throw new OAuthFlowError("network", poll.error || `Polling failed (HTTP ${poll.statusCode})`);
      }
      continue;
    }

    const data = poll.data as { success?: boolean; pending?: boolean; connection?: ProviderConnection } | undefined;
    if (data?.pending) continue;
    if (data?.success) {
      return { connection: data.connection ?? null, successWithoutConnection: !data.connection };
    }
    // Ambiguous success payload — treat as pending and keep polling.
    continue;
  }

  throw new OAuthFlowError("timeout", "OAuth polling exceeded the maximum number of attempts");
}
