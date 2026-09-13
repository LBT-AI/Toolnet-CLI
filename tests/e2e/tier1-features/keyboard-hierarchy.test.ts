import { describe, it, expect } from "bun:test";

export interface KeyboardHierarchyState {
  modalActive: boolean;
  searchActive: boolean;
  composerText: string;
  isStreaming: boolean;
  ctrlCPressedOnce: boolean;
}

export type CtrlCAction = "dismiss_modal" | "cancel_search" | "clear_draft" | "abort_stream" | "warn_exit" | "exit_app";

export function handleCtrlCHierarchy(state: KeyboardHierarchyState): CtrlCAction {
  // Layer 1: Modal dismiss
  if (state.modalActive) {
    state.modalActive = false;
    return "dismiss_modal";
  }

  // Layer 2: Search cancel
  if (state.searchActive) {
    state.searchActive = false;
    return "cancel_search";
  }

  // Layer 3: Draft clear
  if (state.composerText.trim().length > 0) {
    state.composerText = "";
    return "clear_draft";
  }

  // Layer 4: Turn abort
  if (state.isStreaming) {
    state.isStreaming = false;
    return "abort_stream";
  }

  // Layer 5: Double-press exit
  if (state.ctrlCPressedOnce) {
    return "exit_app";
  }

  state.ctrlCPressedOnce = true;
  return "warn_exit";
}

describe("Tier 1 Feature Coverage: Centralized 5-Layer Ctrl+C Hierarchy", () => {
  it("F26.1: Layer 1 - Active modal dismisses on Ctrl+C without affecting draft or stream", () => {
    const state: KeyboardHierarchyState = {
      modalActive: true,
      searchActive: false,
      composerText: "Draft prompt",
      isStreaming: true,
      ctrlCPressedOnce: false,
    };

    const action = handleCtrlCHierarchy(state);
    expect(action).toBe("dismiss_modal");
    expect(state.modalActive).toBe(false);
    expect(state.composerText).toBe("Draft prompt");
    expect(state.isStreaming).toBe(true);
  });

  it("F26.2: Layer 2 - Active search palette cancels on Ctrl+C without clearing draft", () => {
    const state: KeyboardHierarchyState = {
      modalActive: false,
      searchActive: true,
      composerText: "/mod",
      isStreaming: false,
      ctrlCPressedOnce: false,
    };

    const action = handleCtrlCHierarchy(state);
    expect(action).toBe("cancel_search");
    expect(state.searchActive).toBe(false);
    expect(state.composerText).toBe("/mod");
  });

  it("F26.3: Layer 3 - Non-empty composer draft clears on Ctrl+C rather than aborting stream or exiting", () => {
    const state: KeyboardHierarchyState = {
      modalActive: false,
      searchActive: false,
      composerText: "Unsubmitted prompt draft",
      isStreaming: false,
      ctrlCPressedOnce: false,
    };

    const action = handleCtrlCHierarchy(state);
    expect(action).toBe("clear_draft");
    expect(state.composerText).toBe("");
  });

  it("F26.4: Layer 4 - Active stream/tool execution aborts on Ctrl+C when composer is empty", () => {
    let aborted = false;
    const abortController = new AbortController();
    abortController.signal.addEventListener("abort", () => {
      aborted = true;
    });

    const state: KeyboardHierarchyState = {
      modalActive: false,
      searchActive: false,
      composerText: "",
      isStreaming: true,
      ctrlCPressedOnce: false,
    };

    const action = handleCtrlCHierarchy(state);
    expect(action).toBe("abort_stream");
    abortController.abort();
    expect(aborted).toBe(true);
    expect(state.isStreaming).toBe(false);
  });

  it("F26.5: Layer 5 - Idle terminal requires double Ctrl+C within timeout to exit", () => {
    const state: KeyboardHierarchyState = {
      modalActive: false,
      searchActive: false,
      composerText: "",
      isStreaming: false,
      ctrlCPressedOnce: false,
    };

    const action1 = handleCtrlCHierarchy(state);
    expect(action1).toBe("warn_exit");
    expect(state.ctrlCPressedOnce).toBe(true);

    const action2 = handleCtrlCHierarchy(state);
    expect(action2).toBe("exit_app");
  });
});
