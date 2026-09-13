import { spawn } from "node:child_process";

export interface CliRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  hasAltScreen: boolean;
  durationMs: number;
}

export interface CliRunOptions {
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  input?: string;
}

export async function runToolNetCli(options: CliRunOptions = {}): Promise<CliRunResult> {
  const {
    args = [],
    env = {},
    cwd = process.cwd(),
    timeoutMs = 10000,
    input,
  } = options;

  return new Promise<CliRunResult>((resolve, reject) => {
    const startTime = Date.now();
    const child = spawn("bun", ["src/index.tsx", ...args], {
      cwd,
      env: {
        ...process.env,
        ...env,
        NO_COLOR: "1", // clean output by default for assertions unless requested
        CI: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    let timer: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1000).unref();
      }, timeoutMs);
    }

    if (input && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const hasAltScreen = stdout.includes("\x1b[?1049h") || stderr.includes("\x1b[?1049h");
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        hasAltScreen,
        durationMs,
      });
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}
