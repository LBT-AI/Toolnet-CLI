---
applyTo: "**"
---

# ToolNet Memory project continuity

Use ToolNet Memory as the continuity source for this repository.

- When the user asks to continue, resume, pick up, finish unfinished work,
  or asks where work stopped, recover ToolNet continuity before reconstructing
  state from chat/session history.
- Use the ToolNet MCP server and `memory_agent_ask` when fast project context
  is missing, stale, or ambiguous.
- Prefer `mode="local"` for current task, current file, blockers, TODOs,
  completed work, and next action.
- Use `mode="ai"` only when continuity needs synthesis.
- Do not reconstruct continuity by reading:
  - `.toolnet/sessions/**`
  - ToolNet raw `events.jsonl`
  - ToolNet raw `state.json`
  - another coding agent's private transcript/history files.
- After continuity is recovered, verify current repository source and git
  state before changing code.
- Do not ask the user to repeat context ToolNet already provides.

Current repository evidence overrides stale memory.
