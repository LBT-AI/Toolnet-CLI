import { createSignal, For, Show, createMemo, onCleanup } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { exitTui } from "../exit";
import { getGateway } from "../lib/gateway";
import { dispatchCommand, getAllCommands } from "../commands";
import {
  getSessions,
  getCurrentSession,
  getCurrentIndex,
  switchSession,
  newSession,
  removeSession,
  initSessions,
  onSessionsChange,
  addMessage as sessionAddMessage,
  setModel as sessionSetModel,
} from "../lib/session";
import { canUndo, canRedo, onHistoryChange, undo as undoHistory, redo as redoHistory } from "../lib/history";
import { TeamworkDashboard } from "../teamwork/dashboard";

const B = TextAttributes.BOLD;
const I = TextAttributes.ITALIC;

// ─── Theme ───────────────────────────────────────────────────────────────

const T = {
  base:       "#1e1e2e",
  surface:    "#313244",
  overlay:    "#45475a",
  text:       "#cdd6f4",
  subtext:    "#a6adc8",
  blue:       "#89b4fa",
  cyan:       "#94e2d5",
  green:      "#a6e3a1",
  yellow:     "#f9e2af",
  red:        "#f38ba8",
  mauve:      "#cba6f7",
  pink:       "#f5c2e7",
  teal:       "#94e2d5",
  peach:      "#fab387",
};

// ─── Syntax highlighting ─────────────────────────────────────────────────

const SYNTAX_COLORS: Record<string, [string, RegExp][]> = {
  js: [
    [T.mauve, /\b(const|let|var|function|return|import|export|from|async|await|if|else|for|while|class|new|throw|try|catch|finally|typeof|instanceof|this|super|yield|static|get|set)\b/g],
    [T.teal, /\b(console|Math|JSON|Promise|Array|Object|String|Number|Map|Set|Symbol)\b/g],
    [T.green, /\/\/.*$/gm],
    [T.peach, /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`/g],
    [T.yellow, /\b(\d+\.?\d*)\b/g],
  ],
  ts: [
    [T.mauve, /\b(const|let|var|function|return|import|export|from|async|await|if|else|for|while|class|new|throw|try|catch|finally|typeof|instanceof|this|super|yield|static|get|set|interface|type|enum|implements|extends)\b/g],
    [T.cyan, /\b(string|number|boolean|void|any|never|unknown|undefined|null|Record|Partial|Required|Pick|Omit|Promise|Array)\b/g],
    [T.teal, /\b(console|Math|JSON|Promise|Array|Object)\b/g],
    [T.green, /\/\/.*$/gm],
    [T.peach, /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`/g],
    [T.yellow, /\b(\d+\.?\d*)\b/g],
  ],
  py: [
    [T.mauve, /\b(def|class|return|import|from|if|elif|else|for|while|try|except|finally|with|as|pass|break|continue|and|or|not|in|is|lambda|yield|raise|self|True|False|None|async|await)\b/g],
    [T.teal, /\b(print|len|range|type|int|str|float|list|dict|set|tuple|open|map|filter|zip|enumerate|sorted|reversed|super)\b/g],
    [T.green, /#.*$/gm],
    [T.peach, /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g],
    [T.yellow, /\b(\d+\.?\d*)\b/g],
  ],
  go: [
    [T.mauve, /\b(func|return|import|package|if|else|for|range|switch|case|default|break|continue|go|defer|select|chan|map|struct|interface|type|var|const|new|make|append|len|cap|nil|true|false|error|string|int|bool|byte|rune|float64)\b/g],
    [T.green, /\/\/.*$/gm],
    [T.peach, /"([^"\\]|\\.)*"/g],
  ],
  rust: [
    [T.mauve, /\b(fn|let|mut|return|if|else|for|while|loop|match|break|continue|impl|struct|enum|trait|pub|use|mod|crate|self|super|where|as|in|ref|move|dyn|async|await|unsafe|true|false|Some|None|Ok|Err)\b/g],
    [T.cyan, /\b(i32|i64|u32|u64|f32|f64|bool|char|str|String|Vec|HashMap|Option|Result|Box|Rc|Arc|RefCell)\b/g],
    [T.green, /\/\/.*$|\/\/!.*$/gm],
    [T.peach, /"([^"\\]|\\.)*"/g],
  ],
  bash: [
    [T.mauve, /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|export|local|source|eval|exec|set|unset|trap)\b/g],
    [T.green, /#.*$/gm],
    [T.peach, /"([^"\\]|\\.)*"/g],
  ],
  html: [[T.blue, /<\/?[\w-]+[\s\S]*?>/g], [T.peach, /"([^"\\]|\\.)*"/g], [T.green, /<!--[\s\S]*?-->/g]],
  css: [
    [T.mauve, /\b(@import|@media|@keyframes|@font-face|@supports)\b/g],
    [T.yellow, /\b([\w-]+)\s*:/g],
    [T.teal, /\b(#[\da-fA-F]{3,8})\b/g],
    [T.peach, /"([^"\\]|\\.)*"/g],
    [T.green, /\/\*[\s\S]*?\*\//g],
  ],
  json: [
    [T.peach, /"([^"\\]|\\.)*"\s*:/g],
    [T.teal, /"([^"\\]|\\.)*"(?=\s*[,}\]])/g],
    [T.yellow, /\b(true|false|null)\b/g],
    [T.yellow, /\b(\d+\.?\d*)\b/g],
  ],
  default: [
    [T.peach, /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`/g],
    [T.green, /\/\/.*$|#.*$/gm],
    [T.yellow, /\b(\d+\.?\d*)\b/g],
  ],
};

function highlightCode(code: string, lang: string): { text: string; fg: string }[][] {
  const rules = SYNTAX_COLORS[lang] || SYNTAX_COLORS.default;
  const lines = code.split("\n");
  return lines.map((line) => {
    const segments: { text: string; fg: string }[] = [{ text: line, fg: T.text }];
    for (const [color, regex] of rules) {
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i];
        if (seg.fg !== T.text) continue;
        const matches: { index: number; text: string }[] = [];
        let m: RegExpExecArray | null;
        regex.lastIndex = 0;
        while ((m = regex.exec(seg.text)) !== null) {
          matches.push({ index: m.index, text: m[0] });
        }
        if (matches.length === 0) continue;
        const parts: { text: string; fg: string }[] = [];
        let lastEnd = 0;
        for (const match of matches) {
          if (match.index > lastEnd) parts.push({ text: seg.text.slice(lastEnd, match.index), fg: T.text });
          parts.push({ text: match.text, fg: color });
          lastEnd = match.index + match.text.length;
        }
        if (lastEnd < seg.text.length) parts.push({ text: seg.text.slice(lastEnd), fg: T.text });
        segments.splice(i, 1, ...parts);
      }
    }
    return segments;
  });
}

// ─── Message parser ──────────────────────────────────────────────────────

interface MsgSegment {
  type: "text" | "code";
  content: string;
  lang?: string;
  highlighted?: { text: string; fg: string }[][];
}

function parseMessage(content: string): MsgSegment[] {
  const segs: MsgSegment[] = [];
  let i = 0;
  while (i < content.length) {
    const codeStart = content.indexOf("```", i);
    if (codeStart === -1) { segs.push({ type: "text", content: content.slice(i) }); break; }
    if (codeStart > i) segs.push({ type: "text", content: content.slice(i, codeStart) });
    const codeEnd = content.indexOf("```", codeStart + 3);
    if (codeEnd === -1) { segs.push({ type: "text", content: content.slice(codeStart) }); break; }
    const firstLineEnd = content.indexOf("\n", codeStart + 3);
    let lang = "", codeContent: string;
    if (firstLineEnd !== -1 && firstLineEnd < codeEnd) {
      lang = content.slice(codeStart + 3, firstLineEnd).trim();
      codeContent = content.slice(firstLineEnd + 1, codeEnd);
    } else {
      codeContent = content.slice(codeStart + 3, codeEnd);
    }
    segs.push({ type: "code", content: codeContent, lang, highlighted: highlightCode(codeContent, lang) });
    i = codeEnd + 3;
  }
  return segs;
}

function renderInline(text: string): { text: string; fg?: string; attr?: number }[] {
  const parts: { text: string; fg?: string; attr?: number }[] = [];
  let i = 0;
  while (i < text.length) {
    const bm = text.slice(i).match(/^\*\*([^*]+)\*\*/);
    if (bm) { parts.push({ text: bm[1], attr: B }); i += bm[0].length; continue; }
    const im = text.slice(i).match(/^\*([^*]+)\*/);
    if (im) { parts.push({ text: im[1], attr: I }); i += im[0].length; continue; }
    const cm = text.slice(i).match(/^`([^`]+)`/);
    if (cm) { parts.push({ text: cm[1], fg: T.peach, attr: B }); i += cm[0].length; continue; }
    const lm = text.slice(i).match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (lm) { parts.push({ text: lm[1], fg: T.blue, attr: B }); i += lm[0].length; continue; }
    parts.push({ text: text[i] }); i++;
  }
  return parts;
}

// ─── Toast notification system ───────────────────────────────────────────

interface Toast { id: number; message: string; type: "info" | "success" | "error" | "warning"; }
let toastId = 0;

// ─── Help dialog ─────────────────────────────────────────────────────────

function HelpDialog(props: { onClose: () => void }) {
  const commands = getAllCommands();
  return (
    <box flexDirection="column" width="100%" height="100%" justifyContent="center" alignItems="center" paddingLeft={10} paddingRight={10}>
      <box flexDirection="column" width="70%" maxWidth={80} borderStyle="double" borderColor={T.yellow} backgroundColor={T.base}>
        <box paddingTop={1} paddingLeft={2} paddingRight={2}>
          <text fg={T.yellow} attributes={B}>TOOLNET — Commands</text>
        </box>
        <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <For each={commands}>
            {(cmd) => (
              <box flexDirection="row" marginBottom={0}>
                <text fg={T.cyan} attributes={B} width={16}>{"/" + cmd.name}</text>
                <text fg={T.subtext}>{cmd.description}</text>
              </box>
            )}
          </For>
        </box>
        <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
          <text fg={T.subtext}>Press </text><text fg={T.yellow}>?</text><text fg={T.subtext}> or </text><text fg={T.yellow}>Esc</text><text fg={T.subtext}> to close</text>
        </box>
      </box>
    </box>
  );
}

// ─── Command palette ─────────────────────────────────────────────────────

function CommandPalette(props: { onClose: () => void; onRun: (cmd: string) => void }) {
  const commands = getAllCommands();
  const [query, setQuery] = createSignal("");
  const [selectedIdx, setSelectedIdx] = createSignal(0);
  let inputEl: any = null;

  const filtered = createMemo(() => {
    const q = query().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.name.includes(q) || c.aliases.some((a) => a.includes(q)) || c.description.toLowerCase().includes(q)
    );
  });

  const handleKey = (key: any) => {
    if (key.name === "escape") { props.onClose(); return; }
    if (key.name === "enter" || key.name === "return") {
      const sel = filtered()[selectedIdx()];
      if (sel) { props.onRun("/" + sel.name); props.onClose(); }
      return;
    }
    if (key.name === "arrowup") { setSelectedIdx(Math.max(0, selectedIdx() - 1)); return; }
    if (key.name === "arrowdown") { setSelectedIdx(Math.min(filtered().length - 1, selectedIdx() + 1)); return; }
  };

  return (
    <box flexDirection="column" width="100%" height="100%" justifyContent="center" alignItems="center" paddingLeft={15} paddingRight={15}>
      <box flexDirection="column" width="50%" maxWidth={60} maxHeight="60%" borderStyle="double" borderColor={T.blue} backgroundColor={T.base}>
        <box paddingTop={1} paddingLeft={1} paddingRight={1}>
          <input
            ref={(el: any) => { inputEl = el; setTimeout(() => el?.focus?.()); }}
            focused={true}
            value={query()}
            onInput={(v: string) => { setQuery(v); setSelectedIdx(0); }}
            onKeyDown={handleKey}
            placeholder="Search commands..."
            width="100%"
          />
        </box>
        <scrollbox flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={0} paddingBottom={1}>
          <For each={filtered()}>
            {(cmd, i) => (
              <box
                flexDirection="row"
                backgroundColor={i() === selectedIdx() ? T.surface : undefined}
                onMouseDown={() => { props.onRun("/" + cmd.name); props.onClose(); }}
              >
                <text fg={i() === selectedIdx() ? T.blue : T.cyan} attributes={B} width={16}>
                  {"/" + cmd.name}
                </text>
                <text fg={T.subtext}>{cmd.description}</text>
              </box>
            )}
          </For>
        </scrollbox>
        <box paddingLeft={1} paddingRight={1} paddingBottom={1}>
          <text fg={T.subtext}>↵: run  Esc: close  ↑↓: navigate</text>
        </box>
      </box>
    </box>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────

function Sidebar() {
  const gateway = getGateway();
  const session = createMemo(() => getCurrentSession());
  const msgs = createMemo(() => session().messages);

  return (
    <box
      flexDirection="column"
      width={26}
      borderStyle="single"
      borderColor={T.overlay}
      backgroundColor={T.surface}
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="column" paddingTop={1} paddingBottom={1}>
        <text fg={T.peach} attributes={B}>Session</text>
        <text fg={T.subtext}>{session().name}</text>
      </box>
      <box flexDirection="column" paddingBottom={1}>
        <text fg={T.peach} attributes={B}>Model</text>
        <text fg={T.text}>{session().model}</text>
      </box>
      <box flexDirection="column" paddingBottom={1}>
        <text fg={T.peach} attributes={B}>Messages</text>
        <text fg={T.text}>{msgs().length}</text>
      </box>
      <box flexDirection="column" paddingBottom={1}>
        <text fg={T.peach} attributes={B}>Gateway</text>
        <text fg={T.green}>Connected</text>
      </box>
      <box flexDirection="column" paddingBottom={1}>
        <text fg={T.peach} attributes={B}>Keys</text>
        <For each={[
          { key: "Ctrl+P", desc: "Palette" },
          { key: "Ctrl+B", desc: "Sidebar" },
          { key: "Ctrl+M", desc: "Model" },
          { key: "?", desc: "Help" },
          { key: "Ctrl+T", desc: "New session" },
          { key: "Ctrl+W", desc: "Close session" },
          { key: "Tab", desc: "Switch session" },
        ]}>
          {(item) => (
            <box flexDirection="row">
              <text fg={T.yellow} width={9}>{item.key}</text>
              <text fg={T.subtext}>{item.desc}</text>
            </box>
          )}
        </For>
      </box>
    </box>
  );
}

// ─── Welcome screen ──────────────────────────────────────────────────────

function WelcomeScreen(props: { onSend: (text: string) => void }) {
  const suggestions = [
    { label: "/help", desc: "Show commands" },
    { label: "/status", desc: "Gateway status" },
    { label: "/model", desc: "Select model" },
    { label: "/providers list", desc: "List providers" },
  ];

  return (
    <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
      <text fg={T.peach} attributes={B}>ToolNet</text>
      <text fg={T.subtext}>AI Coding Agent Gateway</text>
      <text> </text>
      <text fg={T.text}>Type a message or use a command to start</text>
      <text> </text>
      <box flexDirection="row" flexWrap="wrap" justifyContent="center" paddingLeft={5} paddingRight={5}>
        <For each={suggestions}>
          {(s) => (
            <box
              flexDirection="row"
              marginRight={1}
              marginBottom={1}
              borderStyle="single"
              borderColor={T.overlay}
              paddingLeft={1}
              paddingRight={1}
              onMouseDown={() => props.onSend(s.label)}
              backgroundColor={T.surface}
            >
              <text fg={T.cyan} attributes={B}>{s.label}</text>
              <text fg={T.subtext}>  {s.desc}</text>
            </box>
          )}
        </For>
      </box>
    </box>
  );
}

// ─── Error boundary ──────────────────────────────────────────────────────

function ErrorFallback(props: { error: Error | null; onRetry: () => void }) {
  return (
    <box flexDirection="column" width="100%" height="100%" justifyContent="center" alignItems="center" backgroundColor={T.base} paddingLeft={5} paddingRight={5}>
      <text fg={T.red} attributes={B}>Something went wrong</text>
      <text> </text>
      <text fg={T.subtext}>{props.error?.message || "Unknown error"}</text>
      <text> </text>
      <box
        borderStyle="single"
        borderColor={T.blue}
        paddingLeft={2} paddingRight={2}
        onMouseDown={props.onRetry}
      >
        <text fg={T.blue}>Retry</text>
      </box>
      <text> </text>
      <box
        borderStyle="single"
        borderColor={T.overlay}
        paddingLeft={2} paddingRight={2}
        onMouseDown={() => exitTui()}
      >
        <text fg={T.subtext}>Exit</text>
      </box>
    </box>
  );
}

// ─── Navigation hints ────────────────────────────────────────────────────

function navHints(isStreaming: boolean, hasDialog: boolean): string {
  if (hasDialog) return "↑↓:navigate  ↵:select  Esc:close";
  if (isStreaming) return "Esc:cancel stream  ^C:stop";
  return "↵:send  ?:help  ^B:sidebar  ^P:palette  ^M:model  Tab:sessions";
}

// ─── Main ChatScreen ─────────────────────────────────────────────────────

let lastCtrlC = 0;
let abortController: AbortController | null = null;

export function ChatScreen() {
  const gateway = getGateway();
  initSessions();

  const [messages, setMessages] = createSignal(getCurrentSession().messages);
  const [sessions, setSessions] = createSignal(getSessions());
  const [currentIdx, setCurrentIdx] = createSignal(getCurrentIndex());
  const [inputValue, setInputValue] = createSignal("");
  const [isStreaming, setIsStreaming] = createSignal(false);
  const [selectedModel, setSelectedModel] = createSignal(getCurrentSession().model);
  const [statusMsg, setStatusMsg] = createSignal("");
  const [showHelp, setShowHelp] = createSignal(false);
  const [showModels, setShowModels] = createSignal(false);
  const [showPalette, setShowPalette] = createSignal(false);
  const [showSidebar, setShowSidebar] = createSignal(false);
  const [models, setModels] = createSignal<{ id: string; owned_by?: string }[]>([]);
  const [error, setError] = createSignal<Error | null>(null);
  const [tick, setTick] = createSignal(0);

  let currentSpinnerTimer: ReturnType<typeof setInterval> | null = null;
  onCleanup(() => {
    if (currentSpinnerTimer) clearInterval(currentSpinnerTimer);
  });

  let inputRef: any = null;
  let lastSubmittedText = "";
  let lastSubmitTime = 0;

  const [mode, setMode] = createSignal<"Build" | "Plan">("Build");
  const [spinnerIdx, setSpinnerIdx] = createSignal(0);
  const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  onSessionsChange(() => {
    setSessions([...getSessions()]);
    setCurrentIdx(getCurrentIndex());
    setMessages([...getCurrentSession().messages]);
    setSelectedModel(getCurrentSession().model);
  });

  onHistoryChange(() => setTick((n) => n + 1));

  const canUndoFlag = () => { tick(); return canUndo(); };
  const canRedoFlag = () => { tick(); return canRedo(); };

  const addMessage = (role: "user" | "assistant" | "system", content: string) => {
    sessionAddMessage(role, content);
    setMessages([...getCurrentSession().messages]);
  };

  const setModel = (model: string) => {
    setSelectedModel(model);
    sessionSetModel(model);
    setShowModels(false);
  };

  const exit = () => exitTui();

  const sendToServer = async (text: string) => {
    const v = text.trim();
    if (!v) return;

    const now = Date.now();
    if (v === lastSubmittedText && now - lastSubmitTime < 500) return;
    lastSubmittedText = v;
    lastSubmitTime = now;
    const startTime = Date.now();

    setInputValue("");
    if (inputRef && typeof inputRef.focus === "function") inputRef.focus();

    if (v.startsWith("/")) {
      addMessage("user", v);
      setStatusMsg(`▶ Running command: ${v}`);
      const commandCtx = { gateway, addMessage, setModel, setStatusMsg, exit, currentModel: selectedModel };
      try {
        await dispatchCommand(v, commandCtx);
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        setStatusMsg(`✔ Done in ${duration}s`);
      } catch (e: any) {
        showToast(e?.message || String(e), "error");
        setStatusMsg("Error executing command");
      }
      return;
    }

    addMessage("user", v);
    setIsStreaming(true);
    setStatusMsg("Thinking...");
    abortController = new AbortController();

    if (currentSpinnerTimer) clearInterval(currentSpinnerTimer);
    currentSpinnerTimer = setInterval(() => {
      setSpinnerIdx((i) => (i + 1) % SPINNER_FRAMES.length);
    }, 80);

    try {
      const url = gateway.getBaseUrl() + "/v1/chat/completions";
      const msgs = [...getCurrentSession().messages];

      setStatusMsg("Reading request...");
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: selectedModel(), messages: msgs, stream: true }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        addMessage("assistant", `Error: HTTP ${res.status} — ${errText.slice(0, 200)}`);
        setIsStreaming(false);
        setStatusMsg("Error response from API");
        return;
      }

      if (!res.body) {
        addMessage("assistant", "Error: No response body");
        setIsStreaming(false);
        setStatusMsg("Error: Empty body");
        return;
      }

      setStatusMsg("Streaming response...");
      let fullText = "";
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

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
              const json = JSON.parse(trimmed.slice(6));
              const delta = json.choices?.[0]?.delta?.content;
              if (delta) fullText += delta;
            } catch {}
          }
        }

        if (fullText && fullText.length > 5) {
          sessionAddMessage("assistant", fullText + "▊");
          setMessages([...getCurrentSession().messages]);
        }
      }

      const sess = getCurrentSession();
      if (sess.messages.length > 0 && sess.messages[sess.messages.length - 1].role === "assistant") {
        sess.messages.pop();
      }
      sessionAddMessage("assistant", fullText);
      setMessages([...getCurrentSession().messages]);
      setIsStreaming(false);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      setStatusMsg(`✔ Done in ${elapsed}s`);
      abortController = null;
    } catch (err: any) {
      if (err?.name === "AbortError") {
        addMessage("assistant", "(cancelled)");
        setStatusMsg("Cancelled");
      } else {
        addMessage("assistant", "Error: " + (err?.message || String(err)));
        setStatusMsg("Error");
      }
      setIsStreaming(false);
      abortController = null;
    } finally {
      if (currentSpinnerTimer) clearInterval(currentSpinnerTimer);
    }
  };

  // Toast
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  const showToast = (message: string, type: Toast["type"] = "info", duration = 3000) => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), duration);
  };

  const sendMessageToServer = (value?: string) => {
    const textValue = typeof value === "string" ? value : inputValue();
    sendToServer(textValue || "");
  };

  const hasDialogOpen = () => showHelp() || showModels() || showPalette();

  const handleKeyDown = (key: any) => {
    if (!key) return;
    const pd = () => {
      if (typeof key.preventDefault === "function") key.preventDefault();
      else try { key.defaultPrevented = true; } catch {}
    };

    if (showHelp()) {
      if (key.name === "escape" || key.sequence === "?" || key.name === "?") { pd(); setShowHelp(false); }
      return;
    }
    if (showModels()) {
      if (key.name === "escape") { pd(); setShowModels(false); }
      if (key.name === "enter" || key.name === "return") { pd(); setShowModels(false); }
      return;
    }
    if (showPalette()) return; // palette handles its own keys

    // Error overlay: only allow retry/exit
    if (error()) {
      if (key.name === "escape") { setError(null); }
      return;
    }

    // Esc: close dialogs or cancel stream. NEVER exit program (only /exit exits)
    if (key.name === "escape") {
      pd();
      if (hasDialogOpen()) {
        setShowHelp(false);
        setShowModels(false);
        setShowPalette(false);
        return;
      }
      if (isStreaming()) {
        abortController?.abort();
        setIsStreaming(false);
        setStatusMsg("Cancelled");
        showToast("Stream cancelled", "warning");
        return;
      }
      return;
    }

    const isEnter = key === "\r" || key === "\n" || key.name === "enter" || key.name === "return" || key.sequence === "\r" || key.sequence === "\n";
    if (isEnter) {
      if (key.shift) return;
      pd();
      sendMessageToServer(inputValue());
      if (inputRef && inputRef.editBuffer) { inputRef.editBuffer.text = ""; inputRef.editBuffer.cursor = 0; }
      return;
    }

    if (key.name === "c" && key.ctrl) {
      pd();
      const now = Date.now();
      if (now - lastCtrlC < 2000) exitTui();
      lastCtrlC = now;
      if (isStreaming()) {
        abortController?.abort();
        setIsStreaming(false); setStatusMsg("");
      } else {
        setStatusMsg("Press Ctrl+C twice or /exit to exit");
        setTimeout(() => setStatusMsg(""), 2000);
      }
      return;
    }

    // Ctrl+B: toggle sidebar
    if (key.name === "b" && key.ctrl) { pd(); setShowSidebar(!showSidebar()); return; }

    // Ctrl+P: command palette
    if (key.name === "p" && key.ctrl) { pd(); setShowPalette(true); return; }

    // Tab: toggle Build / Plan mode
    if (key.name === "tab") {
      pd();
      setMode((m) => (m === "Build" ? "Plan" : "Build"));
      showToast(`Switched mode to ${mode()}`, "info");
      return;
    }

    // ? : help
    if (key.sequence === "?" && !key.ctrl && !key.alt) { pd(); setShowHelp(true); return; }

    // Ctrl+K or Ctrl+M : model picker
    if ((key.name === "k" && key.ctrl) || (key.name === "m" && key.ctrl)) {
      pd();
      loadModels();
      setShowModels(true);
      return;
    }

    if (key.name === "z" && key.ctrl) { pd(); undoHistory(); return; }
    if (key.name === "y" && key.ctrl) { pd(); redoHistory(); return; }
    if (key.name === "t" && key.ctrl) { pd(); newSession(); return; }
    if (key.name === "w" && key.ctrl) { pd(); if (getSessions().length > 1) removeSession(getCurrentIndex()); return; }
    if (key.name === "PageUp" || (key.name === "arrowup" && key.ctrl)) { pd(); const idx = getCurrentIndex(); if (idx > 0) switchSession(idx - 1); return; }
    if (key.name === "PageDown" || (key.name === "arrowdown" && key.ctrl)) { pd(); const idx = getCurrentIndex(); if (idx < getSessions().length - 1) switchSession(idx + 1); return; }
    if (key.name === "v" && key.ctrl) return;
  };

  const loadModels = async () => {
    const res = await gateway.getAvailableModels();
    if (res.success && res.data?.data) setModels(res.data.data.filter((m: any) => m.object === "model" || m.id));
  };

  const parseMsgSegments = createMemo(() =>
    messages().map((msg) => ({ role: msg.role, segments: parseMessage(msg.content) }))
  );

  const isFirstLaunch = createMemo(() => messages().length === 0 && sessions().length === 1);
  const isTeamworkActive = createMemo(() => messages().some((m) => m.content.includes("ToolNet Teamwork v2")) || statusMsg().includes("Teamwork"));

  return (
      <box flexDirection="column" width="100%" height="100%" overflow="hidden" backgroundColor={T.base}>
        {/* ── Header ── */}
        <box flexDirection="row" alignItems="center" paddingLeft={1} paddingRight={1} borderStyle="single" borderColor={T.overlay} backgroundColor={T.surface}>
          <text fg={T.peach} attributes={B}>ToolNet</text>
          <text fg={T.subtext}>  </text>
          <For each={sessions()}>
            {(sess, i) => (
              <box flexDirection="row" marginRight={1}>
                <text fg={i() === currentIdx() ? T.peach : T.subtext} attributes={i() === currentIdx() ? B : 0}>
                  {sess.name || `Session ${i() + 1}`}
                </text>
                {i() < sessions().length - 1 ? <text fg={T.overlay}> │</text> : null}
              </box>
            )}
          </For>
          <text fg={T.subtext}> [</text>
          <text fg={T.green} attributes={B}>+</text>
          <text fg={T.subtext}>]</text>
        </box>

        {/* ── Sub-header: model + status ── */}
        <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2} borderStyle="single" borderColor={T.overlay}>
          <box flexDirection="row">
            <text fg={T.cyan} attributes={B}>Model: </text>
            <text fg={T.text}>{selectedModel()}</text>
          </box>
          <box flexDirection="row">
            <text fg={canUndoFlag() ? T.yellow : T.overlay}>Undo</text>
            <text fg={T.overlay}>/</text>
            <text fg={canRedoFlag() ? T.yellow : T.overlay}>Redo</text>
            <text fg={T.overlay}>  </text>
            <text fg={T.subtext}>?</text>
          </box>
        </box>

        {/* ── Main content: messages + optional sidebar ── */}
        <box flexDirection="row" flexGrow={1}>
          {/* Messages area */}
          <Show when={isFirstLaunch()} fallback={
            <box flexDirection="column" flexGrow={1}>
              <TeamworkDashboard />
              <scrollbox flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1} paddingTop={1} stickyScroll={true} stickyStart="bottom">
                <For each={parseMsgSegments()}>
                {(entry) => (
                  <box flexDirection="column" marginBottom={1}>
                    <box flexDirection="row" marginBottom={0} paddingLeft={1}>
                      <text attributes={B} fg={entry.role === "user" ? T.blue : T.green}>
                        {entry.role === "user" ? "  You" : "  ToolNet"}
                      </text>
                    </box>
                    <For each={entry.segments}>
                      {(seg) => (
                        <box flexDirection="column" paddingLeft={2}>
                          {seg.type === "code" ? (
                            <box flexDirection="column" marginTop={0} marginBottom={0}>
                              <box flexDirection="row" borderStyle="single" borderColor={T.overlay} paddingLeft={1} paddingRight={1} backgroundColor={T.surface}>
                                <text fg={T.subtext} attributes={B}>{seg.lang || "code"}</text>
                              </box>
                              <box flexDirection="column" borderStyle="single" borderColor={T.overlay} paddingLeft={2} paddingRight={2} paddingTop={0} paddingBottom={0} backgroundColor={T.surface}>
                                <For each={seg.highlighted}>
                                  {(line) => (
                                    <box flexDirection="row">
                                      <For each={line}>{(span) => <text fg={(span as any).fg} attributes={(span as any).attributes || (span as any).attr || 0}>{(span as any).text}</text>}</For>
                                    </box>
                                  )}
                                </For>
                              </box>
                            </box>
                          ) : (
                            <box flexDirection="row" flexWrap="wrap">
                              <For each={renderInline(seg.content)}>
                                {(span) => <text fg={span.fg || T.text} attributes={span.attr || 0}>{span.text}</text>}
                              </For>
                            </box>
                          )}
                        </box>
                      )}
                    </For>
                  </box>
                )}
              </For>
            </scrollbox>
            </box>
          }>
            <WelcomeScreen onSend={(t) => { addMessage("user", t); }} />
          </Show>

          {/* Sidebar */}
          <Show when={showSidebar()}>
            <Sidebar />
          </Show>
        </box>

        {/* ── Input ── */}
        <box flexDirection="row" borderStyle="single" borderColor={T.overlay} paddingLeft={1} paddingRight={1} backgroundColor={T.surface}>
          <text fg={T.peach} attributes={B}>{"▸ "}</text>
          <input
            ref={(el: any) => (inputRef = el)}
            focused={!hasDialogOpen() && !error()}
            value={inputValue()}
            onInput={(val: string) => setInputValue(val)}
            onSubmit={((event: any) => {
              sendMessageToServer(event.value);
            }) as any}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            width="100%"
          />
        </box>

        {/* ── Footer status bar ── */}
        <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} borderStyle="single" borderColor={T.overlay} backgroundColor={T.surface}>
          <text fg={T.subtext}>{navHints(isStreaming(), hasDialogOpen())}</text>
          <box flexDirection="row">
            <Show when={isStreaming()}>
              <text fg={T.yellow} attributes={B}>{SPINNER_FRAMES[spinnerIdx()]} </text>
              <text fg={T.yellow}>{statusMsg() || "Processing..."}</text>
            </Show>
            <Show when={!isStreaming() && statusMsg()}>
              <text fg={statusMsg().startsWith("Error") ? T.red : statusMsg().startsWith("✔") ? T.green : T.cyan} attributes={B}>{statusMsg()}</text>
            </Show>
            <Show when={!isStreaming() && !statusMsg()}>
              <text fg={T.green} attributes={B}>Ready</text>
            </Show>
          </box>
        </box>

        {/* ── Overlays ── */}
        <Show when={showHelp()}><HelpDialog onClose={() => setShowHelp(false)} /></Show>

        <Show when={showPalette()}>
          <CommandPalette onClose={() => setShowPalette(false)} onRun={(cmd) => sendMessageToServer(cmd)} />
        </Show>

        <Show when={showModels()}>
          <box flexDirection="column" width="100%" height="100%" justifyContent="center" alignItems="center" paddingLeft={10} paddingRight={10}>
            <box flexDirection="column" width="60%" maxWidth={60} maxHeight="60%" borderStyle="double" borderColor={T.blue} backgroundColor={T.base}>
              <box paddingTop={1} paddingLeft={2} paddingRight={2}>
                <text fg={T.blue} attributes={B}>Select Model</text>
              </box>
              <scrollbox flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
                <For each={models()}>
                  {(m) => (
                    <box flexDirection="row" marginBottom={0} onMouseDown={() => setModel(m.id)}>
                      <text fg={m.id === selectedModel() ? T.green : T.text} attributes={m.id === selectedModel() ? B : 0}>
                        {"  "}{m.id === selectedModel() ? "▸ " : "  "}{m.id}
                      </text>
                    </box>
                  )}
                </For>
              </scrollbox>
              <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
                <text fg={T.subtext}>Press Esc to close</text>
              </box>
            </box>
          </box>
        </Show>

        {/* ── Error overlay ── */}
        <Show when={error()}>
          <ErrorFallback error={error()} onRetry={() => setError(null)} />
        </Show>

        {/* ── Toast notifications ── */}
        <Show when={toasts().length > 0}>
          {(() => {
            const last = toasts()[toasts().length - 1];
            if (!last) return null;
            return (
              <box position="absolute" bottom={0} left={0} width="100%" justifyContent="center" paddingBottom={1}>
                <box paddingLeft={2} paddingRight={2} paddingTop={0} paddingBottom={0}
                  backgroundColor={last.type === "error" ? "#3a1a1a" : last.type === "warning" ? "#3a3010" : last.type === "success" ? "#1a3a1a" : T.surface}
                  borderStyle="single"
                  borderColor={last.type === "error" ? T.red : last.type === "warning" ? T.yellow : last.type === "success" ? T.green : T.overlay}>
                  <text fg={last.type === "error" ? T.red : last.type === "warning" ? T.yellow : last.type === "success" ? T.green : T.text}>
                    {last.message}
                  </text>
                </box>
              </box>
            );
          })()}
        </Show>
      </box>
    );
  }
