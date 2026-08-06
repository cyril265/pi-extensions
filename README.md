# pi-extensions

Extensions, packages, and utilities for [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`).

Each directory is a self-contained pi package with its own README. Nothing here is published as a
bundle — install the pieces you want.

## Install

Add a package directory to your pi settings, then run `/reload`:

```json
{
  "packages": ["/absolute/path/to/pi-extensions/<package>"]
}
```

Global settings live in `~/.pi/agent/settings.json`, project settings in `.pi/settings.json`.

## Packages

| Package | What it does |
| --- | --- |
| [`simple-subagent`](simple-subagent) | `runSubAgents({ agents: [...] })` — runs isolated subagents, returns result file paths. Optional context-forking tool. |
| [`prewalk`](prewalk) | Transparent [Prewalk](https://stencil.so/blog/prewalk)-style handoff on top of `simple-subagent`: frontier model explores, cheaper model executes. |
| [`cwd`](cwd) | `/cwd` — continue the current session in another working directory without losing history. |
| [`footer`](footer) | Footer HUD: breadcrumb path, git branch, context meter, provider, model, thinking level. |
| [`tool-result-trim`](tool-result-trim) | Smart-trims text tool results before they enter context. |
| [`pi-audit`](pi-audit) | Audits pi packages before install/update, then installs approved local snapshots. |
| [`copy-plain`](copy-plain) | `/copy-plain` — copies the last assistant message as plain text (Slack-safe). |
| [`session-search`](session-search) | `sessions-search` tool — searches across previous pi sessions. |
| [`presets`](presets) | Named presets for model, thinking level, readonly mode, and system prompt, via CLI flag, `/preset`, or Ctrl+Shift+U. |
| [`provider-system-prompt-append`](provider-system-prompt-append) | Applies a provider-specific `APPEND_SYSTEM.md` per turn. |
| [`warp-notifications`](warp-notifications) | Emits Warp's OSC 777 CLI-agent protocol so completions and prompts hit Warp's agent inbox. |
| [`herdr-tab-name`](herdr-tab-name) | Names the session and its herdr tab from the task, with manual renames winning. |
| [`piq`](piq) | One-shot `pi` wrappers — `pil`, `pim`, `pic` — for quick prompts at fixed reasoning levels. |

## Single-file extensions

Point `packages` at the individual file to load these.

| File | What it does |
| --- | --- |
| [`unified-edit.ts`](unified-edit.ts) | Replaces the built-in `edit` tool with a unified-patch editor. |
| [`activate-mcp-aliases.ts`](activate-mcp-aliases.ts) | Auto-activates MCP aliases while preserving user-selected ones. |
| [`branch-stats.ts`](branch-stats.ts) | Per-branch session statistics. |
| [`shift-escape.ts`](shift-escape.ts) | Shift+Escape key handling in the editor. |
| [`cache-retention-long.ts`](cache-retention-long.ts) | Sets `PI_CACHE_RETENTION=long`. |

## Utilities

- [`tools/worktree`](tools/worktree) — `wt`, a small Node wrapper around `git worktree` for
  branch-per-task work, plus `clean-generated-artifacts` for pruning `node_modules` and .NET
  `bin`/`obj` output under a worktree root.

## Agent configuration

[`agent/`](agent) holds example pi agent configuration: `AGENTS.md`, `APPEND_SYSTEM.md`, and a
`settings.json` showing how these packages get wired together. The settings file is a sanitized
example — replace `/absolute/path/to/pi-extensions` with your checkout path. Never commit a real
`settings.json`: pi stores provider and web-search API keys in it.

## Attribution

Three packages here are forks of other people's work, kept under their original MIT licenses:

- [`pi-enclave`](pi-enclave) — fork of [yapp](https://github.com/mgabor3141/yapp) by
  [mgabor3141](https://github.com/mgabor3141). Retargeted at `@earendil-works/pi-coding-agent` and
  combined with the unified patch `edit` tool. See [`pi-enclave/README.md`](pi-enclave/README.md).
- [`pi-openai-compaction`](pi-openai-compaction) — `@jordyvd/pi-openai-compaction` by Jordy Van
  Domselaar. License: [`pi-openai-compaction/LICENSE`](pi-openai-compaction/LICENSE).
- [`pi-last-turn-review`](pi-last-turn-review) — © pi-last-turn-review contributors. License:
  [`pi-last-turn-review/LICENSE`](pi-last-turn-review/LICENSE).

## License

MIT — see [LICENSE](LICENSE). The forks listed above keep their own bundled licenses.
