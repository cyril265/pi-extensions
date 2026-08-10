# Changelog

All notable changes to this repository are documented here.

## 2026-08-10

### Changed

- Changed `simple-subagent` job IDs to 8 characters and the per-job TUI widget to a compact ticking view showing each agent's latest tool call.
- Changed `/subagents` without arguments to open a running-job picker with cancellation.
- Changed `simple-subagent` result delivery to inline results up to 2048 characters in collect and push messages.
- Changed `simple-subagent` tool descriptions to advise separate dispatch calls for independently actionable tasks, since a job settles only when all its agents finish.

## 2026-08-10 (earlier)

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
