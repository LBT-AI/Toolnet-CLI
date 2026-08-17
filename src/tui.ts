#!/usr/bin/env bun
/**
 * ToolNet CLI — Full-screen TUI
 * Raw terminal mode, pure ANSI escape codes, no external TUI libraries.
 * Compatible with Termius mobile SSH, all ANSI terminals.
 */

import { createInterface } from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_SYSTEM_PROMPT } from "./lib/agentRuntime";

const PLANNER_SYSTEM_PROMPT = `You are ToolNet Planner. Your goal is to analyze the user request, explore the codebase using read-only tools, and create a step-by-step plan. Do not execute the plan yourself. Use the save_plan tool to save the plan.`;


// ─── ANSI Helpers ───────────────────────────────────────────────────────────
const ESC = "\x1b";
const CSI = ESC + "[";
const ANSI_REGEX = /\x1b\[[^m]*m/g;

import { providerPicker } from "./components/ProviderPicker";
import { saveCliKey, getCliKey, loadCliKeys } from "./lib/keys";
import { agentTools, executeTool, isDangerousCommand, getMergedAgentTools } from "./lib/agentTools";
import { evaluatePermission, getSandboxMode, setSandboxMode, sessionTrust } from "./lib/permissions";
import { getCwdInfo, initWorkspace } from "./lib/codingAgent";
import { getAllCommands, dispatchCommand } from "./commands/index";
import { GatewayClient } from "./lib/gateway";
import { loadConfig } from "./lib/config";
import { setupTerminalLifecycle, restoreTerminal, wrapErrorBoundary } from "./lib/terminalLifecycle";
import { saveSession, loadSession, getLastSessionId, parseSessionArgs } from "./lib/sessionPersistence";
import { getAgentSystemPrompt } from "./lib/agentRuntime";
import { BracketedPasteParser, ENABLE_BRACKETED_PASTE } from "./lib/bracketedPaste";
import { getModelTags } from "./lib/modelTags";
import { activeSchedulers } from "./teamwork/dynamicScheduler";
import { printToolStart, printToolEnd } from "./lib/tool-format";
import { backgroundTasks } from "./lib/backgroundTasks";
import { compactMessages, contextEngine } from "./lib/context";
import { parseAndProcessInput } from "./lib/attachments";
import { bypassEngine } from "./lib/bypass";

import { A, T, write, getSize } from "./term";
import { playSplashAnimation } from "./splash";

setupTerminalLifecycle();
backgroundTasks.onUpdate(() => {
  if (typeof renderAll === "function") renderAll();
});
setInterval(() => {
  if (activeSchedulers.size > 0) {
    if (typeof renderAll === "function") renderAll();
  }
}, 500);

function writeln(s: string) { write(s + "\r\n"); }

function fillLine(text: string, width: number, fg = A.fgText, bg = A.bgSurface): string {
  const stripped = text.replace(ANSI_REGEX, "");
  const pad = Math.max(0, width - stripped.length);
  return bg + fg + text + " ".repeat(pad) + A.reset;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

// ─── Constants ───────────────────────────────────────────────────────────────

// ─── State ───────────────────────────────────────────────────────────────────
const SPINNER = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
type Role = "user" | "assistant" | "system" | "tool";
interface Msg { role: Role; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string; }

let messages: Msg[] = [];
let currentSessionId = `sess_${Date.now()}`;

function saveCurrentSession() {
  if (currentSessionId) {
    saveSession(currentSessionId, messages, {
      model: currentModel,
      agentMode,
    });
  }
}
let inputBuffer = "";
let cursorPos = 0;
let scrollOffset = 0;    // how many lines scrolled up from bottom
let statusText = "";
let isStreaming = false;
let spinnerIdx = 0;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let pendingConfirmation: { prompt: string, onDecision?: (choice: "y" | "a" | "n") => void, resolve: (val: boolean) => void } | null = null;
let currentModel = "openai/gpt-4o";
let agentMode: "Build" | "Plan" = "Build";
let bypassMode = bypassEngine.isEnabled();
let bypassLevel = bypassEngine.getLevel();
let gatewayUrl = "http://127.0.0.1:20127";
let showHelp = false;
let showModelPicker = false;
let modelPickerIdx = 0;
let availableModels: string[] = [];
let filteredModels: string[] = [];
let modelSearchQuery = "";
let abortController: AbortController | null = null;
let ctrlCCount = 0;
let ctrlCTimer: ReturnType<typeof setTimeout> | null = null;
let startTime = 0;
let elapsedDisplay = "";
let lastTokens = "";

// ─── Toasts & Notifications ────────────────────────────────────────────────
let toastMsg = "";
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(msg: string, ms = 2500) {
  toastMsg = msg;
  renderAll();
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastMsg = ""; renderAll(); }, ms);
}

// ─── Slash command suggestions ──────────────────────────────────────────────
let cmdSuggestIdx = 0;

function getSuggestions(input: string) {
  if (!input.startsWith("/")) return [];
  const search = input.toLowerCase().slice(1);
  return getAllCommands()
    .filter(c => c.name.startsWith(search) || c.aliases.some(a => a.startsWith(search)))
    .map(c => ({ name: "/" + c.name, desc: c.description }));
}

// ─── Layout constants ────────────────────────────────────────────────────────
const HEADER_ROWS = 1;
const STATUS_ROWS = 1;
const INPUT_ROWS = 2;   // border + input line
const RESERVED = HEADER_ROWS + STATUS_ROWS + INPUT_ROWS;

// ─── Render ──────────────────────────────────────────────────────────────────
function renderAll() {
  wrapErrorBoundary(() => {
    const { cols, rows } = getSize();
    const activeSuggests = getSuggestions(inputBuffer);
    const popupRows = activeSuggests.length > 0 ? Math.min(activeSuggests.length, 8) + 1 : 0;
    const chatRows = rows - RESERVED - popupRows;
    const out: string[] = [];

    // Go home, hide cursor
    out.push(T.hide + T.home);

  // ── Dynamic Theme Color ──
  let primaryColor = A.fgCyan; // Build mode default
  if (bypassMode) {
    primaryColor = A.fgRed;
  } else if (agentMode === "Plan") {
    primaryColor = A.fgYellow;
  }

  // ── Header ──
  const bypassLabel = bypassMode ? A.fgRed + `[Bypass:${bypassLevel.toUpperCase()}] ` + A.reset : "";
  const modeLabel = A.fgSubtext + "[" + A.fgText + agentMode + A.fgSubtext + "] " + bypassLabel + A.reset;
  const modelLabel = A.fgSubtext + "Model: " + A.fgText + truncate(currentModel, 30) + A.reset;
  const gwLabel = A.fgSubtext + " │ GW: " + A.fgGreen + "●" + A.reset + " ";
  const tokenLabel = lastTokens ? A.fgSubtext + "│ Tokens: " + A.fgYellow + lastTokens + A.reset + " " : "";
  const headerRight = modelLabel + gwLabel + tokenLabel + modeLabel;
  const headerRightStripped = headerRight.replace(ANSI_REGEX, "");
  const padding = Math.max(0, cols - headerRightStripped.length);

  out.push(" ".repeat(padding) + headerRight + A.reset + "\r\n");

  // ── Chat area ──
  const chatLines: string[] = [];
  for (const msg of messages) {
    const isUser = msg.role === "user";
    const prefix = isUser
      ? primaryColor + A.bold + " ❯ " + A.reset
      : A.fgYellow + A.bold + " ✦ " + A.reset;
    const prefixStripped = " ❯ ";
    const hasPanel = cols > 100;
    const PANEL_WIDTH = 40;
    const chatCols = hasPanel ? cols - PANEL_WIDTH : cols;
    const wrapWidth = chatCols - prefixStripped.length - 2;

    let isToolResponse = msg.role === "tool";
    let parsedTool: any = null;

    if (!isToolResponse && typeof msg.content === "string" && msg.content.trim().startsWith("{")) {
      try {
        const tmp = JSON.parse(msg.content);
        if (tmp && (tmp.stdout !== undefined || tmp.stderr !== undefined || tmp.exitCode !== undefined)) {
          isToolResponse = true;
          parsedTool = tmp;
        }
      } catch {}
    } else if (isToolResponse && typeof msg.content === "string") {
      try { parsedTool = JSON.parse(msg.content); } catch {}
    }

    if (isToolResponse) {
      let toolCmd = "";
      let toolName = msg.name || "Tool";

      let argsObj: any = null;
      if (msg.tool_call_id) {
        for (const prev of messages) {
          if (prev.tool_calls) {
            const tc = prev.tool_calls.find((t: any) => t.id === msg.tool_call_id);
            if (tc) {
              toolName = tc.function?.name || toolName;
              try {
                argsObj = JSON.parse(tc.function.arguments);
              } catch {}
            }
          }
        }
      }

      const isSuccess = parsedTool ? (parsedTool.exitCode === 0 || !("exitCode" in parsedTool) || !parsedTool.error) : true;
      const headerText = printToolEnd(toolName, argsObj, isSuccess);
      
      chatLines.push(" " + headerText);
      
      const verbose = process.env.TOOLNET_DEBUG === "1" || process.argv.includes("--verbose");
      
      let outStr = "";
      if (verbose) {
        if (parsedTool) {
          let outText = parsedTool.stdout || parsedTool.output || parsedTool.result || "";
          let errText = parsedTool.stderr || parsedTool.error || "";
          if (typeof outText !== "string") outText = JSON.stringify(outText);
          if (typeof errText !== "string") errText = JSON.stringify(errText);
          outStr = outText;
          if (errText) outStr += (outStr ? "\n" : "") + errText;
        } else if (typeof msg.content === "string") {
          outStr = msg.content;
        }
      }

      if (outStr.trim()) {
        const lines = outStr.trim().split("\n");
        const tNameLower = toolName.toLowerCase();
        const isDiffTool = tNameLower.includes("edit") || tNameLower.includes("write") || tNameLower.includes("replace");
        const maxLines = isDiffTool ? 30 : 3;
        for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
          let lineContent = truncate(lines[i], cols - 6);
          let color = A.fgSubtext + A.dim;
          if (isDiffTool) {
            if (lineContent.startsWith("+") && !lineContent.startsWith("+++")) {
              color = A.fgGreen;
            } else if (lineContent.startsWith("-") && !lineContent.startsWith("---")) {
              color = A.fgRed;
            } else if (lineContent.startsWith("@@")) {
              color = A.fgCyan;
            }
          }
          chatLines.push("    " + color + lineContent + A.reset);
        }
        if (lines.length > maxLines) {
          chatLines.push("    " + A.fgSubtext + A.dim + `... (${lines.length - maxLines} more lines)` + A.reset);
        }
      }
      chatLines.push("");
      continue;
    }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        let argsObj: any = null;
        try {
          argsObj = JSON.parse(tc.function.arguments || "{}");
        } catch {}
        chatLines.push(" " + printToolStart(tc.function.name, argsObj));
      }
      chatLines.push(""); continue;
    }

    const lines = wrapText(msg.content, wrapWidth);
    let inCodeBlock = false;
    let codeLang = "";
    let inThoughtBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const linePrefix = i === 0 ? prefix : " ".repeat(prefixStripped.length);
      let content = lines[i];
      let color = isUser ? A.fgText : A.fgText + A.dim; // default

      if (content.includes("<thought>")) {
        inThoughtBlock = true;
      }
      const closeThought = content.includes("</thought>");

      // Syntax & Diff Highlighting
      if (content.startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        if (inCodeBlock) codeLang = content.slice(3).trim().toLowerCase();
        color = A.fgSubtext; // backticks color
      } else if (inCodeBlock) {
        if (codeLang === "diff" || codeLang === "") {
          if (content.startsWith("+") && !content.startsWith("+++")) {
            color = A.fgGreen;
          } else if (content.startsWith("-") && !content.startsWith("---")) {
            color = A.fgRed;
          } else {
            color = A.fgText; // normal code
          }
        } else {
          color = A.fgText; // normal code
          // Rudimentary syntax highlight
          content = content
            .replace(/\b(const|let|var|function|class|return|if|else|for|while|import|from|export)\b/g, A.fgBlue + "$1" + A.fgText)
            .replace(/\b(true|false|null|undefined)\b/g, A.fgPeach + "$1" + A.fgText)
            .replace(/(["'`])(.*?)(["'`])/g, A.fgGreen + "$1$2$3" + A.fgText);
        }
      } else if (inThoughtBlock) {
        color = A.fgSubtext + A.italic;
      }

      if (closeThought) {
        inThoughtBlock = false;
      }

      chatLines.push(linePrefix + color + content + A.reset);
    }
    chatLines.push(""); // blank line between messages for whitespace
  }

  // Scroll: show last chatRows lines
  const totalLines = chatLines.length;
  const maxScroll = Math.max(0, totalLines - chatRows);
  const clampedScroll = Math.min(scrollOffset, maxScroll);
  const startLine = Math.max(0, totalLines - chatRows - clampedScroll);
  const visibleLines = chatLines.slice(startLine, startLine + chatRows);

  // Generate Side Panel Lines
  const panelLines: string[] = [];
  const hasPanel = cols > 100;
  const PANEL_WIDTH = 40;
  const chatCols = hasPanel ? cols - PANEL_WIDTH : cols;

  if (hasPanel) {
    panelLines.push(A.bgSurface + A.fgBlue + A.bold + " Teamwork & Tasks" + " ".repeat(PANEL_WIDTH - 17) + A.reset);
    panelLines.push(A.bgSurface + "─".repeat(PANEL_WIDTH) + A.reset);
    
    const scheds = Array.from(activeSchedulers);
    if (scheds.length > 0) {
      panelLines.push(A.bgSurface + A.fgYellow + A.bold + " Active Subagents" + " ".repeat(PANEL_WIDTH - 17) + A.reset);
      for (const s of scheds) {
        const state = s.getState();
        const activeCount = state.activeWorkers || 0;
        const maxCount = state.maxWorkers || 1;
        const line = `  [${state.status}] W:${activeCount}/${maxCount} T:${state.completedTaskIds.length}/${state.graph?.nodes?.length || 0}`;
        const lineStr = truncate(line, PANEL_WIDTH);
        panelLines.push(A.bgSurface + A.fgText + lineStr + " ".repeat(Math.max(0, PANEL_WIDTH - lineStr.length)) + A.reset);
        
        for (const tid of (state.runningTaskIds || [])) {
          const node = s.getReadyNodes().find(n => n.id === tid) || (Array.isArray(state.graph?.nodes) ? (state.graph!.nodes as any[]).find((n: any) => n.id === tid) : undefined);
          if (node) {
            const nLine = `   - ${node.role || 'Agent'}: ${node.title}`;
            const nLineStr = truncate(nLine, PANEL_WIDTH);
            panelLines.push(A.bgSurface + A.fgSubtext + nLineStr + " ".repeat(Math.max(0, PANEL_WIDTH - nLineStr.length)) + A.reset);
          }
        }
      }
      panelLines.push(A.bgSurface + " ".repeat(PANEL_WIDTH) + A.reset);
    }

    const tasks = backgroundTasks.getActiveTasks();
    if (tasks.length > 0) {
      panelLines.push(A.bgSurface + A.fgCyan + A.bold + " Background Tasks" + " ".repeat(PANEL_WIDTH - 17) + A.reset);
      for (const t of tasks) {
        const line = `  [${t.status}] ${t.name}`;
        const lineStr = truncate(line, PANEL_WIDTH);
        panelLines.push(A.bgSurface + A.fgText + lineStr + " ".repeat(Math.max(0, PANEL_WIDTH - lineStr.length)) + A.reset);
      }
      panelLines.push(A.bgSurface + " ".repeat(PANEL_WIDTH) + A.reset);
    }
  }

  // Pad if fewer lines than chatRows
  for (let i = 0; i < chatRows; i++) {
    const line = visibleLines[i] ?? "";
    const stripped = line.replace(ANSI_REGEX, "");
    const chatPad = Math.max(0, chatCols - stripped.length);
    const chatPart = line + " ".repeat(chatPad) + A.reset;
    
    if (hasPanel) {
      const panelPart = panelLines[i] || (A.bgSurface + " ".repeat(PANEL_WIDTH) + A.reset);
      out.push(chatPart + panelPart + "\r\n");
    } else {
      out.push(chatPart + "\r\n");
    }
  }

  // ── Slash command suggestions popup (above input) ──
  if (activeSuggests.length > 0) {
    const listRows = popupRows - 1;
    // Clamp cmdSuggestIdx
    if (cmdSuggestIdx >= activeSuggests.length) cmdSuggestIdx = activeSuggests.length - 1;
    
    // Sliding window for scrolling
    let startIdx = 0;
    if (cmdSuggestIdx >= listRows) {
      startIdx = cmdSuggestIdx - listRows + 1;
    }
    
    for (let i = 0; i < listRows; i++) {
      const si = startIdx + i;
      if (si >= activeSuggests.length) break;
      const cmd = activeSuggests[si];
      const selected = si === cmdSuggestIdx;
      const bg = selected ? A.bgOverlay : A.bgSuggest;
      const nameFg = selected ? primaryColor + A.bold : primaryColor;
      const descFg = A.fgSubtext;
      const nameText = cmd.name.padEnd(14);
      const descText = truncate(cmd.desc, cols - 18);
      const line = bg + "  " + nameFg + nameText + A.reset + bg + descFg + descText + A.reset;
      const stripped = ("  " + nameText + descText).length;
      const pad = Math.max(0, cols - stripped - 2);
      out.push(line + bg + " ".repeat(pad) + A.reset + "\r\n");
    }
    out.push(A.bgSuggest + A.fgSubtext + " ↑↓ navigate  Tab/Enter select  Esc cancel ".padEnd(cols) + A.reset + "\r\n");
  }

  // ── Toast Notification ──
  if (toastMsg) {
    const toastW = toastMsg.length + 4;
    const toastR = 2; // top margin
    const toastC = Math.max(1, Math.floor((cols - toastW) / 2));
    out.push(T.goto(toastR, toastC));
    out.push(A.bgOverlay + A.fgText + A.bold + "  " + toastMsg + "  " + A.reset);
  }

  // ── Confirmation Modal ──
  if (pendingConfirmation) {
    const boxW = Math.min(64, cols - 4);
    const boxH = 5;
    const startRow = Math.floor((rows - boxH) / 2);
    const startCol = Math.floor((cols - boxW) / 2);
    out.push(T.goto(startRow, startCol));
    out.push(A.bgRed + A.fgText + A.bold + "┌" + "─".repeat(boxW - 2) + "┐" + A.reset);
    out.push(T.goto(startRow + 1, startCol));
    const titleText = " 🛡️ Security Approval Required ";
    const titlePad = Math.max(0, boxW - 2 - titleText.length);
    out.push(A.bgRed + A.fgText + A.bold + "│" + titleText + " ".repeat(titlePad) + "│" + A.reset);
    out.push(T.goto(startRow + 2, startCol));
    const descText = " " + truncate(pendingConfirmation.prompt, boxW - 4);
    const descPad = Math.max(0, boxW - 2 - descText.length);
    out.push(A.bgRed + A.fgText + "│" + descText + " ".repeat(descPad) + "│" + A.reset);
    out.push(T.goto(startRow + 3, startCol));
    const hintText = " [Y] Once   [A] Allow for Session   [N] Deny ";
    const hintPad = Math.max(0, boxW - 2 - hintText.length);
    out.push(A.bgRed + A.fgText + A.bold + "│" + hintText + " ".repeat(hintPad) + "│" + A.reset);
    out.push(T.goto(startRow + 4, startCol));
    out.push(A.bgRed + A.fgText + A.bold + "└" + "─".repeat(boxW - 2) + "┘" + A.reset);
  }

  // ── Input border (Micro-interaction: Lights up when typing) ──
  const isTyping = inputBuffer.length > 0;
  const borderCol = isTyping ? primaryColor : A.fgSubtext + A.dim;
  out.push(borderCol + "─".repeat(cols) + A.reset + "\r\n");

  // ── Input bar (Micro-interaction: Prompt icon changes color) ──
  const prompt = isTyping ? primaryColor + A.bold + " ❯ " + A.reset : A.fgSubtext + A.bold + " ❯ " + A.reset;
  const promptWidth = 3;
  const inputVisible = inputBuffer.length > cols - promptWidth - 4
    ? "…" + inputBuffer.slice(-(cols - promptWidth - 5))
    : inputBuffer;
  const placeholder = inputBuffer === ""
    ? A.fgSubtext + A.dim + "Ask anything... (/help for commands)" + A.reset
    : A.fgText + inputVisible + A.reset;

  out.push(
    T.clearLine +
    prompt +
    (inputBuffer === "" ? placeholder : A.fgText + inputVisible + A.reset) +
    A.reset + "\r\n"
  );

  // ── Status bar ──
  let statusContent: string;
  if (showHelp) {
    statusContent = A.fgYellow + " Shortcuts: Tab (mode), Ctrl+K (models), Esc (cancel), / (commands)" + A.reset;
  } else if (isStreaming) {
    const spinner = A.fgYellow + A.bold + SPINNER[spinnerIdx] + A.reset;
    statusContent = spinner + " " + A.fgYellow + statusText + A.reset + A.fgSubtext + elapsedDisplay + A.reset;
  } else if (statusText) {
    const isErr = statusText.startsWith("Error") || statusText.startsWith("✖");
    const fg = isErr ? A.fgRed : statusText.startsWith("✔") ? A.fgGreen : primaryColor;
    statusContent = fg + A.bold + statusText + A.reset + A.fgSubtext + elapsedDisplay + A.reset;
  } else {
    statusContent = A.fgGreen + A.bold + "● Ready" + A.reset + A.fgSubtext + "  │  Enter:send  Tab:mode  Ctrl+K:model" + A.reset;
  }
  
  const { workspaceRoot, bypassPolicy } = getCwdInfo();
  const accessColor = bypassPolicy ? A.fgRed : A.fgCyan;
  const accessStr = bypassPolicy ? "System" : "Workspace";
  const cwdDisplay = ` [Workspace: ${workspaceRoot} | Access: ${accessColor}${accessStr}${A.fgSubtext}]`;
  
  const statusStripped = statusContent.replace(ANSI_REGEX, "");
  const rightStripped = cwdDisplay.replace(ANSI_REGEX, "");
  const statusPad = Math.max(0, cols - statusStripped.length - rightStripped.length);
  
  out.push(A.bgSurface + statusContent + " ".repeat(statusPad) + A.fgSubtext + cwdDisplay + A.reset);

  // Position cursor in input line
  const cursorRow = rows - INPUT_ROWS + 1;  // 1-indexed
  const cursorCol = Math.min(promptWidth + 1 + cursorPos, cols - 1) + 1;
  if (!showHelp && !showModelPicker && !providerPicker.show) {
    out.push(T.goto(cursorRow, cursorCol) + T.show);
  } else {
    out.push(T.hide);
  }

  write(out.join(""));

  if (showModelPicker) renderModelPicker();
  if (providerPicker.show) providerPicker.render();
  });
}

// ─── Text wrapping ───────────────────────────────────────────────────────────
function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  const paragraphs = text.split("\n");
  for (const para of paragraphs) {
    if (para === "") { lines.push(""); continue; }
    let current = "";
    for (const word of para.split(" ")) {
      if (current === "") {
        current = word;
      } else if (current.length + 1 + word.length <= width) {
        current += " " + word;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines.length ? lines : [""];
}

// ─── Streaming chat ─────────────────────────────────────────────────────────
async function sendMessage(text: string) {
  if (!text.trim()) return;

  // Slash commands
  if (text.startsWith("/")) {
    await handleCommand(text.trim());
    return;
  }

  messages.push({ role: "user", content: text });
  // Add placeholder for assistant immediately so spinner shows in chat
  messages.push({ role: "assistant", content: "" });
  saveCurrentSession();
  let assistantIdx = messages.length - 1;

  scrollOffset = 0;
  startTime = Date.now();
  elapsedDisplay = "";
  setStatus("Thinking…");
  isStreaming = true;
  let isReceivingStream = false;
  abortController = new AbortController();

  spinnerTimer = setInterval(() => {
    spinnerIdx = (spinnerIdx + 1) % SPINNER.length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    elapsedDisplay = "  " + elapsed + "s";
    if (!isReceivingStream) {
      // Show spinner in chat area while waiting for first byte
      messages[assistantIdx].content = A.fgYellow + SPINNER[spinnerIdx] + " " + A.fgSubtext + statusText + A.reset;
    }
    renderAll();
  }, 100);

  try {
    let continueAgentLoop = true;
    while (continueAgentLoop) {
      continueAgentLoop = false;
      setStatus("Calling API…");

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (bypassMode) {
        headers["x-bypass-toolnet"] = "true";
        headers["x-bypass-level"] = bypassLevel;
      }

      const providerStr = currentModel.includes("/") ? currentModel.split("/")[0] : currentModel;
      let localKey = getCliKey(providerStr);
      if (!localKey) {
        localKey = getCliKey("toolnet") || getCliKey("gateway") || getCliKey("default");
      }
      if (localKey) {
        headers["Authorization"] = `Bearer ${localKey}`;
      }

      const autoPrep = contextEngine.prepareMessagesForApi(messages as any, { model: currentModel });
      if (autoPrep.compacted) {
        messages = autoPrep.messages;
        saveCurrentSession();
      }

      const apiMessages = messages.filter((m, i) => i !== assistantIdx).map(m => {
        let contentPayload: any = m.content;
        if (m.role === "user" && typeof m.content === "string" && m.content.includes("@")) {
          const processed = parseAndProcessInput(m.content, getCwdInfo().currentCwd);
          if (processed.attachments.length > 0) {
            contentPayload = processed.formattedContent;
          }
        }
        const out: any = { role: m.role, content: contentPayload };
        if (m.tool_calls) out.tool_calls = m.tool_calls;
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        if (m.name) out.name = m.name;
        return out;
      });

      // Inject system prompt at the beginning if not already present
      if (!apiMessages.some(m => m.role === "system" && !m.content.startsWith("→") && !m.content.startsWith("Unknown"))) {
        apiMessages.unshift({ role: "system", content: agentMode === "Plan" ? PLANNER_SYSTEM_PROMPT : getAgentSystemPrompt() });
      }

      const bodyPayload: any = {
        model: currentModel,
        messages: apiMessages,
        stream: true,
      };

      // Include tools dynamically based on agentMode
      if (agentMode === "Build") {
        bodyPayload.tools = getMergedAgentTools();
        bodyPayload.tool_choice = "auto";
      } else if (agentMode === "Plan") {
        bodyPayload.tools = getMergedAgentTools().filter((t: any) => ["read_file", "grep", "grep_search", "glob", "glob_search", "find_path", "list_dir", "tree", "file_exists", "get_cwd", "web_fetch"].includes(t.function.name));
        bodyPayload.tools.push({
          type: "function",
          function: {
            name: "save_plan",
            description: "Save the generated plan and request user approval to switch to Build mode.",
            parameters: {
              type: "object",
              properties: { content: { type: "string", description: "The plan content" } },
              required: ["content"]
            }
          }
        });
      }

      const res = await fetch(gatewayUrl + "/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify(bodyPayload),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        let errMsg = `HTTP ${res.status}`;
        try { const j = JSON.parse(errText); errMsg = j.error?.message || errMsg; } catch {}
        stopSpinner();
        messages.push({ role: "assistant", content: "✖ Error: " + errMsg });
        setStatus("✖ " + errMsg);
        renderAll();
        return;
      }

      if (!res.body) {
        stopSpinner();
        messages.push({ role: "assistant", content: "✖ Error: No response body" });
        setStatus("✖ No response body");
        renderAll();
        return;
      }

      setStatus("Streaming response…");
      isReceivingStream = true;

      let fullText = "";
      const toolCallsMap: Record<number, any> = {};
      
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";

        for (const line of parts) {
          const t = line.trim();
          if (!t || t === "data: [DONE]") continue;
          if (t.startsWith("data: ")) {
            try {
              const json = JSON.parse(t.slice(6));
              const delta = json.choices?.[0]?.delta;
              if (delta?.content) {
                fullText += delta.content;
                messages[assistantIdx] = { role: "assistant", content: fullText + "▊" };
                scrollOffset = 0;
              }
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index;
                  if (!toolCallsMap[idx]) {
                    toolCallsMap[idx] = { id: tc.id, type: "function", function: { name: tc.function?.name || "", arguments: "" } };
                  }
                  if (tc.function?.arguments) {
                    toolCallsMap[idx].function.arguments += tc.function.arguments;
                  }
                }
              }
              if (json.usage) {
                const u = json.usage;
                lastTokens = `${u.prompt_tokens || 0} \u2192 ${u.completion_tokens || 0} (${u.total_tokens || 0})`;
              }
            } catch {}
          }
        }
      }

      const toolCallsArr = Object.values(toolCallsMap);
      
      if (toolCallsArr.length > 0) {
        // AI called a tool — do NOT render intermediate text content
        // fullText here is intermediate reasoning, not a final answer
        messages[assistantIdx] = { 
          role: "assistant", 
          content: "",  // suppress intermediate content
          tool_calls: toolCallsArr 
        };
        renderAll();
        
        // Execute tools
        for (const tc of toolCallsArr) {
          setStatus(`Executing tool: ${tc.function.name}…`);
          renderAll();
          let parsedArgs = {};
          try { parsedArgs = JSON.parse(tc.function.arguments); } catch {}
          
          const perm = evaluatePermission(tc.function.name, parsedArgs, getSandboxMode(), getCwdInfo().currentCwd);
          if (!perm.allowed) {
            messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify({ error: `Permission Denied: ${perm.reason || "Blocked by sandbox policy."}` }) });
            saveCurrentSession();
            continue;
          }

          if (perm.needsApproval) {
            const promptMsg = perm.reason ? `${perm.reason}` : `Tool ${tc.function.name} requires permission`;
            const targetKey = (parsedArgs as any)?.command || (parsedArgs as any)?.cmd || (parsedArgs as any)?.path || "";
            const confirmed = await new Promise<boolean>((resolve) => {
              pendingConfirmation = {
                prompt: promptMsg,
                onDecision: (choice) => {
                  if (choice === "a") {
                    sessionTrust.recordDecision(tc.function.name, targetKey, "SESSION");
                  }
                },
                resolve,
              };
              renderAll();
            });
            if (!confirmed) {
              messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify({ error: "User denied permission." }) });
              saveCurrentSession();
              continue;
            }
          }

          let result = "";
          if (tc.function.name === "save_plan") {
            const cwd = getCwdInfo().currentCwd;
            const toolnetDir = path.join(cwd, ".toolnet");
            if (!fs.existsSync(toolnetDir)) fs.mkdirSync(toolnetDir);
            fs.writeFileSync(path.join(toolnetDir, "plan.md"), (parsedArgs as any).content || "");
            
            const confirmed = await new Promise<boolean>((resolve) => {
              pendingConfirmation = { prompt: "Plan generated. Approve and switch to Build mode?", resolve };
              renderAll();
            });
            if (confirmed) {
              agentMode = "Build";
              result = JSON.stringify({ stdout: "Plan saved to .toolnet/plan.md. Switched to Build mode.", exitCode: 0 });
              messages.push({ role: "system", content: "→ Plan approved. Switched to execution mode." });
            } else {
              result = JSON.stringify({ error: "User denied the plan." });
            }
          } else {
            result = await executeTool(tc.function.name, parsedArgs);
          }
          messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: result });
          saveCurrentSession();
        }
        
        // Push a new empty assistant message for the next iteration
        messages.push({ role: "assistant", content: "" });
        assistantIdx = messages.length - 1;
        saveCurrentSession();
        continueAgentLoop = true;
      } else {
        // Finalize message with a micro-interaction (check mark briefly)
        const finalContent = fullText || "(empty response)";
        messages[assistantIdx] = { role: "assistant", content: A.fgGreen + "✔ " + A.reset + finalContent };
        saveCurrentSession();
        setTimeout(() => {
          if (messages[assistantIdx]) {
            messages[assistantIdx].content = finalContent;
            renderAll();
          }
        }, 1500);
      }
    }

    scrollOffset = 0;
    stopSpinner();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    setStatus(`✔ Done in ${elapsed}s`);
    elapsedDisplay = "";

  } catch (err: any) {
    stopSpinner();
    if (err?.name === "AbortError") {
      messages.push({ role: "assistant", content: "(cancelled)" });
    } else {
      messages.push({ role: "assistant", content: "✖ Error: " + (err?.message || String(err)) });
    }
    saveCurrentSession();
  } finally {
    abortController = null;
  }
  renderAll();
}

function setStatus(s: string) {
  statusText = s;
}

function stopSpinner() {
  if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
  isStreaming = false;
}

// ─── Slash commands ──────────────────────────────────────────────────────────
async function handleCommand(cmd: string) {
  const parts = cmd.split(" ");
  const name = parts[0].toLowerCase();

  // Special parameterized commands
  if (cmd.startsWith("/key ")) {
    const parts = cmd.split(" ").filter(Boolean);
    if (parts.length < 3) {
      showToast("Usage: /key <provider> <apikey>");
      return;
    }
    const provider = parts[1];
    const apiKey = parts.slice(2).join(" ");
    
    showToast("Saving local CLI key for " + provider + "...");
    saveCliKey(provider, apiKey);
    showToast("Local CLI Key saved successfully!");
    messages.push({ role: "system", content: `→ Saved local CLI API key for ${provider}` });
    renderAll();
    return;
  }

  switch (name) {
    case "/exit":
    case "/quit":
      exitApp();
      break;

    case "/help":
      showHelp = !showHelp;
      break;

    case "/model":
      showToast("Opening Model Picker...");
      await openModelPicker();
      break;

    case "/keys":
      providerPicker.open(setStatus, renderAll);
      break;

    case "/providers":
    case "/combos":
    case "/settings": {
      showToast(`Redirecting to Web UI...`);
      messages.push({ role: "system", content: "→ Open Web UI at: " + gatewayUrl + "/settings" });
      break;
    }

    case "/clear":
      messages = [];
      saveCurrentSession();
      showToast("Chat history cleared");
      setStatus("Chat cleared");
      break;

    case "/agent": {
      agentMode = agentMode === "Build" ? "Plan" : "Build";
      showToast("Switched to " + agentMode + " Mode");
      setStatus("Mode: " + agentMode);
      break;
    }

    case "/plan": {
      agentMode = "Plan";
      showToast("Switched to Plan Mode");
      setStatus("Mode: Plan");
      messages.push({ role: "system", content: "→ Switched to Plan Mode. Generating .toolnet/plan.md checklist..." });
      renderAll();
      setTimeout(() => sendMessage("Please create a detailed checklist for the task in .toolnet/plan.md and wait for my /approve command before executing anything."), 50);
      return; // Skip renderAll below since sendMessage handles it
    }

    case "/approve": {
      agentMode = "Build";
      showToast("Plan Approved - Switched to Build Mode");
      setStatus("Mode: Build");
      messages.push({ role: "system", content: "→ Plan approved. Switched to execution mode." });
      renderAll();
      setTimeout(() => sendMessage("I approve the plan. You may now shift into execution mode and execute the checklist."), 50);
      return;
    }

    case "/build": {
      agentMode = "Build";
      showToast("Switched to Build Mode");
      setStatus("Mode: Build");
      break;
    }

    case "/status":
      showToast("Checking gateway status...");
      break;

    default: {
      const gw = new GatewayClient(gatewayUrl);
      const ctx = {
        gateway: gw,
        addMessage: (role: "user" | "assistant" | "system", content: string) => {
          messages.push({ role, content });
        },
        setModel: (m: string) => {
          currentModel = m;
          setStatus("Model: " + m);
        },
        setStatusMsg: setStatus,
        exit: exitApp,
        currentModel: () => currentModel,
        setBypassMode: (enabled: boolean, level?: string) => {
          bypassEngine.setBypass(enabled, level as any);
          bypassMode = enabled;
          if (level) bypassLevel = level as any;
          showToast(enabled ? `Bypass 2.0 Mode ENABLED (${bypassLevel.toUpperCase()})` : "Bypass Mode DISABLED");
          setStatus(`Bypass Mode: ${enabled ? "ON" : "OFF"}${level ? ` (${level})` : ""}`);
          renderAll();
        },
        getCurrentSessionId: () => currentSessionId,
        setCurrentSessionId: (id: string) => { currentSessionId = id; },
        getMessages: () => messages,
        setMessages: (msgs: any[]) => { messages = msgs; saveCurrentSession(); },
        clearMessages: () => { messages = []; saveCurrentSession(); },
        switchSession: (sessionId: string) => {
          const loaded = loadSession(sessionId);
          if (!loaded) return false;
          currentSessionId = loaded.sessionId;
          messages = loaded.messages as Msg[];
          if (loaded.metadata?.model) currentModel = loaded.metadata.model;
          if (loaded.metadata?.agentMode) agentMode = loaded.metadata.agentMode;
          saveCurrentSession();
          setStatus(`Session: ${currentSessionId}`);
          return true;
        },
        setAgentMode: (mode: "Build" | "Plan") => {
          agentMode = mode;
          setStatus("Mode: " + mode);
        },
      };

      const handled = await dispatchCommand(cmd, ctx);
      if (!handled) {
        messages.push({ role: "system", content: "Unknown command: " + name + "  (type /help)" });
      }
      break;
    }
  }
  renderAll();
}

// ─── Model Picker ────────────────────────────────────────────────────────────
function updateModelSearch() {
  const query = modelSearchQuery.toLowerCase();
  filteredModels = availableModels.filter(m => m.toLowerCase().includes(query));
  if (filteredModels.length === 0) filteredModels = ["No matches"];
  modelPickerIdx = 0;
  renderAll();
}

async function openModelPicker() {
  showModelPicker = true;
  modelSearchQuery = "";
  if (availableModels.length === 0 || availableModels[0] === "Gateway offline") {
    availableModels = ["Loading..."];
    filteredModels = availableModels;
    modelPickerIdx = 0;
    setStatus("Fetching models...");
    renderAll();
    try {
      const localKeys = loadCliKeys();
      const masterKey = localKeys["toolnet"] || localKeys["gateway"] || localKeys["default"];
      const fetchHeaders: Record<string, string> = {};
      if (masterKey) fetchHeaders["Authorization"] = `Bearer ${masterKey}`;
      
      const res = await fetch(gatewayUrl + "/v1/models", { headers: fetchHeaders });
      if (res.ok) {
        const data = await res.json() as any;
        const allModels = (data.data || []).map((m: any) => m.id as string);
        
        const configuredProviders = Object.keys(localKeys);
        const freeProviders = ["opencode", "blackbox", "duckduckgo", "github", "bazaarlink", "qoder", "qwen"];
        
        if (masterKey) {
          // If we have a master gateway key, we can use any model exposed by the gateway router!
          availableModels = allModels;
        } else {
          // Otherwise, only show models for which we have a specific local key or free providers
          availableModels = allModels.filter((m: string) => {
            const prov = m.split("/")[0];
            return configuredProviders.includes(prov) || freeProviders.includes(prov);
          });
        }
        
        if (availableModels.length === 0) availableModels = ["No models available (No keys added)"];
      } else {
        availableModels = ["Error loading models"];
      }
    } catch {
      availableModels = ["Gateway offline"];
    }
  }
  
  filteredModels = [...availableModels];
  modelPickerIdx = filteredModels.indexOf(currentModel);
  if (modelPickerIdx < 0) modelPickerIdx = 0;
  setStatus("Type to search  ↑↓ navigate  Enter select  Esc cancel");
  renderAll();
}

function renderModelPicker() {
  const { cols, rows } = getSize();
  const boxW = Math.min(60, cols - 4);
  const boxH = Math.min(20, rows - 6);
  const startRow = Math.floor((rows - boxH) / 2);
  const startCol = Math.floor((cols - boxW) / 2);

  const out: string[] = [];

  // Draw box
  out.push(T.goto(startRow, startCol));
  out.push(A.bgSurface + A.fgBlue + A.bold + "┌" + "─".repeat(boxW - 2) + "┐" + A.reset);

  // Title
  out.push(T.goto(startRow + 1, startCol));
  const titleText = " Select Model (" + filteredModels.length + " available) ";
  const titlePad = Math.max(0, boxW - 2 - titleText.length);
  out.push(A.bgSurface + A.fgBlue + A.bold + "│" + titleText + " ".repeat(titlePad) + "│" + A.reset);

  // Search bar
  out.push(T.goto(startRow + 2, startCol));
  const searchInput = modelSearchQuery + "█";
  const searchDisp = " Search: " + searchInput;
  const searchPad = Math.max(0, boxW - 2 - searchDisp.length);
  out.push(A.bgSurface + A.fgBlue + "│" + A.fgText + searchDisp + " ".repeat(searchPad) + A.fgBlue + "│" + A.reset);

  // Separator
  out.push(T.goto(startRow + 3, startCol));
  out.push(A.bgSurface + A.fgBlue + "│" + "─".repeat(boxW - 2) + "│" + A.reset);

  // Models list
  const listRows = boxH - 5;
  const listStart = Math.max(0, modelPickerIdx - Math.floor(listRows / 2));
  const visible = filteredModels.slice(listStart, listStart + listRows);

  for (let i = 0; i < listRows; i++) {
    out.push(T.goto(startRow + 4 + i, startCol));
    const modelIdx = listStart + i;
    const model = visible[i];
    if (!model) {
      out.push(A.bgSurface + A.fgBlue + "│" + " ".repeat(boxW - 2) + "│" + A.reset);
    } else {
      const selected = modelIdx === modelPickerIdx;
      const current = model === currentModel;
      const marker = selected ? "▸ " : current ? "✔ " : "  ";
      const tags = getModelTags(model);
      const text = truncate(marker + model, boxW - 3 - tags.length);
      const textPad = Math.max(0, boxW - 3 - text.replace(ANSI_REGEX, "").length - tags.length);
      const fg = selected ? A.fgYellow + A.bold : current ? A.fgGreen : A.fgText;
      const bg = selected ? A.bgOverlay : A.bgSurface;
      const tagsFmt = tags ? A.fgSubtext + A.dim + tags + A.reset : "";
      out.push(bg + A.fgBlue + "│" + fg + " " + text + tagsFmt + " ".repeat(textPad) + A.reset + A.bgSurface + A.fgBlue + "│" + A.reset);
    }
  }

  // Bottom border
  out.push(T.goto(startRow + boxH - 1, startCol));
  out.push(A.bgSurface + A.fgBlue + "└" + "─".repeat(boxW - 2) + "┘" + A.reset);

  write(out.join(""));
}


// ─── Input handling ──────────────────────────────────────────────────────────
function handleKey(data: Buffer) {
  const s = data.toString("utf8");
  const hex = data.toString("hex");

  if (pendingConfirmation) {
    if (hex === "1b") { // esc
      if (pendingConfirmation.onDecision) pendingConfirmation.onDecision("n");
      pendingConfirmation.resolve(false);
      pendingConfirmation = null;
      renderAll();
    } else if (s.toLowerCase() === "y") {
      if (pendingConfirmation.onDecision) pendingConfirmation.onDecision("y");
      pendingConfirmation.resolve(true);
      pendingConfirmation = null;
      renderAll();
    } else if (s.toLowerCase() === "a") {
      if (pendingConfirmation.onDecision) pendingConfirmation.onDecision("a");
      pendingConfirmation.resolve(true);
      pendingConfirmation = null;
      renderAll();
    } else if (s.toLowerCase() === "n") {
      if (pendingConfirmation.onDecision) pendingConfirmation.onDecision("n");
      pendingConfirmation.resolve(false);
      pendingConfirmation = null;
      renderAll();
    }
    return;
  }

  // Model picker navigation
  if (showModelPicker) {
    if (hex === "1b5b41" || hex === "1b4f41") { // Up
      modelPickerIdx = modelPickerIdx <= 0 ? filteredModels.length - 1 : modelPickerIdx - 1;
      renderAll();
    } else if (hex === "1b5b42" || hex === "1b4f42") { // Down
      modelPickerIdx = modelPickerIdx >= filteredModels.length - 1 ? 0 : modelPickerIdx + 1;
      renderAll();
    } else if (hex === "0d" || hex === "0a") { // Enter
      const sel = filteredModels[modelPickerIdx];
      if (sel && !sel.includes("No models") && !sel.includes("Gateway offline") && !sel.includes("Error") && !sel.includes("No matches")) {
        currentModel = sel;
        setStatus("Model: " + currentModel);
      }
      showModelPicker = false;
      renderAll();
    } else if (hex === "1b") { // Esc
      showModelPicker = false;
      setStatus("");
      renderAll();
    } else if (hex === "7f" || hex === "08") { // Backspace
      if (modelSearchQuery.length > 0) {
        modelSearchQuery = modelSearchQuery.slice(0, -1);
        updateModelSearch();
      }
    } else if (s.length === 1 && s >= " " && s <= "~") { // Printable
      modelSearchQuery += s;
      updateModelSearch();
    }
    return;
  }

  // Provider picker navigation
  if (providerPicker.show) {
    providerPicker.handleKey(hex, {
      renderAll,
      setStatus,
      onSelect: (sel) => {
        inputBuffer = "/key " + sel + " ";
        cursorPos = inputBuffer.length;
        setStatus("Paste your API key and press Enter");
        renderAll();
      }
    });
    return;
  }

  // Help toggle
  if (showHelp && (hex === "1b" || s === "?")) {
    showHelp = false;
    renderAll();
    return;
  }

  // Ctrl+C
  if (hex === "03") {
    if (isStreaming) {
      abortController?.abort();
      stopSpinner();
      setStatus("Cancelled");
      renderAll();
      return;
    }
    ctrlCCount++;
    if (ctrlCCount >= 2) {
      exitApp();
    } else {
      setStatus("Press Ctrl+C again to exit  (or type /exit)");
      renderAll();
      if (ctrlCTimer) clearTimeout(ctrlCTimer);
      ctrlCTimer = setTimeout(() => { ctrlCCount = 0; setStatus(""); renderAll(); }, 2000);
    }
    return;
  }

  // Esc — close popups or cancel stream, NEVER exit
  if (hex === "1b") {
    if (showHelp) { showHelp = false; renderAll(); return; }
    if (showModelPicker) { showModelPicker = false; renderAll(); return; }
    if (providerPicker.show) { providerPicker.show = false; renderAll(); return; }
    if (isStreaming) {
      abortController?.abort();
      stopSpinner();
      setStatus("Cancelled");
      renderAll();
    }
    return;
  }

  // Ctrl+N — model picker
  if (s === "\x0e") { openModelPicker(); return; } // Ctrl+N alternate

  // Slash command suggestions navigation
  const suggests = getSuggestions(inputBuffer);
  if (suggests.length > 0) {
    if (hex === "1b5b41" || hex === "1b4f41") { // Up
      cmdSuggestIdx = cmdSuggestIdx <= 0 ? suggests.length - 1 : cmdSuggestIdx - 1;
      renderAll(); return;
    }
    if (hex === "1b5b42" || hex === "1b4f42") { // Down
      cmdSuggestIdx = cmdSuggestIdx >= suggests.length - 1 ? 0 : cmdSuggestIdx + 1;
      renderAll(); return;
    }
    if (hex === "09") { // Tab
      const selected = suggests[cmdSuggestIdx]?.name;
      if (selected) {
        inputBuffer = selected + " ";
        cursorPos = inputBuffer.length;
        renderAll();
      }
      return;
    }
    if (hex === "0d" || hex === "0a") { // Enter
      const selected = suggests[cmdSuggestIdx]?.name;
      if (selected && inputBuffer !== selected) {
        inputBuffer = selected;
        cursorPos = inputBuffer.length;
        // fall through to normal Enter handler
      }
    }
  }

  // Tab — toggle mode (only if not autocompleting)
  if (hex === "09") {
    agentMode = agentMode === "Build" ? "Plan" : "Build";
    setStatus("Mode: " + agentMode);
    renderAll();
    return;
  }

  // ? — help
  if (s === "?" && inputBuffer === "") {
    showHelp = !showHelp;
    renderAll();
    return;
  }

  // Page Up/Down — scroll
  if (hex === "1b5b357e") { scrollOffset += 5; renderAll(); return; } // PgUp
  if (hex === "1b5b367e") { scrollOffset = Math.max(0, scrollOffset - 5); renderAll(); return; } // PgDn
  if (hex === "1b5b41") { scrollOffset++; renderAll(); return; } // Up arrow (scroll)
  if (hex === "1b5b42") { scrollOffset = Math.max(0, scrollOffset - 1); renderAll(); return; } // Down arrow

  // Enter — send message (handle both \r and \n)
  if (hex === "0d" || hex === "0a") {
    if (isStreaming) return;
    const text = inputBuffer;
    inputBuffer = "";
    cursorPos = 0;
    cmdSuggestIdx = 0;
    setStatus("");
    renderAll();
    if (text.trim()) sendMessage(text);
    return;
  }

  // Backspace
  if (hex === "7f" || hex === "08") {
    if (cursorPos > 0) {
      inputBuffer = inputBuffer.slice(0, cursorPos - 1) + inputBuffer.slice(cursorPos);
      cursorPos--;
      cmdSuggestIdx = 0;
      renderAll();
    }
    return;
  }

  // Delete key
  if (hex === "1b5b337e") {
    if (cursorPos < inputBuffer.length) {
      inputBuffer = inputBuffer.slice(0, cursorPos) + inputBuffer.slice(cursorPos + 1);
      cmdSuggestIdx = 0;
      renderAll();
    }
    return;
  }

  // Readline Navigation Shortcuts:
  // Ctrl+A — beginning of line
  if (hex === "01" || s === "\x01") { cursorPos = 0; renderAll(); return; }
  // Ctrl+E — end of line
  if (hex === "05" || s === "\x05") { cursorPos = inputBuffer.length; renderAll(); return; }
  // Ctrl+K — kill text from cursor to end of line
  if (hex === "0b" || s === "\x0b") { inputBuffer = inputBuffer.slice(0, cursorPos); cmdSuggestIdx = 0; renderAll(); return; }
  // Ctrl+U — clear entire input line
  if (hex === "15" || s === "\x15") { inputBuffer = ""; cursorPos = 0; cmdSuggestIdx = 0; renderAll(); return; }

  // Ctrl+W — delete word back
  if (hex === "17") {
    const before = inputBuffer.slice(0, cursorPos);
    const after = inputBuffer.slice(cursorPos);
    const trimmed = before.replace(/\S+\s*$/, "");
    inputBuffer = trimmed + after;
    cursorPos = trimmed.length;
    cmdSuggestIdx = 0;
    renderAll();
    return;
  }

  // Shift+Enter / Ctrl+J — newline in input
  if (hex === "0a" || (s.length === 1 && s.charCodeAt(0) === 10)) {
    inputBuffer = inputBuffer.slice(0, cursorPos) + "\n" + inputBuffer.slice(cursorPos);
    cursorPos++;
    renderAll();
    return;
  }

  // Printable characters
  if (s.length === 1 && s.charCodeAt(0) >= 32) {
    inputBuffer = inputBuffer.slice(0, cursorPos) + s + inputBuffer.slice(cursorPos);
    cursorPos++;
    cmdSuggestIdx = 0;
    renderAll();
    return;
  }

  // Multi-byte UTF-8 (emoji, Vietnamese, etc.)
  if (data.length > 1 && !s.startsWith("\x1b")) {
    inputBuffer = inputBuffer.slice(0, cursorPos) + s + inputBuffer.slice(cursorPos);
    cursorPos += s.length;
    cmdSuggestIdx = 0;
    renderAll();
    return;
  }
}

// ─── Exit / Cleanup ──────────────────────────────────────────────────────────
function exitApp() {
  if (spinnerTimer) clearInterval(spinnerTimer);
  restoreTerminal();
  process.stdout.write("Goodbye!\r\n");
  process.exit(0);
}

function handleResize() {
  if (showHelp) showHelp = false; // renderHelp is currently unimplemented
  if (showModelPicker) renderModelPicker();
  if (providerPicker.show) providerPicker.render();
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  initWorkspace();
  // Check gateway
  try {
    const res = await fetch(gatewayUrl + "/api/health", { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error("not ok");
    setStatus("● Connected to " + gatewayUrl);
  } catch {
    setStatus("✖ Cannot reach gateway at " + gatewayUrl + " — start with ./start-all.sh");
  }

  if (!process.argv.includes("--no-splash")) {
    await playSplashAnimation();
  }

  // Load config
  try {
    const cfg = loadConfig();
    if (cfg.defaultModel) currentModel = cfg.defaultModel;
    if (cfg.baseUrl) gatewayUrl = cfg.baseUrl;
  } catch {}

  // Handle session persistence flags (--resume, --session <id>)
  const { resume, sessionId: requestedSessionId } = parseSessionArgs(process.argv.slice(2));
  if (requestedSessionId) {
    const loaded = loadSession(requestedSessionId);
    if (loaded && Array.isArray(loaded.messages)) {
      currentSessionId = loaded.sessionId;
      messages = loaded.messages as Msg[];
      if (loaded.metadata?.model) currentModel = loaded.metadata.model;
      if (loaded.metadata?.agentMode) agentMode = loaded.metadata.agentMode;
      setStatus(`Loaded session: ${currentSessionId}`);
    } else {
      currentSessionId = requestedSessionId;
      setStatus(`New session: ${currentSessionId}`);
    }
  } else if (resume) {
    const lastId = getLastSessionId();
    if (lastId) {
      const loaded = loadSession(lastId);
      if (loaded && Array.isArray(loaded.messages)) {
        currentSessionId = loaded.sessionId;
        messages = loaded.messages as Msg[];
        if (loaded.metadata?.model) currentModel = loaded.metadata.model;
        if (loaded.metadata?.agentMode) agentMode = loaded.metadata.agentMode;
        setStatus(`Resumed session: ${currentSessionId}`);
      }
    }
  }

  // Switch to alt screen, hide cursor, enable bracketed paste mode
  write(T.altOn + T.hide + T.home + T.clearDown + ENABLE_BRACKETED_PASTE);

  // Set raw mode
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  // Handle resize
  process.stdout.on("resize", handleResize);

  // Initial render
  renderAll();

  const pasteParser = new BracketedPasteParser();

  // Read keystrokes — parse byte sequences properly
  process.stdin.on("data", (data: Buffer) => {
    const chunks = pasteParser.parse(data);
    for (const chunk of chunks) {
      if (chunk.type === "paste") {
        inputBuffer = inputBuffer.slice(0, cursorPos) + chunk.content + inputBuffer.slice(cursorPos);
        cursorPos += chunk.content.length;
        cmdSuggestIdx = 0;
        renderAll();
      } else {
        const buf = Buffer.from(chunk.content);
        let i = 0;
        while (i < buf.length) {
          if (buf[i] === 0x1b) {
            // ESC sequence
            if (i + 1 < buf.length && (buf[i+1] === 0x5b || buf[i+1] === 0x4f)) {
              let j = i + 2;
              while (j < buf.length && !((buf[j] >= 0x40 && buf[j] <= 0x7e))) j++;
              handleKey(buf.slice(i, j + 1)); i = j + 1;
            } else if (i + 1 < buf.length) {
              handleKey(buf.slice(i, i + 2)); i += 2;
            } else {
              handleKey(buf.slice(i, i + 1)); i++;
            }
          } else {
            // UTF-8 char
            const b = buf[i];
            let len = 1;
            if ((b & 0xe0) === 0xc0) len = 2;
            else if ((b & 0xf0) === 0xe0) len = 3;
            else if ((b & 0xf8) === 0xf0) len = 4;
            handleKey(buf.slice(i, i + len)); i += len;
          }
        }
      }
    }
  });

  // Cleanup on unexpected exit
  process.on("exit", () => {
    restoreTerminal();
  });

  process.on("SIGTERM", exitApp);
}

export function getInputState(): { buffer: string; cursor: number } {
  return { buffer: inputBuffer, cursor: cursorPos };
}

export function setInputState(buffer: string, cursor?: number): void {
  inputBuffer = buffer;
  cursorPos = cursor !== undefined ? cursor : buffer.length;
}

export function resetInputState(): void {
  inputBuffer = "";
  cursorPos = 0;
}

export { main, handleKey };
