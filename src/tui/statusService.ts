import { tuiState, SPINNER } from "./state";

/**
 * Maps a tool name and optional arguments to an intuitive realtime status label (like Agy CLI).
 */
export function mapToolToAction(toolName: string, args?: any): string {
  const name = (toolName || "").toLowerCase().trim();

  // Guard 1: Empty / unknown tool
  if (!name) return "Working…";

  // Guard 2: File reading / inspection
  if (
    name === "read_file" ||
    name === "read" ||
    name === "cat" ||
    name === "view_file" ||
    name === "get_file" ||
    name === "file_exists" ||
    name === "read_url_content"
  ) {
    return "Reading file…";
  }

  // Guard 3: File writing / creation
  if (
    name === "write_file" ||
    name === "create_file" ||
    name === "save_file" ||
    name === "write" ||
    name === "save_plan"
  ) {
    return "Writing file…";
  }

  // Guard 4: File editing / patching
  if (
    name === "edit" ||
    name === "patch" ||
    name === "replace_file_content" ||
    name === "edit_file" ||
    name === "apply_diff" ||
    name === "modify"
  ) {
    return "Editing file…";
  }

  // Guard 5: Testing
  if (
    name === "test" ||
    name === "run_test" ||
    name === "test_runner" ||
    name === "jest" ||
    name === "bun_test" ||
    name === "pytest"
  ) {
    return "Testing…";
  }

  // Guard 6: Building / compiling
  if (
    name === "build" ||
    name === "compile" ||
    name === "bundle" ||
    name === "webpack" ||
    name === "vite" ||
    name === "tsc"
  ) {
    return "Building…";
  }

  // Guard 7: Searching / exploration
  if (
    name === "search" ||
    name === "grep" ||
    name === "grep_search" ||
    name === "glob" ||
    name === "glob_search" ||
    name === "find_by_name" ||
    name === "find_path" ||
    name === "list_dir" ||
    name === "tree" ||
    name === "search_web"
  ) {
    return "Searching…";
  }

  // Guard 8: Terminal / bash execution
  if (
    name === "bash" ||
    name === "exec" ||
    name === "run_command" ||
    name === "shell" ||
    name === "terminal" ||
    name === "sh" ||
    name === "cmd"
  ) {
    const cmd = String(args?.command || args?.cmd || args?.CommandLine || "").toLowerCase().trim();
    if (cmd.includes("test") || cmd.startsWith("jest") || cmd.startsWith("pytest")) {
      return "Testing…";
    }
    if (cmd.includes("build") || cmd.startsWith("cargo build") || cmd.startsWith("make") || cmd.startsWith("tsc")) {
      return "Building…";
    }
    if (cmd.startsWith("grep") || cmd.startsWith("rg") || cmd.startsWith("find") || cmd.startsWith("fd")) {
      return "Searching…";
    }
    return "Running command…";
  }

  // Guard 9: Generation / LLM response
  if (
    name === "generation" ||
    name === "model response" ||
    name === "stream" ||
    name === "calling api" ||
    name === "thinking" ||
    name === "llm"
  ) {
    return "Generating…";
  }

  // Default fallback
  return "Working…";
}

/**
 * Realtime Status & Activity Manager for ToolNet CLI.
 * Controls the live spinner, status transitions, and timing without leaking resources.
 */
export class StatusManager {
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalMs = 90;

  /**
   * Starts a new activity session with an animated spinner.
   */
  public start(initialStatus = "Working…"): void {
    this.stopTimer();
    this.clearReadyTimer();

    tuiState.isStreaming = true;
    tuiState.startTime = Date.now();
    tuiState.statusText = initialStatus;
    tuiState.spinnerIdx = 0;
    tuiState.elapsedDisplay = "0.0s";

    tuiState.spinnerTimer = setInterval(() => {
      if (!tuiState.isStreaming) {
        this.stopTimer();
        return;
      }
      tuiState.spinnerIdx = (tuiState.spinnerIdx + 1) % SPINNER.length;
      const elapsed = ((Date.now() - tuiState.startTime) / 1000).toFixed(1);
      tuiState.elapsedDisplay = `${elapsed}s`;
      tuiState.requestRender();
    }, this.intervalMs);

    tuiState.requestRender();
  }

  /**
   * Updates current activity status label immediately.
   */
  public update(status: string): void {
    tuiState.statusText = status;
    if (!tuiState.isStreaming) {
      this.start(status);
      return;
    }
    tuiState.requestRender();
  }

  /**
   * Updates activity according to an active tool execution.
   */
  public updateTool(toolName: string, args?: any): void {
    const label = mapToolToAction(toolName, args);
    this.update(label);
  }

  /**
   * Completes the current activity successfully.
   */
  public done(customMsg?: string): void {
    this.stopTimer();
    tuiState.isStreaming = false;

    const elapsed = ((Date.now() - (tuiState.startTime || Date.now())) / 1000).toFixed(1);
    tuiState.statusText = customMsg || `✔ Done in ${elapsed}s`;
    tuiState.elapsedDisplay = "";
    tuiState.requestRender();

    // Auto-transition to idle/ready after delay
    this.clearReadyTimer();
    this.readyTimer = setTimeout(() => {
      if (!tuiState.isStreaming && (tuiState.statusText.startsWith("✔") || tuiState.statusText.startsWith("✓"))) {
        tuiState.statusText = "";
        tuiState.requestRender();
      }
    }, 3000);
  }

  /**
   * Marks the activity as failed with an error message.
   */
  public failed(errorMsg?: string): void {
    this.stopTimer();
    this.clearReadyTimer();

    tuiState.isStreaming = false;
    tuiState.statusText = errorMsg ? `✖ Error: ${errorMsg}` : "✖ Failed";
    tuiState.elapsedDisplay = "";
    tuiState.requestRender();
  }

  /**
   * Cancels the active task.
   */
  public cancel(): void {
    this.stopTimer();
    this.clearReadyTimer();

    tuiState.isStreaming = false;
    tuiState.statusText = "Cancelled";
    tuiState.elapsedDisplay = "";
    tuiState.requestRender();
  }

  /**
   * Cleans up all timers and stops activity cleanly.
   */
  public stop(): void {
    this.stopTimer();
    this.clearReadyTimer();
    tuiState.isStreaming = false;
  }

  /**
   * Checks if an activity is actively streaming / running.
   */
  public isRunning(): boolean {
    return Boolean(tuiState.isStreaming);
  }

  public getTimer(): ReturnType<typeof setInterval> | null {
    return tuiState.spinnerTimer;
  }

  public getReadyTimer(): ReturnType<typeof setTimeout> | null {
    return this.readyTimer;
  }

  private stopTimer(): void {
    if (tuiState.spinnerTimer) {
      clearInterval(tuiState.spinnerTimer);
      tuiState.spinnerTimer = null;
    }
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }
}

export const statusManager = new StatusManager();
