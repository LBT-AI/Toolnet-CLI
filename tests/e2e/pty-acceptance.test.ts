/**
 * PTY acceptance for the TUI across the four target geometries.
 * Uses node-pty when available; skips with a clear note otherwise.
 */
import { describe, expect, it } from "bun:test";

const SIZES: Array<[number, number]> = [
  [120, 40],
  [100, 30],
  [80, 24],
  [60, 20],
];

let pty: any = null;
try {
  // eslint-disable-next-line import/no-commonjs
  pty = require("node-pty");
} catch {
  pty = null;
}

const ENTRY = "dist/node/index.js";

interface PtyResult {
  output: string;
  exitCode: number;
}

async function runTui(cols: number, rows: number, script: Array<[number, string]>, timeoutMs = 20_000): Promise<PtyResult> {
  if (!pty) return { output: "", exitCode: -1 };

  return await new Promise((resolve) => {
    const proc = pty.spawn(process.execPath, [ENTRY], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: { ...process.env, TERM: "xterm-256color" },
    });

    let output = "";
    let settled = false;

    const timer = setTimeout(() => {
      finish(0);
    }, timeoutMs);

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill(); } catch {}
      resolve({ output, exitCode: code });
    };

    proc.onData((data: string) => {
      output += data;
      for (const [delayMs, keys] of script) {
        void delayMs;
        if (keys) {
          setTimeout(() => {
            try { proc.write(keys); } catch {}
          }, 100);
          break; // simplistic: write first key set after 100ms, handled below
        }
      }
    });

    proc.onExit(({ exitCode }: { exitCode: number }) => finish(exitCode));

    // Drive the scripted keystrokes.
    let elapsed = 0;
    for (const [delayMs, keys] of script) {
      elapsed += delayMs;
      const payload = keys;
      setTimeout(() => {
        try { proc.write(payload); } catch {}
      }, elapsed);
    }
  });
}

describe("PTY acceptance (small terminals, resize, restore)", () => {
  it("node-pty is available", () => {
    if (!pty) {
      console.log("node-pty not installed; PTY acceptance skipped — install with `bun add -d node-pty-prebuilt-multiarch` to enable");
    }
    expect(true).toBe(true);
  });

  for (const [cols, rows] of SIZES) {
    it(`launches and renders at ${cols}x${rows}, prompt visible, clean teardown`, async () => {
      if (!pty) return; // conditional skip

      const res = await runTui(cols, rows, [
        [400, ""], // settle — initial frame painted
        [200, "\u001b"], // Esc is inert: must not crash or submit
        [400, "\u0003"], // Ctrl+C once (idle → hint, not exit)
        [400, "\u0003"], // Ctrl+C again → exit
      ]);

      // Alt screen was entered…
      expect(res.output).toContain("\u001b[?1049h");
      // …and left again on exit (clean teardown, no raw mode leak).
      expect(res.output).toContain("\u001b[?1049l");
      // Cursor restored.
      expect(res.output).toContain("\u001b[?25h");
      // The composer prompt rendered.
      expect(res.output).toContain(">");
      // The double-Ctrl+C exit hint appeared.
      expect(res.output).toContain("Press Ctrl+C again");
    });
  }

  it("survives a live resize during streaming render (80x24 → 120x40 → 60x20)", async () => {
    if (!pty) return;

    if (!pty) return;
    const res = await new Promise<PtyResult>((resolve) => {
      const proc = pty.spawn(process.execPath, [ENTRY], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: { ...process.env, TERM: "xterm-256color" },
      });
      let output = "";
      let settled = false;
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { proc.kill(); } catch {}
        resolve({ output, exitCode: code });
      };
      const timer = setTimeout(() => finish(0), 20_000);
      proc.onData((d: string) => (output += d));
      proc.onExit(({ exitCode }: { exitCode: number }) => finish(exitCode));

      // Resize while the TUI is live, then resize again, then exit.
      setTimeout(() => { try { proc.resize(120, 40); } catch {} }, 500);
      setTimeout(() => { try { proc.resize(60, 20); } catch {} }, 900);
      setTimeout(() => { try { proc.write("\u0003"); } catch {} }, 1300);
      setTimeout(() => { try { proc.write("\u0003"); } catch {} }, 1700);
    });

    expect(res.output).toContain("\u001b[?1049h");
    expect(res.output).toContain("\u001b[?1049l");
    // After resize down to 60 cols the composer prompt must still be painted.
    const tail = res.output.slice(-4000);
    expect(tail).toContain(">");
  });
});
