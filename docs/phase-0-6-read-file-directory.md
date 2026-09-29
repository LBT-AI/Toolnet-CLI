# Phase 0.6 — read_file(directory) Reproduction

HEAD: 825cee8
Status: BUG REPRODUCED

## read_file(file)

Result:
PASS. Returns `exitCode: 0` and the file content in `stdout`.

## read_file(directory)

Result:
FAIL. Returns `exitCode: 1` and an unstructured string error in `stderr`.

Exact error:
`Not a file: /path/to/directory`

Structured error code:
NO

Suggested tool:
NO (NONE)

Suggested action:
NO

## read_file(missing)

Result:
FAIL. Returns `exitCode: 1` and an unstructured string error in `stderr`.

Exact error:
`File not found: /path/to/missing`

## Tool descriptions

read_file:
"Read file contents from the current workspace. Use before editing unfamiliar files to understand the existing code. Prefer targeted reads with offset/limit over reading the entire repository." (Lacks explicit guidance that this tool cannot read directories or to use `list_dir`).

list_dir:
"List files and subdirectories in a directory."

tree:
"Show directory structure as a tree. Excellent for understanding project layout."

## Recovery contract

Automatic recovery:
NO (ToolGateway and Executor do not automatically list the directory if `read_file` is called on it).

Requires another provider turn:
YES (The agent receives the raw string error and must manually reason out the recovery path and dispatch a new tool call).

Turn cost:
Because `maxTurns` is strictly bound (e.g. 10), calling `read_file` on a directory burns 1 turn for the initial failed request, plus at least 1 more turn for the agent to recover by calling `list_dir` or `tree`.

Root cause candidate:
The primitive `toolRead` correctly rejects directories, but the tool boundary returns an opaque `stderr` string instead of a structured recovery contract (`errorCode: "NOT_A_FILE", suggestedTool: "list_dir"`). Without structured hints, the agent wastes turns guessing how to recover.

Finding:
TN-R0-006

Severity:
P1

Phase to fix:
Phase 5

Production behavior changed:
NO
