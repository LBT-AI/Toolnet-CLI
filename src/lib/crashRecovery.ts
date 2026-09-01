import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface CrashState {
  sessionId: string;
  timestamp: number;
  lastUserGoal: string;
  workingDirectory: string;
  model: string;
  agentMode?: "Build" | "Plan";
  lastSuccessfulToolResult?: {
    tool: string;
    exitCode?: number;
    summary?: string;
  };
  pendingDestructiveActions?: string[];
  cleanExit: boolean;
}

function getRecoveryDir(): string {
  const base = process.env.DATA_DIR || path.join(os.homedir(), ".toolnet");
  return path.join(base, "recovery");
}

function getRecoveryFile(): string {
  return path.join(getRecoveryDir(), "last_session.json");
}

let activeCrashState: CrashState | null = null;

export function initCrashRecovery(sessionId: string, cwd = process.cwd(), model = ""): CrashState {
  activeCrashState = {
    sessionId,
    timestamp: Date.now(),
    lastUserGoal: "",
    workingDirectory: cwd,
    model,
    agentMode: "Build",
    cleanExit: false,
    pendingDestructiveActions: [],
  };
  saveCrashState(activeCrashState);
  return activeCrashState;
}

export function updateCrashGoal(goal: string): void {
  if (activeCrashState) {
    activeCrashState.lastUserGoal = goal;
    activeCrashState.timestamp = Date.now();
    saveCrashState(activeCrashState);
  }
}

export function updateCrashToolResult(tool: string, exitCode = 0, summary?: string): void {
  if (activeCrashState) {
    activeCrashState.lastSuccessfulToolResult = { tool, exitCode, summary };
    activeCrashState.timestamp = Date.now();
    saveCrashState(activeCrashState);
  }
}

export function recordPendingDestructiveAction(action: string): void {
  if (activeCrashState) {
    if (!activeCrashState.pendingDestructiveActions) activeCrashState.pendingDestructiveActions = [];
    activeCrashState.pendingDestructiveActions.push(action);
    activeCrashState.timestamp = Date.now();
    saveCrashState(activeCrashState);
  }
}

export function markCleanExit(): void {
  if (activeCrashState) {
    activeCrashState.cleanExit = true;
    saveCrashState(activeCrashState);
  }
  try {
    const file = getRecoveryFile();
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {}
}

export function saveCrashState(state: CrashState): void {
  try {
    const dir = getRecoveryDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getRecoveryFile(), JSON.stringify(state, null, 2));
  } catch {}
}

export function checkPendingRecovery(): CrashState | null {
  try {
    const file = getRecoveryFile();
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8");
      const state = JSON.parse(raw) as CrashState;
      if (!state.cleanExit && state.sessionId) {
        return state;
      }
    }
  } catch {}
  return null;
}

export function clearPendingRecovery(): void {
  try {
    const file = getRecoveryFile();
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {}
}
