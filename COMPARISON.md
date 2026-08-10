# ToolNet CLI vs OpenCode — Feature Comparison

> ToolNet CLI là client của **ToolNetAPI gateway** (40+ upstream providers, combo fallback, OAuth, RTK, jailbreak bypass).  
> OpenCode là standalone AI coding agent với backend riêng.  
> So sánh này chỉ tính **CLI/TUI layer**, không tính backend khác biệt.

---

## 1. Core UI Components

| # | Component | OpenCode | ToolNet | Ghi chú |
|---|-----------|----------|---------|---------|
| 1 | Chat message area | ✅ | ✅ | Markdown + syntax highlight 8 languages |
| 2 | Input area | ✅ | ✅ | ToolNet single-line, OpenCode multi-line |
| 3 | Header bar | ✅ | ✅ | ToolNet: session tabs + model |
| 4 | Status bar | ✅ | ✅ | ToolNet: Ready/Streaming/Error |
| 5 | Footer shortcuts bar | ✅ | ✅ | Tab:session ↵:send ?:help ^M:model |
| 6 | Scrollbar | ✅ | ✅ | OpenTUI scrollbox với sticky scroll |
| 7 | Sidebar (tokens, cost, tools) | ✅ | ❌ | **Missing — cần build** |
| 8 | Welcome screen | ✅ | ❌ | ToolNet: ASCII art banner |
| 9 | File attachments bar | ✅ | ❌ | **Missing** |
| 10 | Command palette (Ctrl+P) | ✅ | ❌ | **Missing** |
| 11 | Error boundary | ✅ | ❌ | **Missing — crash toàn bộ TUI nếu lỗi** |
| 12 | Login screen | ✅ | ⚠️ | Implemented nhưng không mount |
| 13 | Model selector overlay | ✅ | ✅ | Ctrl+M |
| 14 | Help overlay | ✅ | ✅ | Phím `?` |
| 15 | Theme picker | ✅ | ❌ | Hardcoded Catppuccin |
| 16 | Which-key menu | ✅ | ❌ | **Missing** |
| 17 | Toast notifications | ✅ | ❌ | **Missing** |
| 18 | Navigation hints | ✅ | ❌ | **Missing** |
| 19 | Session tabs | ✅ | ✅ | Header bar với session names |
| 20 | Permission prompt | ✅ | ❌ | **Missing — không sandboxing** |

**Tổng:** ToolNet có 9/20 Core UI Components. Cần ưu tiên: Sidebar, Error boundary, Permission prompt, Multi-line input.

---

## 2. Dialog / Overlay

| # | Dialog | OpenCode | ToolNet | Ghi chú |
|---|--------|----------|---------|---------|
| 1 | Help dialog | ✅ | ✅ | Phím `?` |
| 2 | Model picker | ✅ | ✅ | Ctrl+M |
| 3 | Session list | ✅ | ✅ | `/session list` |
| 4 | Theme picker | ✅ | ❌ | Hardcoded theme |
| 5 | Agent list | ✅ | ❌ | ToolNet không có agent system |
| 6 | Permission prompt | ✅ | ❌ | **Missing** |
| 7 | Which-key menu | ✅ | ❌ | **Missing** |
| 8 | Command palette | ✅ | ❌ | **Missing** |
| 9 | External editor | ✅ | ❌ | ToolNetAPI không hỗ trợ |
| 10 | Question dialog | ✅ | ⚠️ | `/question` không block input |
| 11 | Session timeline | ✅ | ❌ | **Missing** |
| 12 | Status view | ✅ | ❌ | **Missing** |
| 13 | MCP list | ✅ | ✅ | `/mcp` command |
| 14 | Plugin manager | ✅ | ❌ | ToolNetAPI chưa có plugin system |
| 15 | Autocomplete popup | ✅ | ❌ | **Missing** |

---

## 3. Message Rendering

| # | Tính năng | OpenCode | ToolNet | Ghi chú |
|---|-----------|----------|---------|---------|
| 1 | Markdown formatting | ✅ | ✅ | Headers, list, bold, italic, code, link, quote, table, HR |
| 2 | Syntax highlighting | ✅ | ✅ | 8 languages: JS, TS, Python, Go, Rust, Bash, HTML/CSS, JSON |
| 3 | Code block with background | ✅ | ✅ | Surface background + border + language tag |
| 4 | Inline code | ✅ | ✅ | Peach color + background |
| 5 | Bold / Italic | ✅ | ✅ | BOLD / ITALIC attributes |
| 6 | Links | ✅ | ✅ | Blue + underlined |
| 7 | Blockquotes | ✅ | ✅ | Dim + vertical bar |
| 8 | Lists (ul/ol) | ✅ | ✅ | Yellow bullets / numbers |
| 9 | Tables | ✅ | ✅ | With borders |
| 10 | Horizontal rules | ✅ | ✅ | Dim line |
| 11 | Code block line numbers | ✅ | ❌ | **Missing** |
| 12 | Thinking/reasoning blocks | ✅ | ❌ | Backend chưa expose |
| 13 | File diff rendering | ✅ | ❌ | **Missing — priority** |
| 14 | Tool call visualization | ✅ | ❌ | **Missing** |
| 15 | Image display | ✅ | ❌ | ToolNetAPI không hỗ trợ |
| 16 | Streaming response | ✅ | ✅ | Token-by-token real-time |
| 17 | Progress indicator | ✅ | ✅ | "Streaming..." status |
| 18 | Timestamps | ✅ | ❌ | **Missing** |
| 19 | Message copy | ✅ | ❌ | **Missing** |
| 20 | User/assistant labels | ✅ | ✅ | "You" / "ToolNet" with colors |

---

## 4. Input Features

| # | Tính năng | OpenCode | ToolNet | Ghi chú |
|---|-----------|----------|---------|---------|
| 1 | Send on Enter | ✅ | ✅ | |
| 2 | Multi-line (Shift+Enter) | ✅ | ❌ | **Missing** |
| 3 | @file autocomplete | ✅ | ❌ | **Missing** |
| 4 | ! shell commands | ✅ | ❌ | **Missing** |
| 5 | Slash commands | ✅ | ✅ | 27 commands |
| 6 | History navigation (↑↓) | ✅ | ✅ | |
| 7 | Input undo/redo | ✅ | ❌ | **Missing** |
| 8 | Bracketed paste | ✅ | ❌ | **Missing** |
| 9 | Drag-and-drop images | ✅ | ❌ | |
| 10 | Tab completion | ✅ | ✅ | Slash commands |
| 11 | Ctrl shortcuts (a/e/b/f/k/u/w) | ✅ | ❌ | **Missing** |
| 12 | Placeholder text | ✅ | ✅ | "Type a message..." |
| 13 | Attachments (Ctrl+R) | ✅ | ❌ | **Missing** |
| 14 | External editor | ✅ | ❌ | |
| 15 | Clear input (Ctrl+C) | ✅ | ✅ | |

---

## 5. Session Management

| # | Tính năng | OpenCode | ToolNet | Ghi chú |
|---|-----------|----------|---------|---------|
| 1 | Multiple sessions | ✅ | ✅ | Tab-based |
| 2 | Session rename | ✅ | ✅ | `/session rename` |
| 3 | Session delete | ✅ | ✅ | Ctrl+W |
| 4 | New session | ✅ | ✅ | Ctrl+T |
| 5 | Switch session (Tab/PgUp/PgDn) | ✅ | ✅ | |
| 6 | Messages persistence | ✅ | ❌ | **Missing — lost on restart** |
| 7 | Session export | ✅ | ❌ | Cần cloud sync |
| 8 | Session share | ✅ | ❌ | Cần cloud sync |
| 9 | Session compact | ✅ | ❌ | **Missing** |
| 10 | Session parenting | ✅ | ❌ | Agent system dependency |
| 11 | Session timeline | ✅ | ❌ | **Missing** |
| 12 | Session fork | ✅ | ❌ | **Missing** |
| 13 | Session copy | ✅ | ❌ | **Missing** |
| 14 | Auto-titling | ✅ | ❌ | **Missing** |
| 15 | Continue last session | ✅ | ❌ | **Missing** |

---

## 6. File Operations

| # | Tính năng | OpenCode | ToolNet | Ghi chú |
|---|-----------|----------|---------|---------|
| 1 | Read file | ✅ | ✅ | `/read` với offset/limit |
| 2 | Write file | ✅ | ✅ | `/write` tạo dir tự động |
| 3 | Edit file (text replace) | ✅ | ✅ | `/edit` first match + replace-all |
| 4 | Apply patch | ✅ | ❌ | **Missing** |
| 5 | Diff rendering | ✅ | ❌ | **Missing — priority** |
| 6 | Glob | ✅ | ✅ | `/glob` pattern matching |
| 7 | Grep | ✅ | ✅ | `/grep` với include filter |
| 8 | Bash | ✅ | ✅ | `/bash` với timeout |
| 9 | Undo file changes | ✅ | ✅ | `/undo` snapshot-based |
| 10 | Redo file changes | ✅ | ✅ | `/redo` |
| 11 | File watcher | ✅ | ❌ | CLI tool không cần |
| 12 | LSP integration | ✅ | ❌ | ToolNetAPI không hỗ trợ |
| 13 | Auto-formatter | ✅ | ❌ | ToolNetAPI không hỗ trợ |
| 14 | Sandbox/path validation | ✅ | ❌ | **Security risk** |
| 15 | History stats | ✅ | ✅ | `/undo` hiển thị description |

---

## 7. Mode & Agent System

| # | Tính năng | OpenCode | ToolNet | Ghi chú |
|---|-----------|----------|---------|---------|
| 1 | Build/Plan mode | ✅ | ⚠️ | Dead code (`setAgentMode` không dùng) |
| 2 | Agent system | ✅ | ❌ | Ngoài scope gateway |
| 3 | Subagents (@mention) | ✅ | ❌ | |
| 4 | Background agents | ✅ | ❌ | |
| 5 | Hidden agents | ✅ | ❌ | |
| 6 | Agent customization | ✅ | ❌ | |
| 7 | Agent colors | ✅ | ❌ | |
| 8 | Agent model override | ✅ | ❌ | |
| 9 | Session hierarchy | ✅ | ❌ | |
| 10 | Task tool (subagent) | ✅ | ⚠️ | ToolNet có `/session` nhưng không agent |

---

## 8. Keyboard Shortcuts

| # | Shortcut | OpenCode | ToolNet | Ghi chú |
|---|----------|----------|---------|---------|
| 1 | Enter = send | ✅ | ✅ | |
| 2 | Shift+Enter = newline | ✅ | ❌ | **Missing** |
| 3 | Ctrl+C = cancel/exit | ✅ | ✅ | Double-tap to exit |
| 4 | Ctrl+Z = undo | ✅ | ✅ | |
| 5 | Ctrl+Y = redo | ✅ | ✅ | |
| 6 | Tab = next session | ✅ | ✅ | |
| 7 | Shift+Tab = previous | ✅ | ❌ | **Missing** |
| 8 | ? = help | ✅ | ✅ | |
| 9 | Ctrl+P = command palette | ✅ | ❌ | **Missing** |
| 10 | Ctrl+T = new session | ✅ | ✅ | |
| 11 | Ctrl+W = close session | ✅ | ✅ | |
| 12 | Ctrl+M = model picker | ✅ | ✅ | |
| 13 | Escape = interrupt/cancel | ✅ | ❌ | **Missing** |
| 14 | Ctrl+R = rename | ✅ | ❌ | **Missing** |
| 15 | Ctrl+D = delete session | ✅ | ❌ | **Missing** |
| 16 | PgUp/PgDn = scroll | ✅ | ✅ | |
| 17 | Ctrl+↑/↓ = prev/next session | ✅ | ✅ | |
| 18 | Leader key (Ctrl+X) | ✅ | ❌ | **Missing** |
| 19 | Ctrl+U/D = half-page scroll | ✅ | ❌ | **Missing** |
| 20 | Ctrl+A/E = line home/end | ✅ | ❌ | **Missing** |
| 21 | Ctrl+K/U = kill to end/start | ✅ | ❌ | **Missing** |
| 22 | Ctrl+W = kill word backward | ✅ | ❌ | **Missing** |
| 23 | Alt+F/B = word forward/back | ✅ | ❌ | **Missing** |
| 24 | Ctrl+F = toggle fullscreen | ✅ | ❌ | **Missing** |

---

## 9. Tools & MCP

| # | Tính năng | OpenCode | ToolNet | Ghi chú |
|---|-----------|----------|---------|---------|
| 1 | Read file tool | ✅ | ✅ | Locally qua codingAgent |
| 2 | Edit file tool | ✅ | ✅ | |
| 3 | Write file tool | ✅ | ✅ | |
| 4 | Apply patch tool | ✅ | ❌ | **Missing** |
| 5 | Bash tool | ✅ | ✅ | |
| 6 | Glob tool | ✅ | ✅ | |
| 7 | Grep tool | ✅ | ✅ | |
| 8 | Web search | ✅ | ✅ | `/websearch` qua gateway |
| 9 | Web fetch | ✅ | ✅ | `/webfetch` qua gateway |
| 10 | Question tool | ✅ | ⚠️ | Không block input |
| 11 | Task tool (subagent) | ✅ | ❌ | **Missing** |
| 12 | MCP integration | ✅ | ✅ | `/mcp` registry + probe |
| 13 | Custom tools | ✅ | ❌ | ToolNetAPI chưa hỗ trợ |
| 14 | Permission system | ✅ | ❌ | **Missing — security risk** |
| 15 | Tool call timing | ✅ | ❌ | **Missing** |
| 16 | Tool results collapsible | ✅ | ❌ | **Missing** |
| 17 | Tool execution details | ✅ | ❌ | **Missing** |

---

## 10. Gateway-Specific (ToolNet có, OpenCode không)

| # | Tính năng | ToolNet | Ghi chú |
|---|-----------|---------|---------|
| 1 | Provider management | ✅ | Thêm/xóa/test 40+ upstream providers |
| 2 | Combo fallback groups | ✅ | Model combo với failover |
| 3 | API key management | ✅ | Tạo/xóa API keys |
| 4 | Multi-account OAuth | ✅ | OAuth device code flow |
| 5 | Jailbreak bypass | ✅ | 6 levels injection prompt |
| 6 | RTK token compression | ✅ | Tối ưu tool_result tokens |
| 7 | Gateway health/version | ✅ | `/status`, version check |
| 8 | Settings management | ✅ | RTK, Headroom, Auth mode |
| 9 | MCP registry | ✅ | Server registry + probe |
| 10 | Headroom integration | ✅ | URL-based proxy |

---

## 11. Theme & Visual

| # | Tính năng | OpenCode | ToolNet | Ghi chú |
|---|-----------|----------|---------|---------|
| 1 | Multiple themes | ✅ | ❌ | Hardcoded Catppuccin Mocha |
| 2 | Light/dark mode | ✅ | ❌ | Dark only |
| 3 | Theme picker dialog | ✅ | ❌ | |
| 4 | True color support | ✅ | ✅ | 24-bit |
| 5 | ANSI 256 fallback | ✅ | ✅ | |
| 6 | Syntax colors per language | ✅ | ✅ | Hardcoded |
| 7 | Diff colors | ✅ | ❌ | **Missing** |
| 8 | Markdown colors | ✅ | ✅ | |
| 9 | Border customization | ✅ | ❌ | |
| 10 | Dark/light variants | ✅ | ❌ | |

---

## 12. Bugs cần fix

| # | Bug | File | Priority | Mô tả |
|---|-----|------|----------|-------|
| 1 | OAuth poll deviceCode rỗng | `src/commands/providers.ts` | 🔴 Cao | `/providers poll` gửi `deviceCode: ""` |
| 2 | Ctrl+C không abort fetch | `src/screens/chat.tsx` | 🔴 Cao | Không pass AbortSignal → request chạy ngầm |
| 3 | Messages không persist | `src/lib/session.ts` | 🔴 Cao | Mất hết chat history khi restart |
| 4 | Login screen orphaned | `src/screens/login.tsx` | 🔴 Cao | Implemented nhưng không mount |
| 5 | `/question` không block input | `src/commands/question.ts` | 🟡 TB | Chỉ post formatted message |
| 6 | `/tui` command ternary sai | `src/commands/tui.ts` | 🟡 TB | Luôn trả về cùng string |
| 7 | Auth path sai | `src/lib/auth.ts` | 🟢 Thấp | `~/.toolnet/` vs `~/.toolnetapi/` |
| 8 | Agent mode dead code | `src/lib/session.ts` | 🟢 Thấp | `setAgentMode`/`toggleAgentMode` không dùng |

---

## Summary

| Khu vực | ToolNet so với OpenCode |
|---------|------------------------|
| Core UI Components | **9/20** (45%) |
| Dialog / Overlay | **4/15** (27%) |
| Message Rendering | **14/20** (70%) |
| Input Features | **6/15** (40%) |
| Session Management | **8/15** (53%) |
| File Operations | **10/15** (67%) |
| Mode & Agent | **0/10** (0%) — ngoài scope |
| Keyboard Shortcuts | **8/24** (33%) |
| Tools & MCP | **8/17** (47%) |
| Gateway-Specific | **10/10** (100%) — ToolNet exclusive |
| Theme & Visual | **4/10** (40%) |
| **Overall (trừ gateway exclusive)** | **~45%** |

**Ưu tiên phát triển:**
1. 🔴 Fix bugs (OAuth, AbortSignal, persist, login)
2. 🔴 Permission prompts + Error boundary
3. 🟡 File diff rendering + Sidebar
4. 🟡 Multi-line input + Keyboard shortcuts
5. 🟢 Message copy + Question dialog
