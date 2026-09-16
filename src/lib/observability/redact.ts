/**
 * Bounded, redacted provider error evidence.
 *
 * Keeps useful diagnostic context without dumping an unbounded response or
 * leaking secrets. Used before any persistence (logs, crash reports, metrics).
 */
import { redactSecret } from "../../core/models/errors";
import { redactOutputSecrets } from "../security/outputRedactor";

/** Max chars kept per error evidence blob. */
export const ERROR_EVIDENCE_LIMIT = 2_000;
/** Max chars kept per provider body snippet. */
export const PROVIDER_BODY_LIMIT = 1_500;

export interface RedactedErrorEvidence {
  message: string;
  code?: string;
  status?: number;
  bodySnippet?: string;
}

function bound(str: string, limit: number): string {
  if (str.length <= limit) return str;
  return str.slice(0, limit) + "…[truncated]";
}

function extractStatus(message: string): number | undefined {
  const m = message.match(/HTTP\s+(\d{3})/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

function extractCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const c = (err as any).code;
    if (typeof c === "string" && c.length > 0) return c.slice(0, 80);
  }
  return undefined;
}

export function redactedErrorEvidence(err: unknown, opts: { bodyLimit?: number; messageLimit?: number } = {}): RedactedErrorEvidence {
  const rawMsg = err instanceof Error ? err.message : String(err ?? "");
  const redacted = redactSecret(redactOutputSecrets(rawMsg));
  const message = bound(redacted, opts.messageLimit ?? ERROR_EVIDENCE_LIMIT);
  const out: RedactedErrorEvidence = { message };
  const code = extractCode(err);
  if (code) out.code = code;
  const status = extractStatus(rawMsg);
  if (status !== undefined) out.status = status;
  // Provider body snippet is already inside message when present; no second copy.
  return out;
}

export function boundedBodySnippet(body: string, limit = PROVIDER_BODY_LIMIT): string {
  if (!body) return "";
  const redacted = redactSecret(redactOutputSecrets(body));
  return bound(redacted, limit);
}
