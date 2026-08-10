import {
  listAllSessions,
  loadSession,
  saveSession,
  deleteSessionFile,
  renameSessionFile,
  createNewSession,
  getLastSessionId,
  SavedSession,
} from "./sessionPersistence";

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

export function getSessionCount(): number {
  return listAllSessions().length;
}
