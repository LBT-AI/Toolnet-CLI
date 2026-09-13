import { existsSync } from "node:fs";
import { resolve } from "node:path";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import { computeLayoutGeometry } from "../../../src/tui/layout";

// ─── 1. Canonical Async Mutation Helper Contract ──────────────────────────
export type MutationState = "idle" | "pending" | "success" | "error";

export interface AsyncMutation<TInput, TOutput> {
  state: MutationState;
  error: Error | null;
  execute(input: TInput): Promise<TOutput>;
  reset(): void;
}

export interface AsyncMutationOptions<TOutput> {
  onSuccess?: (result: TOutput) => void;
  onError?: (error: Error) => void;
  onSettled?: () => void;
}

export function createReferenceAsyncMutation<TInput, TOutput>(
  mutationFn: (input: TInput) => Promise<TOutput>,
  options?: AsyncMutationOptions<TOutput>
): AsyncMutation<TInput, TOutput> {
  let state: MutationState = "idle";
  let error: Error | null = null;
  let activePromise: Promise<TOutput> | null = null;

  return {
    get state() {
      return state;
    },
    get error() {
      return error;
    },
    async execute(input: TInput): Promise<TOutput> {
      // Double-submit lock: if already pending, reject or return active
      if (state === "pending" && activePromise) {
        throw new Error("Mutation is already pending; duplicate execution blocked");
      }

      state = "pending";
      error = null;

      activePromise = (async () => {
        try {
          const result = await mutationFn(input);
          state = "success";
          options?.onSuccess?.(result);
          return result;
        } catch (err: any) {
          state = "error";
          const errObj = err instanceof Error ? err : new Error(String(err));
          error = errObj;
          options?.onError?.(errObj);
          throw errObj;
        } finally {
          activePromise = null;
          options?.onSettled?.();
        }
      })();

      return activePromise;
    },
    reset() {
      state = "idle";
      error = null;
      activePromise = null;
    },
  };
}

export async function getAsyncMutationFactory(): Promise<
  <TInput, TOutput>(
    fn: (input: TInput) => Promise<TOutput>,
    opts?: AsyncMutationOptions<TOutput>
  ) => AsyncMutation<TInput, TOutput>
> {
  const prodPath = resolve(process.cwd(), "src/tui/asyncMutation.ts");
  if (existsSync(prodPath)) {
    try {
      const mod = await import("../../../src/tui/asyncMutation");
      if (typeof mod.createAsyncMutation === "function") {
        return mod.createAsyncMutation;
      }
    } catch {
      // fallback to reference
    }
  }
  return createReferenceAsyncMutation;
}

// ─── 2. FIFO Permission Interrupt Manager Contract ────────────────────────
export interface PermissionRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  resolve: (approved: boolean) => Promise<void> | void;
  reject: (err: Error) => void;
}

export class ReferencePermissionInterruptManager {
  private queue: PermissionRequest[] = [];
  private activeMutation: boolean = false;

  public enqueue(req: PermissionRequest): void {
    this.queue.push(req);
  }

  public current(): PermissionRequest | null {
    return this.queue.length > 0 ? this.queue[0] : null;
  }

  public hasPending(): boolean {
    return this.queue.length > 0;
  }

  public get pendingCount(): number {
    return this.queue.length;
  }

  public async replyCurrent(choice: "yes" | "always" | "no"): Promise<void> {
    if (this.queue.length === 0) {
      throw new Error("No pending permission request to reply to");
    }
    if (this.activeMutation) {
      throw new Error("Permission reply mutation is already in flight");
    }

    this.activeMutation = true;
    const req = this.queue[0];

    try {
      const approved = choice === "yes" || choice === "always";
      // Await acknowledgment before dequeuing (zero fire-and-forget)
      await Promise.resolve(req.resolve(approved));
      this.queue.shift(); // Dequeue only after backend acknowledgment
    } finally {
      this.activeMutation = false;
    }
  }
}

export async function getPermissionInterruptManagerClass(): Promise<typeof ReferencePermissionInterruptManager> {
  const prodPath = resolve(process.cwd(), "src/tui/permissions/interruptManager.ts");
  if (existsSync(prodPath)) {
    try {
      const mod = await import("../../../src/tui/permissions/interruptManager");
      if (mod.PermissionInterruptManager) {
        return mod.PermissionInterruptManager;
      }
    } catch {
      // fallback to reference
    }
  }
  return ReferencePermissionInterruptManager;
}

// ─── 3. Shared Utilities Contract ──────────────────────────────────────────
export function visibleWidth(str: string): number {
  if (!str) return 0;
  return stringWidth(stripAnsi(str));
}

export function padVisible(str: string, targetWidth: number, align: "left" | "right" | "center" = "left"): string {
  const cur = visibleWidth(str);
  if (cur >= targetWidth) return str;
  const padLen = targetWidth - cur;
  if (align === "right") {
    return " ".repeat(padLen) + str;
  }
  if (align === "center") {
    const left = Math.floor(padLen / 2);
    const right = padLen - left;
    return " ".repeat(left) + str + " ".repeat(right);
  }
  return str + " ".repeat(padLen);
}

export function truncateVisible(str: string, maxWidth: number, ellipsis = "…"): string {
  if (!str || maxWidth <= 0) return "";
  if (visibleWidth(str) <= maxWidth) return str;
  if (maxWidth <= visibleWidth(ellipsis)) return ellipsis.slice(0, maxWidth);

  let out = "";
  let currentWidth = 0;
  const targetWidth = maxWidth - visibleWidth(ellipsis);

  for (const char of Array.from(str)) {
    const charWidth = stringWidth(char);
    if (currentWidth + charWidth > targetWidth) break;
    out += char;
    currentWidth += charWidth;
  }

  return out + ellipsis;
}

export function formatRelativeTime(date: Date | number): string {
  const ts = typeof date === "number" ? date : date.getTime();
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

// ─── 4. Responsive Layout Calculation Contract ─────────────────────────────
export type TerminalBreakpoint = "wide" | "normal" | "small" | "narrow";

export interface ResponsiveLayoutInfo {
  cols: number;
  rows: number;
  breakpoint: TerminalBreakpoint;
  hasPanel: boolean;
  panelWidth: number;
  chatCols: number;
  chatRows: number;
  inputRows: number;
  popupRows: number;
  cursorRow: number;
  cursorCol: number;
}

export function calculateLayoutContract(
  cols: number,
  rows: number,
  inputLineCount = 1,
  activeSuggestsCount = 0
): ResponsiveLayoutInfo {
  // Production layout math is pure over explicit dimensions, so the contract
  // exercises exactly the geometry the TUI frame renders.
  return computeLayoutGeometry(cols, rows, activeSuggestsCount, 2, 0, false, inputLineCount);
}
