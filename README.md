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
| [`astra-reasoning`](astra-reasoning) | Preserves Astra's request prefix when changing thinking levels through native Codex configuration updates. |
| [`simple-subagent`](simple-subagent) | `runSubAgents({ agents: [...] })` and a Node client — run isolated subagents asynchronously; results arrive as a pushed report. Optional context-forking tool. |
| [`prewalk`](prewalk) | Transparent [Prewalk](https://stencil.so/blog/prewalk)-style handoff on top of `simple-subagent`: frontier model explores, cheaper model executes. |
| [`cwd`](cwd) | `/cwd` — continue the current session in another working directory without losing history. |
| [`footer`](footer) | Footer HUD: directory name, git branch, context meter, provider, model, thinking level, quota, session cost. |
| [`tool-result-trim`](tool-result-trim) | Smart-trims text tool results before they enter context. |
| [`rm-guard`](rm-guard) | Puts a path-checking `rm` first in `PATH` for every bash command; after variable and glob expansion, `rm` outside the project asks you first. |
| [`pi-audit`](pi-audit) | Audits pi packages before install/update, then installs approved local snapshots. |
| [`copy-plain`](copy-plain) | `/copy-plain` — copies the last assistant message as plain text (Slack-safe). |
| [`session-search`](session-search) | `sessions-search` tool — searches across previous pi sessions. |
| [`presets`](presets) | Named presets for model, thinking level, readonly mode, and system prompt, via CLI flag, `/preset`, or Ctrl+Shift+U. Also `/readonly` and the `!readonly` prompt suffix. |
| [`provider-system-prompt-append`](provider-system-prompt-append) | Appends a provider-specific and a model-specific `APPEND_SYSTEM.md` per turn. |
| [`prompt-template-shell`](prompt-template-shell) | Claude Code-style `` !`command` `` dynamic context in prompt templates. |
| [`warp-notifications`](warp-notifications) | Emits Warp's OSC 777 CLI-agent protocol so completions and prompts hit Warp's agent inbox. |
| [`herdr-tab-name`](herdr-tab-name) | Names the session and its herdr tab from the task, with manual renames winning. |
| [`piq`](piq) | One-shot `pi` wrappers — `pil`, `pim`, `pic` — for quick prompts at fixed reasoning levels. |
| [`remote-handoff`](remote-handoff) | Hands a conversation and its project files to pi on an SSH host, then brings the conversation and changes back. |
| [`pi-enclave`](pi-enclave) | Runs all tools inside a Gondolin VM. Fork of yapp, see Attribution. |
| [`pi-openai-compaction`](pi-openai-compaction) | Replays OpenAI Responses compaction V2 checkpoints. Fork, see Attribution. |
| [`pi-last-turn-review`](pi-last-turn-review) | `/diff-turn`, `/diff-git`, `/annotate-turn`, `/undo-turn` — review the last turn's diff in a native window with inline comments. Fork, see Attribution. |

## Single-file extensions

Point `packages` at the individual file to load these.

| File | What it does |
| --- | --- |
| [`unified-edit.ts`](unified-edit.ts) | Replaces the built-in `edit` tool with a unified-patch editor. |
| [`activate-mcp-aliases.ts`](activate-mcp-aliases.ts) | Activates every `mcp__` alias from `pi-claude-code-use.json` on Anthropic OAuth and deactivates them on other providers. Requires `pi-claude-code-use`, listed before it in `packages`. Logs to `~/.pi/logs/activate-mcp-aliases.log`. |
| [`branch-stats.ts`](branch-stats.ts) | `/branch-stats [node-id]` — usage statistics for the current branch or a tree node. |
| [`shift-escape.ts`](shift-escape.ts) | Makes Shift+Escape act like Escape in the editor. |
| [`cache-retention-long.ts`](cache-retention-long.ts) | Sets `PI_CACHE_RETENTION=long`. |
| [`anthropic-thinking-binding.ts`](anthropic-thinking-binding.ts) | Removes Fable 5.1 thinking block binding for eligible older Anthropic accounts. |

### anthropic-thinking-binding

This extension only changes requests for `anthropic/claude-fable-5-1`. It removes
`thinking.block_binding` from the outgoing provider payload and leaves the rest of the thinking
configuration, messages, prompts, thinking blocks, and signatures unchanged.

**Warning:** Use this extension only with Anthropic accounts created before
2026-08-31 00:00 UTC. Accounts created on or after that time enforce thinking block binding by
default. On an account where binding is enforced, removing Pi's `drop_block` behavior can turn a
thinking-prefix mismatch into an HTTP 400 error. Later Claude models will enforce binding for all
accounts.

## Utilities

- [`tools/worktree`](tools/worktree) — `wt`, a small Node wrapper around `git worktree` for
  branch-per-task work, plus `clean-generated-artifacts` (Python 3) for pruning `node_modules`,
  .NET `bin`/`obj`, and git-ignored `.angular`/`dist` output under a worktree root.

## Agent configuration

[`agent/`](agent) holds example pi agent configuration: `AGENTS.md`, `APPEND_SYSTEM.md`, and a
`settings.json` showing how these packages get wired together. The settings file is a sanitized
example — replace `/absolute/path/to/pi-extensions` with your checkout path. Never commit a real
`settings.json`: pi stores provider and web-search API keys in it.

The example leaves out `unified-edit.ts` (already bundled into `pi-enclave`),
`activate-mcp-aliases.ts` (needs `pi-claude-code-use`), `anthropic-thinking-binding.ts`
(account-specific, see the warning above), and `pi-audit` and `piq` (CLIs, not pi packages).

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
