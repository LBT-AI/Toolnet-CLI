export type Role = "user" | "assistant" | "system" | "tool";

export interface Msg { 
  role: Role; 
  content: string; 
  tool_calls?: any[]; 
  tool_call_id?: string; 
  name?: string; 
  _renderedLines?: string[];
  _lastRenderCols?: number;
}

export const SPINNER = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

export const COMMANDS = [
  { name: "/exit",      desc: "Exit ToolNet CLI" },
  { name: "/help",      desc: "Toggle help/hints" },
  { name: "/model",     desc: "Pick AI model (Ctrl+K)" },
  { name: "/clear",     desc: "Clear chat history" },
  { name: "/agent",     desc: "Toggle Build/Plan mode" },
  { name: "/bypass",    desc: "Toggle bypass mode on/off" },
  { name: "/plan",      desc: "Switch to Plan mode" },
  { name: "/build",     desc: "Switch to Build mode" },
  { name: "/providers", desc: "Show providers (open Web UI)" },
  { name: "/combos",    desc: "Manage AI combos (open Web UI)" },
  { name: "/keys",      desc: "Manage API keys (open Web UI)" },
  { name: "/key ",      desc: "/key <provider> <apikey> to add key directly" },
  { name: "/settings",  desc: "Open gateway settings" },
  { name: "/status",    desc: "Show gateway connection status" },
];

export const store = {
  messages: [] as Msg[],
  inputBuffer: "",
  cursorPos: 0,
  scrollOffset: 0,
  statusText: "",
  isStreaming: false,
  spinnerIdx: 0,
  spinnerTimer: null as ReturnType<typeof setInterval> | null,
  currentModel: "openai/gpt-4o",
  agentMode: "Build" as "Build" | "Plan",
  bypassMode: false,
  gatewayUrl: "http://127.0.0.1:20127",
  showHelp: false,
  showModelPicker: false,
  modelPickerIdx: 0,
  availableModels: [] as string[],
  filteredModels: [] as string[],
  modelSearchQuery: "",
  abortController: null as AbortController | null,
  ctrlCCount: 0,
  ctrlCTimer: null as ReturnType<typeof setTimeout> | null,
  startTime: 0,
  elapsedDisplay: "",
  lastTokens: "",
  toastMsg: "",
  toastTimer: null as ReturnType<typeof setTimeout> | null,
  cmdSuggestIdx: 0,
};
