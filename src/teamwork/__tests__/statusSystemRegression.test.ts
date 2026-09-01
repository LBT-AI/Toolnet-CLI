import { test, it, expect, describe, beforeEach, afterEach } from "bun:test";
import { tuiState, SPINNER } from "../../tui/state";
import { mapToolToAction, statusManager, StatusManager } from "../../tui/statusService";
import { renderWorkingStatus } from "../../tui/renderers/statusRenderer";
import { stripAnsi } from "../../tui/layout";

describe("Realtime Task Status System (Agy CLI style)", () => {
  beforeEach(() => {
    statusManager.stop();
    tuiState.statusText = "";
    tuiState.isStreaming = false;
    tuiState.spinnerIdx = 0;
    tuiState.elapsedDisplay = "";
    tuiState.showHelp = false;
  });

  afterEach(() => {
    statusManager.stop();
  });

  describe("1. Tool & Action to Status Label Mapping", () => {
    it("maps read tools to 'Reading file…'", () => {
      expect(mapToolToAction("read_file")).toBe("Reading file…");
      expect(mapToolToAction("read")).toBe("Reading file…");
      expect(mapToolToAction("cat")).toBe("Reading file…");
      expect(mapToolToAction("view_file")).toBe("Reading file…");
      expect(mapToolToAction("get_file")).toBe("Reading file…");
      expect(mapToolToAction("file_exists")).toBe("Reading file…");
      expect(mapToolToAction("read_url_content")).toBe("Reading file…");
    });

    it("maps write tools to 'Writing file…'", () => {
      expect(mapToolToAction("write_file")).toBe("Writing file…");
      expect(mapToolToAction("create_file")).toBe("Writing file…");
      expect(mapToolToAction("save_file")).toBe("Writing file…");
      expect(mapToolToAction("write")).toBe("Writing file…");
      expect(mapToolToAction("save_plan")).toBe("Writing file…");
    });

    it("maps edit tools to 'Editing file…'", () => {
      expect(mapToolToAction("edit")).toBe("Editing file…");
      expect(mapToolToAction("patch")).toBe("Editing file…");
      expect(mapToolToAction("replace_file_content")).toBe("Editing file…");
      expect(mapToolToAction("edit_file")).toBe("Editing file…");
      expect(mapToolToAction("apply_diff")).toBe("Editing file…");
      expect(mapToolToAction("modify")).toBe("Editing file…");
    });

    it("maps search tools to 'Searching…'", () => {
      expect(mapToolToAction("search")).toBe("Searching…");
      expect(mapToolToAction("grep")).toBe("Searching…");
      expect(mapToolToAction("grep_search")).toBe("Searching…");
      expect(mapToolToAction("glob")).toBe("Searching…");
      expect(mapToolToAction("glob_search")).toBe("Searching…");
      expect(mapToolToAction("find_by_name")).toBe("Searching…");
      expect(mapToolToAction("find_path")).toBe("Searching…");
      expect(mapToolToAction("list_dir")).toBe("Searching…");
      expect(mapToolToAction("tree")).toBe("Searching…");
      expect(mapToolToAction("search_web")).toBe("Searching…");
    });

    it("maps test and build tools appropriately", () => {
      expect(mapToolToAction("test")).toBe("Testing…");
      expect(mapToolToAction("run_test")).toBe("Testing…");
      expect(mapToolToAction("bun_test")).toBe("Testing…");
      expect(mapToolToAction("pytest")).toBe("Testing…");

      expect(mapToolToAction("build")).toBe("Building…");
      expect(mapToolToAction("compile")).toBe("Building…");
      expect(mapToolToAction("bundle")).toBe("Building…");
      expect(mapToolToAction("webpack")).toBe("Building…");
      expect(mapToolToAction("vite")).toBe("Building…");
    });

    it("maps bash/exec commands based on command content", () => {
      expect(mapToolToAction("bash", { command: "bun test" })).toBe("Testing…");
      expect(mapToolToAction("exec", { command: "npm test" })).toBe("Testing…");
      expect(mapToolToAction("run_command", { CommandLine: "pytest tests/" })).toBe("Testing…");

      expect(mapToolToAction("bash", { command: "bun run build" })).toBe("Building…");
      expect(mapToolToAction("exec", { cmd: "cargo build --release" })).toBe("Building…");

      expect(mapToolToAction("bash", { command: "grep -rn 'foo' src/" })).toBe("Searching…");
      expect(mapToolToAction("run_command", { command: "rg 'bar'" })).toBe("Searching…");

      expect(mapToolToAction("bash", { command: "ls -la" })).toBe("Running command…");
      expect(mapToolToAction("exec")).toBe("Running command…");
    });

    it("maps generation and fallback tools", () => {
      expect(mapToolToAction("generation")).toBe("Generating…");
      expect(mapToolToAction("model response")).toBe("Generating…");
      expect(mapToolToAction("stream")).toBe("Generating…");
      expect(mapToolToAction("thinking")).toBe("Generating…");
      expect(mapToolToAction("calling api")).toBe("Generating…");

      expect(mapToolToAction("unknown_custom_tool")).toBe("Working…");
      expect(mapToolToAction("")).toBe("Working…");
    });
  });

  describe("2. Status Transitions & Lifecycle Management", () => {
    it("starts activity with spinner and updates status in-place", () => {
      expect(statusManager.isRunning()).toBe(false);
      expect(statusManager.getTimer()).toBeNull();

      statusManager.start("Reading file…");
      expect(statusManager.isRunning()).toBe(true);
      expect(tuiState.isStreaming).toBe(true);
      expect(tuiState.statusText).toBe("Reading file…");
      expect(statusManager.getTimer()).not.toBeNull();

      // Update to next action
      statusManager.update("Running command…");
      expect(tuiState.statusText).toBe("Running command…");
      expect(statusManager.isRunning()).toBe(true);

      // Update via tool mapping
      statusManager.updateTool("replace_file_content");
      expect(tuiState.statusText).toBe("Editing file…");
    });

    it("completes activity with success message and cleans up timer", () => {
      statusManager.start("Running command…");
      expect(statusManager.getTimer()).not.toBeNull();

      statusManager.done();
      expect(statusManager.isRunning()).toBe(false);
      expect(statusManager.getTimer()).toBeNull();
      expect(tuiState.statusText).toContain("✔ Done");
    });

    it("handles failure with error message and cleans up timer", () => {
      statusManager.start("Building…");
      expect(statusManager.getTimer()).not.toBeNull();

      statusManager.failed("Compilation failed on line 42");
      expect(statusManager.isRunning()).toBe(false);
      expect(statusManager.getTimer()).toBeNull();
      expect(tuiState.statusText).toContain("✖ Error: Compilation failed on line 42");
    });

    it("handles cancellation (Ctrl+C / Esc) and cleans up timer", () => {
      statusManager.start("Generating…");
      expect(statusManager.getTimer()).not.toBeNull();

      statusManager.cancel();
      expect(statusManager.isRunning()).toBe(false);
      expect(statusManager.getTimer()).toBeNull();
      expect(tuiState.statusText).toBe("Cancelled");
    });

    it("ensures no lingering timer after multiple start/stop cycles", () => {
      for (let i = 0; i < 5; i++) {
        statusManager.start(`Task ${i}`);
        expect(statusManager.getTimer()).not.toBeNull();
        statusManager.done();
        expect(statusManager.getTimer()).toBeNull();
      }
      expect(statusManager.isRunning()).toBe(false);
    });
  });

  describe("3. In-Place Rendering & Terminal Output Integrity", () => {
    it("renders active running spinner and status text on a single line", () => {
      tuiState.isStreaming = true;
      tuiState.statusText = "Running command…";
      tuiState.spinnerIdx = 2;
      tuiState.elapsedDisplay = "1.4s";

      const output = renderWorkingStatus(80, {
        showHelp: false,
        isStreaming: true,
        spinnerIdx: 2,
        statusText: "Running command…",
        elapsedDisplay: "1.4s",
        primaryColor: "\x1b[36m",
      });

      const stripped = stripAnsi(output);
      // Divider + 1 single status line
      const lines = stripped.trimEnd().split("\n");
      expect(lines.length).toBe(2);

      const statusLine = lines[1];
      expect(statusLine).toContain(SPINNER[2]);
      expect(statusLine).toContain("Running command…");
      expect(statusLine).toContain("1.4s");
    });

    it("renders success state with green checkmark", () => {
      const output = renderWorkingStatus(80, {
        showHelp: false,
        isStreaming: false,
        spinnerIdx: 0,
        statusText: "✔ Done in 0.8s",
        elapsedDisplay: "",
        primaryColor: "\x1b[36m",
      });

      const stripped = stripAnsi(output);
      expect(stripped).toContain("✔ Done in 0.8s");
    });

    it("renders error state with red cross icon", () => {
      const output = renderWorkingStatus(80, {
        showHelp: false,
        isStreaming: false,
        spinnerIdx: 0,
        statusText: "✖ Error: Network timeout",
        elapsedDisplay: "",
        primaryColor: "\x1b[36m",
      });

      const stripped = stripAnsi(output);
      expect(stripped).toContain("✖ Error: Network timeout");
    });

    it("renders ready state when idle", () => {
      const output = renderWorkingStatus(80, {
        showHelp: false,
        isStreaming: false,
        spinnerIdx: 0,
        statusText: "",
        elapsedDisplay: "",
        primaryColor: "\x1b[36m",
      });

      const stripped = stripAnsi(output);
      expect(stripped).toContain("● Ready");
      expect(stripped).toContain("Enter: send");
    });
  });
});
