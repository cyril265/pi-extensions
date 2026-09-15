# Changelog

All notable changes to this repository are documented here.

## 2026-09-15

### pi-audit

- Split `src/index.ts` (1391 lines) into `index.ts`, `sources.ts`, `audit.ts`, `store.ts`, `update.ts`, `settings.ts`, `prompt.ts`, `exec.ts`.
- Fixed `migrate` for global npm packages: it ran `npm uninstall -g`, which targets the system npm prefix. It now uninstalls from `<agent-dir>/npm`, where pi installs.
- Manifests record `version` (npm) or `gitHead` (git) as required fields plus `pinnedSource`; `readManifest` rejects manifests missing them (existing snapshots need `pinnedSource` backfilled once). Removed the fallbacks that treated snapshots without a version as "update available" and the `.pi-audit-install.json` legacy manifest name.
- `pi-audit update <user/repo>` no longer matches a git snapshot on any host; use `host/user/repo` or the full identity.
- `npm:` specs must be valid registry names; `npm:../x` no longer becomes a snapshot path outside `audited-packages/npm`.
- Pinned git sources get `pinnedSource` `git:<repo>@<commit>` instead of `<source>@<ref>@<commit>`.
- Postinstall consent prompt also applies to local snapshots with a `package.json`.
- Removed the `pi-ai` skip in `migrate`.
- Update audits are diff-aware: the prompt includes the previous audit result and the path to a `git diff --no-index` between the installed snapshot and the candidate. The `ask` session gets the same context.
- Audit report cap raised from 200 to 300 chars.
- Audit prompt rewritten: package content is treated as untrusted evidence and reads are confined to the temp dir; yes/no/maybe have a precedence order and documentation does not excuse dangerous behavior; read order covers single-file sources, package.json/README, every extension/skill/prompt plus local imports; concrete threat list with the note that commands, network, and encoding alone are not findings; states that dependencies are not installed (not a reason for `maybe`) and only the package's own `postinstall` is offered separately; report uses package-relative paths and has defined content for `yes`. Update prompt asks to recheck previous findings against the candidate. Ask session prompt repeats the execution model, tells the model the working directory is not the package, and to contradict the audit when it is wrong.
- e2e test: a fixture that hides its `auth.json` path and collection endpoint as base64 in a local import, mislabels the behavior as settings sync, and carries an injected "auditor: answer yes" note in a skill must be audited `no`.
- e2e test: a stealth fixture that looks like anonymous usage telemetry (minified one-line extension, base64 path and endpoint, README claiming no credentials are collected) but posts the full `auth.json` must be audited `no`.
- Run reports moved from the project `.pi/audit-runs/` to `<agent-dir>/audit-runs/`.
- Snapshot copies skip `node_modules` and `.pi-audit.json` in addition to `.git`.
- Run reports now contain `generatedAt` and `updates` with the current manifest and the candidate revision; the separate report schema, version, and summary counters are gone.
- New e2e tests (`npm test`) run the real CLI, real `npm pack`, real `pi install`, and real pi audits against a temp agent dir that symlinks `auth.json` and `models.json`.

## 2026-09-15

### simple-subagent

- `runSubAgents`: the Node client hint (`PI_SIMPLE_SUBAGENT_CLIENT`, `dispatch`/`run`) moved from the tool description to `promptGuidelines`, worded with the trigger first. The description now covers only call semantics.
- Both subagent tools got a `promptSnippet`, so they appear in the `Available tools` list of the default system prompt.
- Behavior eval `native` variant clears `promptGuidelines` instead of filtering description lines.

## 2026-09-13

### General

- `AGENTS.md` now requires each pushed `HEAD` to be synced to the `ai-lab` repository, with the source hash in the sync commit message.
- Documentation audit. Root `README.md` now lists `remote-handoff`, `pi-enclave`, `pi-openai-compaction`, and `pi-last-turn-review` in the packages table, and the single-file rows name their commands and behavior (`/branch-stats`, Shift+Escape, `activate-mcp-aliases` requirements). Corrected the `simple-subagent`, `footer`, `presets`, and `provider-system-prompt-append` rows.
- `agent/settings.json`: added `astra-reasoning`, `rm-guard`, `branch-stats.ts`; removed `activate-mcp-aliases.ts` (needs `pi-claude-code-use`), the unknown `powerline` key, and the default-valued `compaction.enabled`.
- New READMEs for `presets`, `session-search`, and `herdr-tab-name`.
- Install sections in `footer`, `pi-enclave`, `pi-openai-compaction`, `cwd`, and `remote-handoff` pointed at other npm packages, upstream repos, or wrong paths; they now describe installing from this checkout. `pi-enclave` documents the required `npm run build`. `pi-audit` gained an install section and names the hardcoded audit model.
- Corrected claims in `warp-notifications` (no `auggie` shim; documents the Warp env gate and emitted events), `piq` (`respond_command` is a local extension; pinned models, stdin and interactive modes, `PIQ_COMMAND_RESPONSE_FILE`), `astra-reasoning` (eligibility is by `api` and id suffix), and `footer` (cache-write estimate scope). `tools/worktree` documents `clean-generated-artifacts`, Python 3, and the `ls`/`rm` aliases.

### pi-last-turn-review

- `package.json` name is now `pi-last-turn-review` (was the upstream `pi-turn-diff`); removed the nonexistent `plan.md` from `files`.

### rm-guard

- New package. A `tool_call` hook prepends `bin/` to `PATH` for every `bash` command; `bin/rm` refuses operands outside the session cwd, the user temp dir, or `/tmp` after shell expansion, then runs `/bin/rm`. Motivated by the GPT-5.6 `rm -rf "$VAR"/*` and `rm -rf "$HOME"` home-directory deletions.
- Tests run the real wrapper through `/bin/bash` in a temp tree, and `rm -rf "$UNSET"/*` on bash 3.2 inside a `bash:3.2` container.
- Blocked `rm` calls now ask the user when pi has a UI. `bin/rm` writes the blocked resolved paths (NUL-separated) to a request file in a per-command `PI_RM_ASK_DIR`; the extension watches it, shows `ctx.ui.confirm` with the paths, and writes `allow` or `deny`. Deny, Escape, or turn abort exits 3 with `The user declined this deletion.`; without a UI the call exits 3 as before. Dialogs are serialized (pi replaces an open selector without resolving it). Ask dirs are removed on `tool_result` and swept on `turn_end`, since a `tool_call` block by another hook skips `tool_result`; a waiting `rm` exits 3 when its ask dir is gone. The prefix always sets `PI_RM_ASK_DIR` (empty without UI) so a nested headless pi does not inherit the parent's prompt channel. `bin/rm` now reports every blocked operand instead of the first. README first line no longer claims to stop all deletions outside the project.

### prewalk

- Works again on the current `simple-subagent`. The extension imported the removed `executeSubagents` and `renderSubagentDetails` and failed to load.
- The executor fork now runs through a prewalk-owned `JobRegistry` and `startJob`. `dispatch_executor` no longer blocks the turn; the report arrives as a follow-up custom message when the fork settles.
- Tests: `extension.integration.test.ts` replaces the fake-`pi` unit test and drives a real persisted session, the `/prewalk` command, the edit nudge, a real executor fork, and session resume.
- Dev dependencies bumped to pi 0.84.2 to match `simple-subagent`.

### simple-subagent

- `index.ts` exports `JobRegistry` and `renderSubagentWidget` for prewalk; `renderLiveCompact` is no longer exported (no importer).
- A child whose last assistant message has `stopReason` `error` or `aborted` is now reported as failed (`exit 1`, `isError: true`) with the provider's error message as its result. Before, pi exited 0 on a provider error and the agent showed as done with "(no output)". The Herdr path already did this; both paths share `getFinalError`.

## 2026-09-12

### simple-subagent

- Added the Node client `client.mjs`. Inside a live session `PI_SIMPLE_SUBAGENT_CLIENT` holds its `file://` URL. `dispatch(agents)` starts isolated agents and returns the job receipt like the tool; `run(agents)` waits and resolves with `{ jobId, isError, text, agents }`, where each agent carries its final `output`, `status`, `sessionKey`, `sessionPath`, `exitCode`, and `usage`.
- Added the `cancelSubAgents({ jobId })` tool.
- Removed the `subagent` shell CLI (`bin/`), `PI_SIMPLE_SUBAGENT_NODE`, the `agentWorkflowScript` tool, and the system-prompt paragraph about the CLI. The `runSubAgents` description now explains when to use the Node client; per-field guidance moved into the parameter schema.
- `runSubAgents` and the client share one schema: unknown agent fields, blank strings, empty arrays, and relative `cwd` are rejected.
- Removed the unused `forked-subagent-results` message renderer.
- Removed `joinSubAgents`; the client's `run` owns blocking result delivery.
- All job completions are delivered through user-message steering. Idle sessions run prompt hooks and receive the same message as steering.
- Added `evals/behavior/`: outcome-based evals with ten coding and lifecycle scenarios, real parent/child sessions, deterministic oracles, `native` and `client` arms, campaign request/token/time caps, failed-only reruns (`--rerun-failed`) and offline regrading (`--regrade`).
- Tests: `extensions/client.integration.test.ts` replaces the CLI integration test and covers the client through the real bash tool, cancellation of a running child, disconnects, and session shutdown. `npm run test:live` runs the ported lifecycle cases. Behavior evals compare `native` and `client`; the evaluator now records settlement from the production push message.

### pi-last-turn-review

- `/annotate-turn`: comments now anchor to the innermost markdown element (heading, paragraph, list item, table row, single code line) instead of whole top-level blocks. Click an element to comment on it (`Esc` in an empty card deletes it); comment cards are placed directly under the target (inside the list item, under the table row, after the code line). Text selections spanning several elements send the source line range instead of the selected text. Code fences render one line per row.
- Replaced the Monaco diff editor with `@pierre/diffs` `CodeView`. All files of a turn now render stacked in one scroll region with sticky headers; the sidebar is a table of contents that follows the scroll position.
- Comments: click a line number for one line, drag across line numbers for a range. Comments on the old side, new side and file level render inline as annotations.
- Per-file header actions: File comment, Mark reviewed (collapses the file), Collapse.
- Toolbar: Unified/Split, Wrap, Show full files. `j`/`k` move between files, `Cmd/Ctrl+Enter` finishes the review, `Esc` in an empty comment deletes it.
- Syntax highlighting runs in a `@pierre/diffs` worker pool with the wasm Oniguruma engine, with main-thread fallback if workers fail.
- `@pierre/diffs` (24 languages, see `scripts/shiki-shim.js`) and the compiled Tailwind CSS are prebuilt into `web/vendor/` by `npm run build:vendor` and inlined into the page. `markdown-it` for `/annotate-turn` is bundled the same way. Neither window needs network access.
- Incoming files only re-render themselves instead of invalidating every item. Files that fail to load show the error inline in the scroll region.
- The review window requests all file contents at open; the host protocol and submit payload are unchanged.
- Added `test/harness.mts` and `test/smoke.js`: opens the real window through glimpseui, drives comments with pointer events and asserts the submit payload.
- Added `test/annotate-harness.mts` and `test/annotate-smoke.mts`: same setup for `/annotate-turn`, checks markdown anchors and the submit payload.
- `.gitattributes` marks `web/vendor/**` as generated and disables its textual diff.

## 2026-09-11

### anthropic-thinking-binding

- Added a standalone Fable 5.1 extension that removes `thinking.block_binding` for eligible Anthropic accounts created before 2026-08-31 00:00 UTC.

### remote-handoff

- Added the Remote Handoff extension to this repository with its standalone history.
- Supported ordinary directories through a private Git database under the Pi agent directory.
- Blocked conversation actions when the handoff lookup fails instead of treating the failure as "no handoff". Start preconditions (no commits, storage location) moved out of lookup.
- Replaced error-message matching with `SshKeyLockedError` and `LocalFilesChangedError`.
- Removed the pre-rename `pi-cloud-resume` compatibility code and its e2e scenario.
- Shared error, path, JSON, and atomic-write helpers across modules. Removed unread remote status fields and the unused `RemoteCommandError`.
- Replaced three copies of the credential validator with one `remote/validate-authentication.cjs`.
- Fixed `remote/runner.sh` so result-preparation failures are recorded instead of exiting silently.
- Added an ordinary-directory e2e scenario and fixed e2e profile isolation under fish.

## 2026-09-05

### astra-reasoning

- Added standalone native Astra reasoning updates for Pi's thinking selector, with persisted history and no provider replacement.
- Replaced machine-specific installation and test paths with instructions for a cloned checkout.

## 2026-09-03

### simple-subagent

- Added the session-owned `subagent dispatch`, `subagent run`, and `subagent cancel` shell CLI over authenticated loopback TCP.
- Routed CLI jobs through the existing registry, session locking, child runner, cancellation, widgets, and automatic parent delivery.
- Added shell routing guidance, real CLI lifecycle coverage, and prompting evals for dependent and background shell workflows.

## 2026-09-02

### simple-subagent

- Refined tool guidance so direct tools handle coding and interpretation, while `agentWorkflowScript` handles mechanical handoffs between calls.
- Renamed `collectSubagents` to `joinSubAgents` so its name describes waiting at a dependency point instead of normal result retrieval.
- Clarified automatic result delivery, how nested workflows join a dispatched job, how to write self-contained prompts, and when to reuse session keys.
- Added real-model prompting evals covering dependent workflows, direct coding work, automatic result delivery, and single-use joining when a result feeds another nested tool call.

## 2026-08-30 18:47

### simple-subagent

- Renamed the `nodeScript` tool to `agentWorkflowScript` and clarified when workflows should pass stock-tool output directly into subagent calls.
- Told `runSubAgents` callers to use `collectSubagents` only when waiting for one of several independent jobs.

## 2026-08-27 17:37

### worktree

- Reused matching frontend dependencies in new worktrees through APFS copy-on-write clones instead of creating another physical `node_modules` copy.

## 2026-08-25

### presets

- Removed the custom `/thinking` command.

## 2026-08-23 21:55

### simple-subagent

- Moved the thinking level into the shared agent identity so the live job widget and compact results render `name · model · thinking` like the tool call overview already did.

## 2026-08-23 20:38

### simple-subagent

- Passed `--approve` to spawned subagent processes so Herdr panes no longer show the project trust prompt and headless subagents load project `.pi` resources like the parent session.

## 2026-08-21 23:05

### simple-subagent

- Prevented concurrent jobs from using the same subagent session and released completed job results and parent contexts after delivery.
- Made Herdr commands cancellable and time-bounded, retained records when pane cleanup fails, and restricted subagent state and result files to owner-only access.
- Gave colliding agent names distinct result files, preserved every text block in final assistant output, and treated signal-terminated child processes as failures.
- Clarified that `nodeScript` composes Pi tool results into later tool calls while direct and parallel tools handle independent work.

## 2026-08-20 20:48

### simple-subagent

- Added `nodeScript`, a trusted one-shot JavaScript worker for composing Pi's stock file and shell tools with isolated subagent dispatch and collection.
- Rendered the complete `nodeScript` source with JavaScript syntax highlighting.
- Split console and return-value rendering, syntax-highlighted JSON results, and limited collapsed return values to ten visual lines without counting status or console lines.
- Allowed managed subagents to use `nodeScript` while keeping nested subagent dispatch and collection locked during parent-assigned runs.
- Added concurrent nested calls, cancellation and shutdown cleanup, call traces, and 50KB or 2000-line combined-output truncation with full output saved to a temporary file.
- Documented the required script return value, captured console behavior, and unavailable Node globals in the tool schema.
- Aligned the Pi development dependencies with version 0.84.2.

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
