import {
  listAllSessions,
  listSessionSummaries,
  loadSession,
  saveSession,
  deleteSessionFile,
  renameSessionFile,
  createNewSession,
  getLastSessionId,
  sessionStore,
  SavedSession,
} from "./sessionPersistence";
import { normalizeWorkspaceIdentity, type ResumedSession, type SessionIndexEntry } from "../core/session";
import { setSessionAuthBridge } from "../core/auth/context";

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatSession {
  id: string;
  name: string;
  messages: Message[];
  model: string;
  agentMode: "build" | "plan";
  createdAt: number;
}

let activeSessionId = getLastSessionId() || `sess_${Date.now()}`;
let _onChange: (() => void) | null = null;

export function onSessionsChange(fn: () => void) {
  _onChange = fn;
}

function notify() {
  if (_onChange) _onChange();
}

function toChatSession(s: SavedSession): ChatSession {
  return {
    id: s.sessionId,
    name: s.metadata?.name || s.sessionId,
    messages: (s.messages || []).map(m => ({ role: m.role as any, content: m.content || "" })),
    model: s.metadata?.model || "default",
    agentMode: (s.metadata?.agentMode?.toLowerCase() === "plan" ? "plan" : "build"),
    createdAt: new Date(s.updatedAt).getTime() || Date.now(),
  };
}

export function initSessions(): void {
  const last = getLastSessionId();
  if (last) activeSessionId = last;
  notify();
}

export function getSessions(): ChatSession[] {
  return listAllSessions().map(toChatSession);
}

export function getCurrentSession(): ChatSession {
  const loaded = loadSession(activeSessionId);
  if (loaded) return toChatSession(loaded);
  const newS = createNewSession();
  activeSessionId = newS.sessionId;
  return toChatSession(newS);
}

export function getCurrentIndex(): number {
  const list = listAllSessions();
  const idx = list.findIndex(s => s.sessionId === activeSessionId);
  return idx >= 0 ? idx : 0;
}

export function switchSession(index: number): boolean {
  const list = listAllSessions();
  if (index < 0 || index >= list.length) return false;
  activeSessionId = list[index].sessionId;
  const loaded = loadSession(activeSessionId);
  if (loaded) {
    saveSession(loaded.sessionId, loaded.messages, loaded.metadata);
  }
  notify();
  return true;
}

export function switchSessionById(id: string): boolean {
  const loaded = loadSession(id);
  if (!loaded) return false;
  activeSessionId = loaded.sessionId;
  saveSession(loaded.sessionId, loaded.messages, loaded.metadata);
  notify();
  return true;
}

export function newSession(name?: string): ChatSession {
  const created = createNewSession(name);
  activeSessionId = created.sessionId;
  notify();
  return toChatSession(created);
}

export function removeSession(index: number): boolean {
  const list = listAllSessions();
  if (index < 0 || index >= list.length) return false;
  const targetId = list[index].sessionId;
  const ok = deleteSessionFile(targetId);
  if (ok) {
    if (targetId === activeSessionId) {
      const remaining = listAllSessions();
      if (remaining.length > 0) activeSessionId = remaining[0].sessionId;
      else activeSessionId = createNewSession().sessionId;
    }
    notify();
  }
  return ok;
}

export function renameSession(index: number, name: string): boolean {
  const list = listAllSessions();
  if (index < 0 || index >= list.length) return false;
  const ok = renameSessionFile(list[index].sessionId, name);
  if (ok) notify();
  return ok;
}

export function addMessage(role: "user" | "assistant" | "system", content: string): void {
  const curr = loadSession(activeSessionId) || loadSession(createNewSession().sessionId);
  if (curr) {
    curr.messages.push({ role, content });
    saveSession(curr.sessionId, curr.messages, curr.metadata);
    notify();
  }
}

export function setModel(model: string): void {
  const curr = loadSession(activeSessionId);
  if (curr) {
    curr.metadata = curr.metadata || {};
    curr.metadata.model = model;
    saveSession(curr.sessionId, curr.messages, curr.metadata);
    notify();
  }
}

export function setAgentMode(mode: "build" | "plan"): void {
  const curr = loadSession(activeSessionId);
  if (curr) {
    curr.metadata = curr.metadata || {};
    curr.metadata.agentMode = mode;
    saveSession(curr.sessionId, curr.messages, curr.metadata);
    notify();
  }
}

export function toggleAgentMode(): void {
  const curr = loadSession(activeSessionId);
  if (curr) {
    curr.metadata = curr.metadata || {};
    const mode = curr.metadata.agentMode === "plan" ? "build" : "plan";
    curr.metadata.agentMode = mode;
    saveSession(curr.sessionId, curr.messages, curr.metadata);
    notify();
  }
}

/**
 * — session auth pinning.
 *
 * A session records ONLY ids (`providerId -> authProfileId`) in its metadata.
 * Secrets never touch session state: the credential is resolved from the store
 * at call time, so a session cannot replay a key that was since rotated.
 *
 * Pinning also means a later global `toolnet auth use` cannot silently change
 * the account a running session spends from — the session keeps its identity
 * until the user pins another profile into it.
 */
export function getSessionAuthProfiles(): Record<string, string> {
  const curr = loadSession(activeSessionId);
  const pinned = curr?.metadata?.authProfiles;
  if (!pinned || typeof pinned !== "object" || Array.isArray(pinned)) return {};
  const out: Record<string, string> = {};
  for (const [providerId, profileId] of Object.entries(pinned as Record<string, unknown>)) {
    if (typeof providerId === "string" && typeof profileId === "string") out[providerId] = profileId;
  }
  return out;
}

/** The profile id a session currently pins for a provider, if any. */
export function getSessionAuthProfile(providerId: string): string | null {
  const provider = providerId.trim().toLowerCase();
  return getSessionAuthProfiles()[provider] ?? null;
}

/** Pin (or clear, by passing null) the auth profile a session spends from. */
export function setSessionAuthProfile(providerId: string, profileId: string | null): void {
  const provider = providerId.trim().toLowerCase();
  const curr = loadSession(activeSessionId);
  if (!curr) return;
  curr.metadata = curr.metadata || {};
  const pinned: Record<string, string> = { ...(curr.metadata.authProfiles || {}) };
  if (profileId) pinned[provider] = profileId;
  else delete pinned[provider];
  curr.metadata.authProfiles = pinned;
  saveSession(curr.sessionId, curr.messages, curr.metadata);
  notify();
}

export function getSessionCount(): number {
  return listAllSessions().length;
}

/** Cheap index metadata for pickers and status views (no transcript load). */
export function getSessionSummaries(): SessionIndexEntry[] {
  return listSessionSummaries();
}

/**
 * Reconstruct a session for continuation. Replay is state-only, so a caller
 * gets the transcript, evidence and identities without any tool being re-run.
 */
export function resumeSession(sessionId: string): ResumedSession {
  return sessionStore.resume(sessionId);
}

/** Most recent session belonging to the current workspace, if any. */
export function getLatestSessionForWorkspace(): SessionIndexEntry | null {
  return sessionStore.continueForWorkspace(normalizeWorkspaceIdentity(process.cwd()));
}

// — expose session pinning to the auth layer without importing it at
// module scope from core/auth (the lazy `require` lives on the other side).
setSessionAuthBridge({
  load: getSessionAuthProfiles,
  pin: (providerId, profileId) => setSessionAuthProfile(providerId, profileId),
});
