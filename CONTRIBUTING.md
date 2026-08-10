# Contributing to ToolNet CLI
## Setup
```bash
git clone https://github.com/LBT-AI/Toolnet-CLI.git
cd Toolnet-CLI
bun install

Before submitting changes

Run:

bun run typecheck
bun test
bun run build

All checks must pass.

Coding conventions

* Use TypeScript.
* Keep functions focused.
* Avoid unnecessary dependencies.
* Preserve backward compatibility where possible.
* Add tests for bug fixes and new functionality.
* Do not commit API keys, passwords, tokens or secrets.

Commit messages

Use Conventional Commits when possible:

feat: add new capability
fix: resolve gateway timeout
refactor: simplify session manager
test: add gateway tests
docs: update installation guide
chore: update build pipeline

Pull requests

A pull request should explain:

* What changed
* Why it changed
* How it was tested
* Any compatibility impact

Do not merge changes that fail TypeScript, tests or build.
