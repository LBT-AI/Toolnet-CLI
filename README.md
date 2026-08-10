# ToolNet CLI
ToolNet CLI is an AI coding agent for the terminal.
It runs as a standalone client and communicates with the ToolNet API Gateway through HTTP APIs.
## Features
- Interactive terminal UI
- Coding agent tools
- Build / Plan modes
- Workspace sandbox
- Permission approval
- Session persistence
- Context compaction
- File and image attachments
- Structured patch application
- Git status and diff
- Web fetch
- Optional browser automation
- MCP tools
- Teamwork / sub-agents
- Non-interactive mode for scripts and CI
## Requirements
Recommended:
- Bun
Node.js support is also built and tested where compatible.
## Development
```bash
bun install
bun run typecheck
bun test
bun run build

Run locally

bun src/index.tsx

or after build:

node bin/toolnet.js

Help

toolnet --help

Version

toolnet --version

Non-interactive

toolnet -p "Check this project for TypeScript errors"

JSON output:

toolnet -p "Analyze this project" --json

Gateway

ToolNet CLI is independent from the ToolNet API source repository.

The CLI communicates with the configured ToolNet API Gateway over HTTP.

Repository

ToolNet CLI:

https://github.com/LBT-AI/Toolnet-CLI

ToolNet API Gateway:

https://github.com/LBT-AI/toolnetapi

License

MIT
