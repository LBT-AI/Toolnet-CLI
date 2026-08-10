import { exec, ChildProcess } from "child_process";
import { workspaceRoot } from "./codingAgent";

export interface BackgroundTask {
  id: string;
  name: string;
  command: string;
  status: "running" | "completed" | "failed";
  output: string;
  process?: ChildProcess;
  startTime: number;
}

export class BackgroundTaskScheduler {
  private tasks: Map<string, BackgroundTask> = new Map();
  private onUpdateCallback?: () => void;

  onUpdate(cb: () => void) {
    this.onUpdateCallback = cb;
  }

  run(name: string, command: string, cwd?: string): string {
    const id = `task_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const task: BackgroundTask = {
      id,
      name,
      command,
      status: "running",
      output: "",
      startTime: Date.now(),
    };
    
    this.tasks.set(id, task);
    this.notifyUpdate();

    const effectiveCwd = cwd || workspaceRoot;
    const proc = exec(command, { cwd: effectiveCwd }, (error, stdout, stderr) => {
      task.status = error ? "failed" : "completed";
      task.output = stdout + "\n" + stderr;
      this.notifyUpdate();
    });

    task.process = proc;
    return id;
  }

  getActiveTasks() {
    return Array.from(this.tasks.values()).filter(t => t.status === "running");
  }

  getAllTasks() {
    return Array.from(this.tasks.values());
  }

  private notifyUpdate() {
    if (this.onUpdateCallback) {
      this.onUpdateCallback();
    }
  }
}

export const backgroundTasks = new BackgroundTaskScheduler();
