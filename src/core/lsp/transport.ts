/**
 * Phase 74 — JSON-RPC transport.
 *
 * The LSP base protocol frames messages with `Content-Length` headers over
 * stdio. We implement the framing directly instead of pulling in a JSON-RPC
 * dependency: the surface we need is small, and the in-memory transport below
 * lets the whole code-intelligence stack be tested deterministically without a
 * language-server binary.
 *
 * Both transports satisfy the same `LspTransport` contract, so `LspClient`
 * cannot tell production from tests.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { LspTransport, SpawnedServer } from "./types";

const HEADER_SEPARATOR = "\r\n\r\n";
const MAX_HEADER_BYTES = 16 * 1024;

/** Frame a JSON-RPC message with its `Content-Length` header. */
export function encodeLspMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}${HEADER_SEPARATOR}`, "ascii"),
    body,
  ]);
}

/**
 * Incremental `Content-Length` frame decoder. Feed it raw stdout chunks; it
 * emits one parsed message per complete frame and buffers partial frames.
 */
export class LspMessageReader {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly onMessage: (message: unknown) => void) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR, 0, "ascii");
      if (headerEnd === -1) {
        // Guard against a server that streams garbage instead of headers.
        if (this.buffer.length > MAX_HEADER_BYTES) this.buffer = Buffer.alloc(0);
        return;
      }

      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
        continue;
      }

      const length = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      if (this.buffer.length < bodyStart + length) return;

      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);

      try {
        this.onMessage(JSON.parse(body));
      } catch {
        // A malformed frame is skipped rather than crashing the agent.
      }
    }
  }
}

/** The pipe trio a spawned language server must expose. */
export interface StdioStreams {
  stdout: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
}

/**
 * Adapt a spawned child process to the transport contract. `close()` ends the
 * child's stdin and kills it so no server outlives the session.
 */
export function createStdioTransport(streams: StdioStreams, child?: ChildProcessWithoutNullStreams): LspTransport {
  const messageHandlers = new Set<(message: unknown) => void>();
  const closeHandlers = new Set<(error?: Error) => void>();
  const reader = new LspMessageReader((message) => {
    for (const handler of messageHandlers) handler(message);
  });

  const emitClose = (error?: Error) => {
    for (const handler of closeHandlers) handler(error);
  };

  streams.stdout.on("data", (chunk: Buffer | string) =>
    reader.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk)
  );

  if (child) {
    child.stderr?.resume?.();
    child.on("error", (error) => emitClose(error instanceof Error ? error : new Error(String(error))));
    child.on("exit", (code, signal) => {
      if (code === 0 && !signal) return emitClose();
      emitClose(new Error(`Language server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    });
  }

  return {
    send(message) {
      try {
        if (!streams.stdin.writable) return;
        streams.stdin.write(encodeLspMessage(message));
      } catch {
        // Writing to a dead pipe must not throw into the agent loop.
      }
    },
    onMessage(handler) {
      messageHandlers.add(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
    },
    close() {
      try {
        streams.stdin.end?.();
      } catch {
        // ignore
      }
      if (child && !child.killed) {
        try {
          child.kill();
        } catch {
          // ignore
        }
      }
    },
  };
}

/**
 * Spawn a language server binary and wrap it. Callers resolve the binary first
 * (see `servers.ts`) so this never guesses a command.
 */
export function spawnStdioServer(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; initialization?: Record<string, unknown> }
): SpawnedServer {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  return {
    transport: createStdioTransport({ stdin: child.stdin, stdout: child.stdout }, child),
    initialization: options.initialization,
    processId: child.pid,
  };
}

/** Two paired endpoints; a message sent on one is delivered to the other. */
export interface MemoryTransportPair {
  client: LspTransport;
  server: LspTransport;
}

export interface MemoryTransportOptions {
  /** When true, a `send` does not enqueue delivery (simulates a dead peer). */
  silent?: boolean;
  /** Invoked for every message a side receives; useful for assertions. */
  onSend?: (side: "client" | "server", message: unknown) => void;
}

/**
 * Create a connected client/server transport pair. The in-memory server side is
 * what tests drive to emulate a language server.
 */
export function createMemoryTransportPair(options: MemoryTransportOptions = {}): MemoryTransportPair {
  const clientHandlers = new Set<(message: unknown) => void>();
  const serverHandlers = new Set<(message: unknown) => void>();

  const client: LspTransport = {
    send(message) {
      options.onSend?.("client", message);
      if (options.silent) return;
      queueMicrotask(() => {
        for (const handler of serverHandlers) handler(message);
      });
    },
    onMessage(handler) {
      clientHandlers.add(handler);
    },
    onClose() {
      // Client side close handlers are managed by LspClient itself.
    },
    close() {
      // no-op
    },
  };

  const server: LspTransport = {
    send(message) {
      options.onSend?.("server", message);
      if (options.silent) return;
      queueMicrotask(() => {
        for (const handler of clientHandlers) handler(message);
      });
    },
    onMessage(handler) {
      serverHandlers.add(handler);
    },
    onClose() {
      // no-op
    },
    close() {
      // no-op
    },
  };

  return { client, server };
}
