/**
 * Background session titling.
 *
 * Wire-up rule: this is fire-and-forget. The main agent starts working
 * immediately and never waits for a title; when the title lands, it is written
 * through the canonical SessionStore (so the record AND `.index.json` move
 * together) and the caller is notified so the UI can repaint in place.
 *
 * There is deliberately no new scheduler or persistence path: the durable
 * `title` field on the session record is the one home for it, and
 * `setAutoTitle` refuses to overwrite a human rename that raced with us.
 */

import { sessionStore } from "../core/session";
import { buildDeterministicTitle, isSubstantiveTask, sanitizeGeneratedTitle } from "./sessionTitle";

export const AUTO_TITLE_SOURCE = "auto" as const;

/** The slice of SessionStore this service needs; injectable for tests. */
export interface AutoTitleStore {
  load(sessionId: string): { title?: string; metadata?: Record<string, unknown> } | null;
  setAutoTitle(sessionId: string, title: string, options?: { revision?: number }): unknown;
}

/** Model-backed refinement. Returning null falls back to the deterministic title. */
export type TitleGenerator = (prompt: string) => Promise<string | null>;

export interface AutoTitleRequest {
  sessionId: string;
  /** The user message that triggered the request. */
  prompt: string;
  /** Optional model call; without it the deterministic title is used. */
  generate?: TitleGenerator;
  /** Called only after the title is durable in the store. */
  onTitle?: (title: string, sessionId: string) => void;
  store?: AutoTitleStore;
  revision?: number;
}

/**
 * Sessions already asked for a title in this process. A session is titled once
 * from its first substantive task; later turns never regenerate it.
 */
const attempts = new Map<string, number>();

export function hasRequestedAutoTitle(sessionId: string): boolean {
  return attempts.has(sessionId);
}

/** Test/teardown hook: forget which sessions were already asked. */
export function resetAutoTitleState(): void {
  attempts.clear();
}

/**
 * Queue the title for a session. Resolves once the attempt has settled — the
 * returned promise exists for tests and diagnostics; production callers must
 * NOT await it (that would block the agent on a model round-trip).
 */
export async function requestAutoTitle(request: AutoTitleRequest): Promise<void> {
  const { sessionId, prompt } = request;
  if (!sessionId) return;
  // Greetings, acks and "tiếp tục" are not tasks: they never title a session.
  if (!isSubstantiveTask(prompt)) return;
  if (attempts.has(sessionId)) return;
  attempts.set(sessionId, 1);

  const store = (request.store ?? (sessionStore as unknown as AutoTitleStore));

  try {
    const record = store.load(sessionId);
    // The session may have been deleted (or never existed) — an auto title is
    // only ever written to a session that is still there.
    if (!record) return;
    // Already titled, by a human or by an earlier run: never regenerate.
    if (record.title) return;
  } catch {
    return;
  }

  let title: string | null = null;
  if (request.generate) {
    try {
      title = sanitizeGeneratedTitle(await request.generate(prompt));
    } catch {
      title = null; // a model failure must still leave a usable title
    }
  }
  if (!title) title = buildDeterministicTitle(prompt);
  if (!title) return;

  try {
    const revision = request.revision ?? attempts.get(sessionId) ?? 1;
    const updated = store.setAutoTitle(sessionId, title, { revision });
    if (!updated) return; // manual rename won, or a newer title already landed
    request.onTitle?.(title, sessionId);
  } catch {
    // Titling is best-effort. It must never surface as a session failure.
  }
}
