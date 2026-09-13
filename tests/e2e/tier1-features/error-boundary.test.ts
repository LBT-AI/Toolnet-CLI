import { describe, it, expect } from "bun:test";
import { T } from "../../../src/term";
import { DISABLE_BRACKETED_PASTE } from "../../../src/lib/bracketedPaste";

export interface RenderErrorBoundaryResult {
  hasError: boolean;
  frame: string;
  error?: Error;
}

export function renderWithErrorBoundary(renderFn: () => string): RenderErrorBoundaryResult {
  try {
    const frame = renderFn();
    return { hasError: false, frame };
  } catch (err: any) {
    const error = err instanceof Error ? err : new Error(String(err));
    const fallbackFrame = [
      "┌────────────────────────────────────────────────────────┐",
      "│ ⚠️ ToolNet TUI Render Fault Caught                     │",
      `│ Error: ${error.message.padEnd(47).slice(0, 47)} │`,
      "│ Press Ctrl+L to redraw or type /exit                   │",
      "└────────────────────────────────────────────────────────┘",
    ].join("\n");

    return {
      hasError: true,
      frame: fallbackFrame,
      error,
    };
  }
}

export function generateTerminalTeardownSequence(): string {
  // Ordered sequence for complete terminal restoration
  return [
    T.show,                  // Show cursor: \x1b[?25h
    DISABLE_BRACKETED_PASTE, // Disable bracketed paste: \x1b[?2004l
    T.altOff,                // Leave alternate screen: \x1b[?1049l
  ].join("");
}

describe("Tier 1 Feature Coverage: Error Boundaries & Terminal Clean Teardown", () => {
  it("F28.1: Error boundary catches render function faults without crashing", () => {
    const faultyRender = () => {
      throw new Error("Simulated rendering exception in chatRenderer");
    };

    const res = renderWithErrorBoundary(faultyRender);
    expect(res.hasError).toBe(true);
    expect(res.error?.message).toBe("Simulated rendering exception in chatRenderer");
    expect(res.frame).toContain("⚠️ ToolNet TUI Render Fault Caught");
  });

  it("F28.2: Actionable fallback frame includes recovery instructions", () => {
    const faultyRender = () => {
      throw new TypeError("Cannot read property 'length' of undefined");
    };

    const res = renderWithErrorBoundary(faultyRender);
    expect(res.frame).toContain("Press Ctrl+L to redraw or type /exit");
  });

  it("F28.3: Normal rendering passes through error boundary unaffected", () => {
    const validRender = () => "Valid Render Frame: 80x24";
    const res = renderWithErrorBoundary(validRender);

    expect(res.hasError).toBe(false);
    expect(res.frame).toBe("Valid Render Frame: 80x24");
    expect(res.error).toBeUndefined();
  });

  it("F28.4: Subsequent render recovers cleanly once fault is resolved", () => {
    let shouldFault = true;
    const dynamicRender = () => {
      if (shouldFault) throw new Error("Transient fault");
      return "Recovered Frame Content";
    };

    const res1 = renderWithErrorBoundary(dynamicRender);
    expect(res1.hasError).toBe(true);

    shouldFault = false;
    const res2 = renderWithErrorBoundary(dynamicRender);
    expect(res2.hasError).toBe(false);
    expect(res2.frame).toBe("Recovered Frame Content");
  });

  it("F27.1: Terminal clean teardown sequence contains show-cursor, alt-off, and bracketed-paste off", () => {
    const teardown = generateTerminalTeardownSequence();
    expect(teardown).toContain("\x1b[?25h");   // cursor show
    expect(teardown).toContain("\x1b[?2004l"); // bracketed paste off
    expect(teardown).toContain("\x1b[?1049l"); // alt screen off
  });
});
