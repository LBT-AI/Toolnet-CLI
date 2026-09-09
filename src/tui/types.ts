export type Role = "user" | "assistant" | "system" | "tool";

export interface Msg {
  role: Role;
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export type ApprovalChoice = "y" | "a" | "t" | "n";

export interface PendingConfirmation {
  prompt: string;
  /** Currently highlighted option index in the approval modal (0-based). */
  selectedIndex?: number;
  onDecision?: (choice: ApprovalChoice) => void;
  resolve: (val: boolean) => void;
}

/**
 * OAuth device-flow modal state — rendered by renderAll as an overlay in the
 * SAME render tree (never writes to stdout itself).
 */
export interface DeviceCodeModalState {
  provider: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  /** Status line shown in the modal footer ("Waiting for authorization…"). */
  statusText: string;
}

export interface InputState {
  buffer: string;
  cursor: number;
}

export type Overlay =
  | { type: "none" }
  | { type: "tools"; selected: number; scroll: number; query?: string }
  | { type: "tool-detail"; toolId: string }
  | { type: "harness"; selected: number; scroll: number; query?: string }
  | { type: "harness-detail"; section: string };
