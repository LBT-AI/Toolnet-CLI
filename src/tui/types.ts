export type Role = "user" | "assistant" | "system" | "tool";

export interface Msg {
  role: Role;
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export interface PendingConfirmation {
  prompt: string;
  onDecision?: (choice: "y" | "a" | "n") => void;
  resolve: (val: boolean) => void;
}

export interface InputState {
  buffer: string;
  cursor: number;
}
