# Phase 0.7 — Security False Positives

HEAD: 825cee8
Status: BUGS REPRODUCED

## TN-R0-007A — Dynamic execution

Command:
`php -r 'echo "hello";'`

Parser:
Does not identify `php` as an interpreter because it is missing from the `INTERPRETERS` whitelist in `shellParser.ts`.

Category:
WORKSPACE_EXECUTION

Capability:
DYNAMIC_EXECUTION

Decision:
DENY

Reason:
Action requires 'DYNAMIC_EXECUTION' capability which is currently locked by security policy.

Read-only WP fixture:
Also classified as DYNAMIC_EXECUTION and heavily blocked with DENY.

Root cause layer:
Policy layer capability mapping. `securityEngine.ts` (`determineShellCapability`) applies a blanket regex (`/\bphp\s+-r\s+/`) that forces the `DYNAMIC_EXECUTION` capability. In `workspace` mode, this capability is hard-locked (`false`) by default in `policyEngine.ts`, causing a strict DENY. 

Severity:
P1

## TN-R0-007B — /dev/null

Command:
`echo hello 2>/dev/null`

Parsed redirection:
`{ type: "2>", target: "/dev/null" }` is extracted and pushed to `allRedirectTargets`.

Category:
SYSTEM_TAMPERING

Capability:
SYSTEM

Decision:
DENY

Reason:
Blocked by Security Policy: Output redirection targets protected system directory '/dev/null'

Root cause layer:
Classifier layer. `commandClassifier.ts` iterates over all redirect targets and strictly matches them against `SENSITIVE_SYSTEM_PREFIXES` (which includes `/dev`). It fails to special-case the safe data sink `/dev/null`.

Severity:
P1

## TN-R0-007C — FD duplication

Command:
`echo hello 2>&1`

Parsed redirection:
`{ type: "2>&1", target: "1" }` (target `"1"` is NOT pushed to `allRedirectTargets`).

Decision:
ALLOW (Falls through to SAFE_READ).

Finding:
NOT REPRODUCED

## Controls

workspace write:
`echo hello > ./safe.txt` -> Correctly classified as WORKSPACE_EXECUTION/BUILD_AND_TEST (Not tampering).

protected system write:
`echo test > /etc/toolnet-test` -> Correctly blocked as SYSTEM_TAMPERING with CRITICAL_DENY.

## Dynamic interpreter matrix

php -r: Detected dynamic (Capability: DYNAMIC_EXECUTION) -> Workspace Decision: DENY
python -c: Detected dynamic (Capability: DYNAMIC_EXECUTION) -> Workspace Decision: DENY
node -e: Detected dynamic (Capability: DYNAMIC_EXECUTION) -> Workspace Decision: DENY
bash -c: Detected dynamic (Capability: DYNAMIC_EXECUTION) -> Workspace Decision: DENY
sh -c: Detected dynamic (Capability: DYNAMIC_EXECUTION) -> Workspace Decision: DENY

## Turn cost

When the agent attempts safe inspection (like a read-only `php -r` or suppressing stderr with `2>/dev/null`), the security engine issues a hard DENY. This immediately burns a provider turn. The agent must then spend another turn guessing an alternative (e.g., writing a temporary script file and executing it), rapidly draining the strict `maxTurns` budget.

Production behavior changed:
NO
