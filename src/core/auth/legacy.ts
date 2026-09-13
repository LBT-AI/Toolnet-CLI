/**
 * — legacy credential compatibility.
 *
 * Before profiles existed, ToolNet stored provider keys through
 * `src/lib/keys.ts` (`keys.json`) and inline provider config. Both must keep
 * working verbatim — this adapter is the ONLY place that reaches into the
 * legacy store, so the compatibility surface is one file instead of being
 * spread across the resolver.
 *
 * It never writes: legacy keys are read, and re-authentication through the new
 * store supersedes them. Existing users are not forced to migrate.
 */

import { getCliKey } from "../../lib/keys";

/** Legacy `keys.json` lookup; returns undefined when absent or unreadable. */
export function resolveApiKeyLegacy(providerId: string): string | undefined {
  if (!providerId.trim()) return undefined;
  try {
    return getCliKey(providerId.trim()) ?? undefined;
  } catch {
    // A corrupt legacy store must not break provider auth.
    return undefined;
  }
}
