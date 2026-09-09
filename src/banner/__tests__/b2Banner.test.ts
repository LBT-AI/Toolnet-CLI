import { describe, it, expect } from "bun:test";
import { playB2Banner, renderB2Banner, B2_TIMELINE } from "../b2Banner";
import { stripAnsi, visibleWidth } from "../../tui/layout";

function capture(cols = 80, rows = 24) {
  let output = "";
  return {
    ctx: { cols, rows, write: (value: string) => { output += value; } },
    output: () => output,
  };
}

describe("B2 Twin Portal elapsed-time banner", () => {
  it("renders the disabled path once with no cursor control or timer", async () => {
    const captured = capture(80, 24);
    await playB2Banner(captured.ctx, { animate: false, inPlace: false, noColor: true });
    const output = captured.output();
    expect(output).not.toContain("\x1b[?25l");
    expect(output).not.toContain("\x1b[?25h");
    expect(output).toContain("\n");
    expect(stripAnsi(output)).toContain("◇");
  });

  it("animates through elapsed time and restores the cursor exactly once", async () => {
    const captured = capture(80, 24);
    await playB2Banner(captured.ctx, { animate: true, inPlace: true, noColor: true, frameMs: 100 });
    const output = captured.output();
    expect(output.startsWith("\x1b[?25l")).toBe(true);
    expect(output.endsWith("\x1b[?25h\x1b[16;1H")).toBe(true);
    expect((output.match(/\x1b\[\?25l/g) ?? []).length).toBe(1);
    expect((output.match(/\x1b\[\?25h/g) ?? []).length).toBe(1);
    expect(output).not.toContain("\x1b[J");
    expect(output).not.toContain("\n");
    expect(output).toContain("AI CODING CLI");
  }, 3000);

  it("cleans up the interval and restores the cursor when aborted", async () => {
    const captured = capture(80, 24);
    const controller = new AbortController();
    const promise = playB2Banner(captured.ctx, {
      animate: true,
      inPlace: true,
      signal: controller.signal,
      frameMs: 20,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toThrow("Banner animation aborted");
    const output = captured.output();
    expect(output).toContain("\x1b[?25h");
    expect((output.match(/\x1b\[\?25l/g) ?? []).length).toBe(1);
  }, 1000);

  it("recomputes the pose when terminal size changes during animation", async () => {
    const captured = capture(80, 24);
    let size = { cols: 80, rows: 24 };
    await playB2Banner({ ...captured.ctx, getSize: () => size }, {
      animate: true,
      noColor: true,
      inPlace: true,
      frameMs: 100,
      now: (() => {
        let elapsed = 0;
        return () => {
          elapsed += 100;
          if (elapsed >= 500) size = { cols: 50, rows: 20 };
          return elapsed;
        };
      })(),
    });
    const output = captured.output();
    expect(output).toContain("AI CLI");
    expect(output).toContain("◇");
    expect(output).not.toContain("\n");
    expect(renderB2Banner(50, B2_TIMELINE.final, true).every((line) => visibleWidth(line) <= 50)).toBe(true);
  }, 3000);
});
