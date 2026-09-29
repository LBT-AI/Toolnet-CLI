# Public distribution surface

Two repositories exist for ToolNet CLI. They are **not** mirrors.

| Role | Repository | Contents |
|---|---|---|
| Canonical development | `LBT-AI/Toolnet-CLI` | Full source, tests, tooling, internal docs, CI |
| Public distribution | `ToolNetWorks/ToolNet-CLI` | Release + docs surface only (no application source) |

The public repository is a curated surface for users and package managers. It
must **never** receive the full development tree. Use this document as the
allow-list when preparing a public release sync.

## Allowed in the public repo

- `README.md` — user-facing overview and install instructions.
- `CHANGELOG.md` — release history.
- `docs/release-notes-*.md` — human release notes.
- `install.sh`, `install.ps1` — the official installers.
- `Formula/toolnet.rb` — Homebrew formula (canonical copy lives here, mirrored
  to the public tap surface).
- `bucket/toolnet.json` — Scoop manifest.
- `LICENSE` — license text.
- Release artifacts published through GitHub Releases (binaries +
  `checksums.txt`) — attached to the public repo, not committed.

## NEVER in the public repo

- `src/**` — application source.
- `tests/**` and any `*.test.ts` / `__tests__` — internal suites.
- `scripts/**` — internal tooling (secret scan, binary build, visual/PTY
  acceptance, distribution updaters).
- `.github/**` — internal workflows, issue templates and agent instructions.
- `docs/phase-*.md`, `docs/phase-*-*.md`, `Phase-*-Report.md` — internal
  development history.
- `.env`, `*.db`, `*.sqlite*`, `.wrangler/**`, `dist/**`, `dist-bin/**`,
  `.logs/**`, `.toolnet/**`, `.agents/**`, `.bravecode/**` — secrets, local
  state, caches and generated artifacts.

## Guardrails already in place

- The npm package is limited to `bin`, `dist`, `README.md`, `CHANGELOG.md`
  (`package.json` → `files`) and further filtered by `.npmignore`; `npm pack
  --dry-run` is a release gate and currently reports exactly 6 files.
- `.gitignore` excludes generated runtime/emulator state and release archives,
  so a fresh clone never carries them into a public sync.
- `scripts/phase8-secret-scan.ts` runs over **tracked** files in CI, so no
  credential can reach either repository unnoticed.

## Release sync checklist (manual, by design)

1. Confirm `npm pack --dry-run` shows only the intended runtime files.
2. Copy only the allow-listed files above into the public repo.
3. Verify no `src/`, `tests/` or `scripts/` path was copied.
4. Run the secret scan against the public repo tree.
5. Publish the GitHub Release (binaries + `checksums.txt`) from `release.yml`.
