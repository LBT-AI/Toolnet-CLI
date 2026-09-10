export type AgentState =
  | "idle"
  | "thinking"
  | "awaiting-permission"
  | "executing-tool"
  | "verifying"
  | "responding"
  | "cancelled"
  | "error";

export interface AgentStateTransition {
  from: AgentState;
  to: AgentState;
  at: number;
  reason?: string;
}

const ALLOWED: Record<AgentState, AgentState[]> = {
  idle: ["thinking"],
  thinking: ["executing-tool", "awaiting-permission", "responding", "cancelled", "error"],
  "awaiting-permission": ["executing-tool", "thinking", "cancelled", "error"],
  "executing-tool": ["verifying", "awaiting-permission", "thinking", "cancelled", "error"],
  verifying: ["thinking", "responding", "cancelled", "error"],
  responding: ["idle", "thinking", "cancelled", "error"],
  cancelled: ["idle"],
  error: ["idle", "thinking"],
};

export function isValidTransition(from: AgentState, to: AgentState): boolean {
  if (from === to) return true;
  const next = ALLOWED[from];
  return Boolean(next && next.includes(to));
}

export class AgentStateMachine {
  private _state: AgentState = "idle";
  private history: AgentStateTransition[] = [];
  private listeners: Set<(s: AgentState, prev: AgentState) => void> = new Set();

  get state(): AgentState {
    return this._state;
  }

  onTransition(listener: (s: AgentState, prev: AgentState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  transition(to: AgentState, reason?: string): void {
    const from = this._state;
    if (!isValidTransition(from, to)) {
      const msg = `Illegal AgentState transition: ${from} → ${to}${reason ? ` (${reason})` : ""}`;
      if (process.env.NODE_ENV === "test") {
        throw new Error(msg);
      }
      // eslint-disable-next-line no-console
      console.warn(`[AgentState] ${msg}`);
    }
    this._state = to;
    this.history.push({ from, to, at: Date.now(), reason });
    for (const l of this.listeners) {
      try {
        l(to, from);
      } catch {}
    }
  }

  reset(): void {
    const from = this._state;
    this._state = "idle";
    this.history.push({ from, to: "idle", at: Date.now(), reason: "reset" });
    for (const l of this.listeners) {
      try {
        l("idle", from);
      } catch {}
    }
  }

  getHistory(): AgentStateTransition[] {
    return [...this.history];
  }

  isTerminal(): boolean {
    return this._state === "cancelled" || this._state === "error";
  }

  isBusy(): boolean {
    return this._state !== "idle" && this._state !== "cancelled" && this._state !== "error";
  }
}
