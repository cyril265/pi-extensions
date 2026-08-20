# Changelog

All notable changes to this repository are documented here.

## 2026-08-17 10:00

### simple-subagent

- Removed the tool-call trace from subagent results entirely; results always render the compact per-agent summary, and the exported renderer is now `renderLiveCompact` instead of `renderSubagentDetails`.
- Reused one Herdr subagent tab named `Subagents` per workspace, with finished panes cleaned before each new run and crash-safe setup locking.
- Added Pi session IDs and copyable `pi --session <path>` commands to settled results, plus unique IDs for context-forked subagents.
- Removed all Herdr notifications from `simple-subagent`.

## 2026-08-16 19:00

### pi-last-turn-review

- Replaced the Monaco source view in `/annotate-turn` with rendered markdown; comments now anchor to markdown blocks (hover a block, click +) instead of gutter line numbers.
- Annotation comments carry the block's line range, and the generated prompt quotes the full block text (truncated at 300 chars).
- Added selection comments: select any passage inside a block and click the floating Comment button; the generated prompt quotes up to 300 characters of the selected text.
- Fixed the block + button being unreachable: the hover zone now includes the button area, so hover no longer drops while moving to it.

## 2026-08-16 17:00

### simple-subagent

- Redesigned dispatch, progress, and result displays with clearer statuses, model labels, session keys, and compact per-agent usage in the TUI.
- Shortened Herdr subagent tab labels to `SU: <parent>`.
- Replaced aggregate usage and cost in parent-delivered results with the subagent's final context size.

## 2026-08-11 18:12

### simple-subagent

- Changed completed job results to steer a busy parent before its next model call instead of waiting for all parent tool work to finish.
- Added soft guidance for a busy parent to continue its current work and use delivered subagent findings where relevant.

### General

- Added repository guidance requiring changelog updates before commits and grouping entries by extension.

## 2026-08-11 17:34

### Added

- Added fuzzy search to the `presets` picker.

### Changed

- Changed `simple-subagent` to keep subagent tool schemas registered during a parent-assigned run and lock execution at runtime instead, so the provider prompt-cache prefix stays stable; assigned prompts now tell agents the tools are unavailable.
- Changed the `runSubAgents` description to advise continuing independent work after dispatch and calling `collectSubagents` only to block.
- Changed `clean-generated-artifacts` to also remove `.angular` and `dist` directories when they are git-ignored and untracked.

## 2026-08-10 20:55

### Changed

- Changed `simple-subagent` job IDs to 8 characters and the per-job TUI widget to a compact ticking view showing each agent's latest tool call.
- Changed `/subagents` without arguments to open a running-job picker with cancellation.
- Changed `simple-subagent` result delivery to inline results up to 2048 characters in collect and push messages.
- Changed `simple-subagent` tool descriptions to advise separate dispatch calls for independently actionable tasks, since a job settles only when all its agents finish.

## 2026-08-10 20:25

### Added

- Added `prompt-template-shell` for Claude Code-style `` !`command` `` expansion in prompt templates.
- Added asynchronous subagent jobs, `collectSubagents`, completion delivery, cancellation, and job status commands to `simple-subagent`.
- Added provider-and-model-specific system prompt append files to `provider-system-prompt-append`.

### Changed

- Changed `simple-subagent` dispatch to return job IDs and session keys immediately instead of waiting for every agent.
- Changed Herdr context forks to open in dedicated tabs.
- Changed session search to exclude the active session from results.

### Fixed

- Fixed inline script and JSON replacement in `pi-last-turn-review` when generated content contains JavaScript replacement patterns.
