#!/usr/bin/env bun

import { GatewayClient } from "./lib/gateway";
import { getActiveProviderConfig, getActiveProvider, getActiveBaseUrl, getActiveDefaultModel } from "./providers";
import { dispatchCommand, getAllCommands } from "./commands";
import { AgentRuntime } from "./lib/agentRuntime";
import { printToolStart, printToolEnd } from "./lib/tool-format";
import * as readline from "node:readline";
import { playSplashAnimation } from "./splash";
import { bypassEngine } from "./lib/bypass";

// ─── True color ANSI helpers (Catppuccin Mocha) ──────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  reverse: "\x1b[7m",
  fg: (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`,
  bg: (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`,
};

const color = {
  text: C.fg(205, 214, 244),    // #cdd6f4
  subtext: C.fg(166, 173, 200), // #a6adc8
  blue: C.fg(137, 180, 250),    // #89b4fa
  cyan: C.fg(148, 226, 213),    // #94e2d5
  green: C.fg(166, 227, 161),   // #a6e3a1
  yellow: C.fg(249, 226, 175),  // #f9e2af
  red: C.fg(243, 139, 168),     // #f38ba8
  mauve: C.fg(203, 166, 247),   // #cba6f7
  pink: C.fg(245, 194, 231),    // #f5c2e7
  teal: C.fg(148, 226, 213),    // #94e2d5
  surface: C.bg(49, 50, 68),    // #313244
  base: C.bg(30, 30, 46),       // #1e1e2e
  overlay: C.bg(69, 71, 90),    // #45475a
};

function print(msg: string) {
  process.stdout.write(msg + C.reset + "\n");
}

function printError(msg: string) {
  process.stderr.write(color.red + msg + C.reset + "\n");
}

// ─── Terminal width ──────────────────────────────────────────────────────

function termWidth(): number {
  return process.stdout.columns || 80;
}

// ─── Markdown renderer ───────────────────────────────────────────────────

function escapeAttr(s: string): string {
  return s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderInline(md: string): string {
  let s = md;
  // Inline code: `code`
  s = s.replace(/`([^`]+)`/g, (_m, code) => {
    return C.bg(49, 50, 68) + C.fg(243, 139, 168) + " " + code + " " + C.reset;
  });
  // Bold: **text**
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, t) => C.bold + t + C.reset);
  // Italic: *text*
  s = s.replace(/\*([^*]+)\*/g, (_m, t) => C.italic + t + C.reset);
  // Links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) => {
    return C.underline + color.blue + text + C.reset + C.dim + " (" + url + ")" + C.reset;
  });
  return s;
}

function renderHeader(line: string, w: number): string {
  const level = line.match(/^#{1,6}/)?.[0].length || 0;
  const text = line.slice(level).trim();
  const prefix = "─".repeat(Math.max(0, (w - text.length - 4) / 2));
  const headerColor = level <= 1 ? color.cyan : level === 2 ? color.blue : color.subtext;
  const boldStyle = level <= 2 ? C.bold : C.reset;
  return (
    C.dim + prefix + " " + C.reset +
    boldStyle + headerColor + text + C.reset +
    " " + C.dim + prefix + C.reset
  );
}

function renderCodeBlock(lines: string[], lang: string, w: number): string {
  const innerW = Math.min(w, 120) - 4;
  const topBorder = "╭" + "─".repeat(innerW + 2) + "╮";
  const bottomBorder = "╰" + "─".repeat(innerW + 2) + "╯";
  const langTag = lang ? ` ${lang} ` : " <code> ";
  const out: string[] = [];
  out.push(C.dim + topBorder + C.reset);
  if (lang) {
    out.push(C.dim + "│" + C.reset + " " + color.subtext + C.italic + langTag + C.reset + " ".repeat(Math.max(0, innerW - langTag.length + 1)) + C.dim + "│" + C.reset);
  }

  for (const line of lines) {
    // Handle diff-style lines inside code blocks
    let display = line;
    let prefix = " ";
    let pfxColor = "";
    if (line.startsWith("+") && !line.startsWith("+++")) {
      prefix = "+";
      pfxColor = color.green;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      prefix = "-";
      pfxColor = color.red;
    } else if (line.startsWith("@")) {
      prefix = "@";
      pfxColor = color.cyan;
    }

    if (pfxColor) {
      const truncated = display.length > innerW ? display.slice(0, innerW - 3) + "..." : display;
      display = truncated;
      out.push(
        C.dim + "│" + C.reset +
        " " + pfxColor + C.bold + prefix + C.reset +
        " " + color.text + display.slice(1) + C.reset +
        " ".repeat(Math.max(0, innerW - display.length + 1)) + C.dim + "│" + C.reset
      );
    } else {
      const truncated = display.length > innerW ? display.slice(0, innerW) + "…" : display;
      out.push(
        C.dim + "│" + C.reset + " " +
        color.text + truncated + C.reset +
        " ".repeat(Math.max(0, innerW - truncated.length + 1)) + C.dim + "│" + C.reset
      );
    }
  }

  out.push(C.dim + bottomBorder + C.reset);
  return out.join("\n");
}

function renderTableRow(line: string, w: number): string {
  const sep = line.match(/^\|[\s:-]+\|/) ? true : false;
  if (sep) {
    return C.dim + line.replace(/\|/g, "+") + C.reset;
  }
  const cells = line.split("|").filter(Boolean);
  return " " + C.dim + "│" + C.reset + " " + cells.map(c => renderInline(c.trim())).join(" " + C.dim + "│" + C.reset + " ") + " " + C.dim + "│" + C.reset;
}

function renderMarkdown(text: string): string {
  const w = termWidth();
  const lines = text.split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\r$/, "");

    if (inCode) {
      if (line.startsWith("```")) {
        out.push(renderCodeBlock(codeBuf, codeLang, w));
        codeBuf = [];
        inCode = false;
        codeLang = "";
      } else {
        codeBuf.push(line);
      }
      continue;
    }

    if (line.startsWith("```")) {
      inCode = true;
      codeLang = line.slice(3).trim();
      codeBuf = [];
      continue;
    }

    if (/^#{1,6}\s/.test(line)) {
      out.push(renderHeader(line, w));
      inList = false;
      continue;
    }

    if (line.startsWith("> ")) {
      out.push(C.dim + "┃ " + C.reset + color.subtext + renderInline(line.slice(2)) + C.reset);
      inList = false;
      continue;
    }

    if (/^\s*[-*]\s/.test(line)) {
      out.push("  " + color.yellow + "●" + C.reset + " " + renderInline(line.replace(/^\s*[-*]\s/, "")));
      inList = true;
      continue;
    }

    if (/^\s*\d+[.)]\s/.test(line)) {
      const num = line.match(/^\s*(\d+)[.)]/)?.[1] || "";
      out.push("  " + color.yellow + num + "." + C.reset + " " + renderInline(line.replace(/^\s*\d+[.)]\s/, "")));
      inList = true;
      continue;
    }

    if (/^\|.+\|$/.test(line)) {
      out.push(renderTableRow(line, w));
      inList = false;
      continue;
    }

    if (/^---+\s*$/.test(line)) {
      out.push(C.dim + "─".repeat(w) + C.reset);
      inList = false;
      continue;
    }

    // Regular paragraph
    if (line === "") {
      if (!inList) out.push("");
      inList = false;
      continue;
    }

    out.push(renderInline(line));
    inList = false;
  }

  // Flush remaining code block
  if (inCode && codeBuf.length > 0) {
    out.push(renderCodeBlock(codeBuf, codeLang, w));
  }

  return out.join("\n");
}

// ─── Spinner ─────────────────────────────────────────────────────────────

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  // Only use spinner when stderr is a real TTY to avoid corrupting Termius/mobile SSH sessions
  const useSpin = process.stderr.isTTY;
  let i = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  if (useSpin) {
    interval = setInterval(() => {
      process.stderr.write(
        "\r" + color.cyan + spinnerFrames[i % spinnerFrames.length] + C.reset + " " + label
      );
      i++;
    }, 100);
  } else {
    process.stderr.write(label + "...\n");
  }
  try {
    return await fn();
  } finally {
    if (interval) {
      clearInterval(interval);
      process.stderr.write("\r\x1b[K");
    }
  }
}

// ─── Chat-style message display ──────────────────────────────────────────

function renderSeparator(role: "user" | "assistant" | "system", model?: string): string {
  const w = Math.min(termWidth(), 80);
  const label = role === "user" ? " BẠN " : role === "system" ? " HỆ THỐNG " : ` TOOLNET${model ? " (" + model + ")" : ""} `;
  const labelWidth = [...label].length;
  const dashes = "─".repeat(Math.max(2, w - labelWidth - 2));
  const roleColor = role === "user" ? color.yellow : role === "system" ? color.mauve : color.cyan;
  return (
    C.dim + "╶──" + C.reset +
    roleColor + C.bold + label + C.reset +
    C.dim + dashes + "╴" + C.reset
  );
}

function displayChatMessage(role: "user" | "assistant" | "system", content: string, model?: string) {
  print("");
  print(renderSeparator(role, model));
  if (content) {
    // If already has ANSI (from command output), pass through
    if (content.includes("\x1b[")) {
      print(content);
    } else {
      print(renderMarkdown(content));
    }
  }
}

// ─── API call ────────────────────────────────────────────────────────────

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
}

interface ChatChunk {
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
}

async function streamChat(
  gw: GatewayClient,
  model: string,
  messages: ChatMessage[],
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<{ fullText: string; model: string }> {
  const url = gw.getBaseUrl() + "/v1/chat/completions";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model.includes("/") || model.includes(":") ? model : model,
      messages,
      stream: true,
    } satisfies ChatRequest),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    let errMsg = `HTTP ${res.status}`;
    try { const j = JSON.parse(text); errMsg = j.error?.message || j.error || errMsg; } catch {}
    throw new Error(errMsg);
  }

  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let responseModel = model;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (trimmed === "data: [DONE]") break;

      if (trimmed.startsWith("data: ")) {
        try {
          const json = JSON.parse(trimmed.slice(6)) as ChatChunk;
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            onToken(delta);
          }
          if (json.choices?.[0]?.finish_reason) {
            responseModel = (json as any).model || responseModel;
          }
        } catch {}
      }
    }
  }

  return { fullText, model: responseModel };
}

// ─── Tab completion ──────────────────────────────────────────────────────

function makeCompleter(commands: string[]) {
  return (line: string): [string[], string] => {
    const trimmed = line.trimStart();
    const prefix = line.slice(0, line.length - trimmed.length);
    if (trimmed.startsWith("/")) {
      const partial = trimmed;
      const hits = commands.filter(c => "/" + c.startsWith(partial));
      return [hits.length ? hits.map(c => prefix + "/" + c) : [], line];
    }
    return [[], line];
  };
}

// ─── Main ────────────────────────────────────────────────────────────────

export async function main() {
  // Check provider configuration
  const providerConfig = getActiveProviderConfig();
  const provider = getActiveProvider();
  const baseUrl = getActiveBaseUrl();
  let gw: GatewayClient | null = null;
  let version = "";

  if (providerConfig?.id === "toolnet" && baseUrl) {
    gw = new GatewayClient(baseUrl);
    const health = await withSpinner("Checking ToolNet gateway...", () => gw!.health());
    if (health.success) {
      const versionResult = await gw.getVersion();
      version = versionResult.success ? versionResult.data?.currentVersion || "" : "";
    }
  } else if (provider?.health) {
    await withSpinner("Checking provider...", () => provider.health!());
  }

  await playSplashAnimation();

  print("");
  print(C.bold + color.cyan + "  ╭━━━╮╭╮╭━╮╭━╮╭━┳╮╭━┳━╮" + C.reset);
  print(C.bold + color.cyan + "  ┃╭━╮┃┃┃┃╭╯┃╭┫┃┃┃┃┃┃╭╯" + C.reset);
  print(C.bold + color.cyan + "  ┃╰━╯┃┃╰╯╯┃╰╯┃┃┃┃┃┃┃╰╮" + C.reset);
  print(C.bold + color.cyan + "  ┃╭━━╯┃╭╮┃┃╭╮┃╰╯╰╯┃┃╭╯" + C.reset);
  print(C.bold + color.cyan + "  ┃┃   ┃┃┃┃┃┃┃┃╰╮╭╮┃┃╰╮" + C.reset);
  print(C.bold + color.cyan + "  ╰╯   ╰╯╰╯╰╯╰╯ ╰╯╰╯╰━╯" + C.reset + "  " + color.subtext + "v" + (version || "?") + C.reset);
  print(color.subtext + "  AI Coding Agent" + C.reset);
  const currentModel_default = getActiveDefaultModel() || "";
  print("");
  if (providerConfig) {
    print(color.green + `  ✔ Provider: ${providerConfig.name} (${providerConfig.baseUrl})` + C.reset);
  } else {
    print(color.yellow + "  ⚠ Provider: Not configured — use /provider add to set one up" + C.reset);
  }
  print(color.subtext + "  Model: " + C.bold + (currentModel_default || "none") + C.reset + color.subtext + "  |  Type a message and press Enter  |  /help for commands  |  /exit to quit" + C.reset);
  print("");
  print(color.yellow + "  ─────────────────────────────────────────────────────" + C.reset);
  print("");

  const messages: ChatMessage[] = [];
  let currentModel = currentModel_default;

  const addMessage = (role: "user" | "assistant" | "system", content: string, model?: string) => {
    if (content) {
      messages.push({ role, content });
    }
    displayChatMessage(role, content, model);
  };

  const setModel = (model: string) => {
    currentModel = model;
  };

  const commandNames = getAllCommands().map(c => c.name);

  const getPromptString = () => {
    const bp = bypassEngine.isEnabled() ? `\x1b[31m[Bypass:${bypassEngine.getLevel()}]\x1b[0m ` : "";
    return bp + color.teal + "▸ " + C.reset;
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: getPromptString(),
    historySize: 100,
    completer: makeCompleter(commandNames),
  });

  bypassEngine.onConfigChange(() => {
    rl.setPrompt(getPromptString());
  });

  process.stdin.resume();
  rl.prompt();

  rl.on("line", async (line: string) => {
    const v = line.trim();
    if (!v) {
      rl.prompt();
      return;
    }

    if (v.startsWith("/")) {
      const ctx = {
        gateway: gw,
        addMessage: (role: "user" | "assistant" | "system", c: string) => addMessage(role, c),
        setModel,
        setStatusMsg: (_msg: string) => {},
        exit: () => {
          print(color.subtext + "Goodbye!" + C.reset);
          rl.close();
          process.exit(0);
        },
        currentModel: () => currentModel,
        setBypassMode: (enabled: boolean, level?: string) => {
          bypassEngine.setBypass(enabled, level as any);
          rl.setPrompt(getPromptString());
        },
      };

      await dispatchCommand(v, ctx);
    } else {
      // Non-command: send to model via AgentRuntime ReAct Loop
      addMessage("user", v);
      print("");
      print(renderSeparator("assistant", currentModel));

      try {
        const runtime = new AgentRuntime({
          baseUrl: gw?.getBaseUrl() || getActiveBaseUrl() || "",
          model: currentModel,
          onEvent: (event, data) => {
            if (event === "TOOL_START") {
              if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
              const str = printToolStart(data.toolName, data.toolArgs);
              process.stdout.write("\x1b[2K\r" + str);
            } else if (event === "TOOL_END") {
              let parsedResult = data.result;
              if (typeof data.result === "string") {
                try { parsedResult = JSON.parse(data.result); } catch {}
              }
              const isError = parsedResult && (parsedResult.error || (parsedResult.exitCode !== undefined && parsedResult.exitCode !== 0));
              const str = printToolEnd(data.toolName, data.toolArgs, !isError);
              process.stdout.write("\x1b[2K\r" + str + "\n");
              
              const verbose = process.env.TOOLNET_DEBUG === "1" || process.argv.includes("--verbose");
              if (verbose && parsedResult) {
                let debugOut = typeof parsedResult === "string" ? parsedResult : JSON.stringify(parsedResult);
                if (debugOut.length > 200) debugOut = debugOut.substring(0, 200) + "...";
                print(C.dim + "    " + debugOut + C.reset);
              }
            }
          }
        });

        const res = await withSpinner("Thinking...", () => runtime.runLoop(messages, { model: currentModel }));
        if (!res.success && res.error) {
          printError("\nError: " + res.error);
        } else {
          print("\n" + renderMarkdown(res.output));
        }
      } catch (err) {
        printError("\nError: " + (err instanceof Error ? err.message : String(err)));
      }
    }

    print("");
    rl.prompt();
  });

  rl.on("close", () => {
    print("");
    process.exit(0);
  });
}

// Auto-run when loaded directly
if (import.meta.main) {
  main().catch((err) => {
    printError("Fatal: " + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}
