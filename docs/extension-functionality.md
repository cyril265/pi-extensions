# Extension functionality guide

This document explains the current working-tree implementation of five packages in `/Users/kpovolotskyy/ai-stuff/pi-extensions`. It includes uncommitted and newly added files, rather than describing only committed `HEAD` or a published release. The source checkout's base commit is `c056cb3176a4c1cb1ce0cb66b560c453efa63862`.

The built-in bash comparison is verified against pi 0.99.1. Source references use absolute paths for this checkout and pinned upstream URLs for pi itself. Existing integration and end-to-end coverage was inspected as supporting evidence. The rm-guard researcher ran its existing real-wrapper/container suite and reported 30 passing tests. No live-model, SSH-handoff, or GUI verification was run for this documentation task.

## At a glance

| Extension | Main purpose | How you use it | What it changes |
| --- | --- | --- | --- |
| `rm-guard` | Prevent accidental out-of-project deletion through ordinary `rm` calls | Automatic on model-issued `bash` calls | Prepends a guarded `rm` to the command's `PATH`; asks for blocked paths when UI is available |
| `simple-subagent` | Delegate work to separate pi sessions | Tools, Node client, `/subagents`, optional context-fork tool | Starts and tracks child runs, preserves child sessions, and returns or pushes results |
| `tool-result-trim` | Reduce large tool results sent to the model | Automatic `tool_result` handlers | Shortens text, collapses repetitive lines when needed, preserves complete text in temp files |
| `pi-last-turn-review` | Review or undo a completed coding run and annotate assistant text | `/diff-turn`, `/diff-git`, `/annotate-turn`, `/undo-turn` | Records Git snapshots, opens native review windows, turns comments into a new prompt |
| `remote-handoff` | Move one conversation and its project to a trusted SSH machine, then bring work back | Interactive `/remote-handoff` lifecycle menu | Transfers files, history, profile and credentials; reserves the conversation; reviews and applies returned work |

These are different kinds of isolation. A subagent is a separate process and conversation, not a file-permission sandbox. Remote Handoff moves work to another host without sandboxing it. `rm-guard` is an accident guard for a specific executable name. Tool trimming and diff review do not enforce access controls.

## Installation and common pi concepts

Each directory is a separate pi package. Add the ones you want to the `packages` array in your agent or trusted project settings. This example uses the current checkout location:

```json
{
  "packages": [
    "/Users/kpovolotskyy/ai-stuff/pi-extensions/rm-guard",
    "/Users/kpovolotskyy/ai-stuff/pi-extensions/simple-subagent",
    "/Users/kpovolotskyy/ai-stuff/pi-extensions/tool-result-trim",
    "/Users/kpovolotskyy/ai-stuff/pi-extensions/pi-last-turn-review",
    "/Users/kpovolotskyy/ai-stuff/pi-extensions/remote-handoff"
  ]
}
```

The default agent directory is `$HOME/.pi/agent`; `PI_CODING_AGENT_DIR` can select another directory. Global package settings are in that directory's `settings.json`. Project settings are in the current project's `.pi/settings.json` and load after project trust. Run `/reload` after changing package or extension configuration.

Local package paths are loaded in place. Pi does not install or modify their dependency trees automatically. The review package requires `glimpseui`; Remote Handoff requires `proper-lockfile`. Install their dependencies in their package directories before loading them. The other three packages have no separately declared production dependency tree beyond pi's supplied modules. Four package manifests declare Node `>=26.0.0 <27`; Remote Handoff declares Node `>=22.19.0`.

In the descriptions below:

- A session is a persisted JSONL conversation tree. Only its selected branch supplies model context.
- An agent run can contain multiple model/tool turns. The last-turn-review package snapshots the first turn's start and the run's `agent_end`, rather than recording a separate diff for every tool call.
- `tool_call` runs before execution and can alter or block the call. `rm-guard` uses it.
- `tool_result` runs after execution and can replace the result before it reaches the conversation. `tool-result-trim` uses it.
- A steering message enters while the parent is working. A pushed subagent report can therefore join an existing run instead of requiring a manual prompt.

## Contents

1. [rm-guard](#rm-guard)
2. [simple-subagent](#simple-subagent)
3. [tool-result-trim](#tool-result-trim)
4. [Comparison with pi's built-in bash truncation](#comparison-with-pis-built-in-bash-truncation)
5. [pi-last-turn-review](#pi-last-turn-review)
6. [remote-handoff](#remote-handoff)
7. [How the extensions interact](#how-the-extensions-interact)

## rm-guard

### Purpose and interface

`rm-guard` catches accidental deletion through an ordinary `rm` resolved from `PATH`. It has no slash command, model tool, shortcut, or user configuration file. Loading the package activates a `tool_call` handler for the model's `bash` tool.

The reason to guard the executable rather than inspect command text is shell expansion. The wrapper sees the operands after variables and globs expanded, and after scripts changed directories. It can therefore catch an unset variable turning `rm -rf "$BUILD_DIR"/*` into `rm -rf /*`.

### Execution flow

For each bash call, the extension prepends an `export` command that sets:

| Environment variable | Value and purpose |
| --- | --- |
| `PI_RM_ALLOW` | Colon-separated session cwd, Node's OS temp directory, and `/tmp` |
| `PATH` | The package's `/Users/kpovolotskyy/ai-stuff/pi-extensions/rm-guard/bin` before the existing path |
| `PI_RM_ASK_DIR` | A per-command request directory when UI is available; empty in headless mode |

The shell still runs the original command. Scripts and ordinary subprocesses inherit this environment, so `make clean`, `bash script.sh`, `xargs rm`, and `find -exec rm` can reach the wrapper without special parsing in pi.

When `bin/rm` starts, it canonicalizes all allowed directories. It then checks every existing operand before running the real `/bin/rm` with the original arguments. One blocked operand prevents automatic execution of the entire invocation. An allowed operand is not deleted first while another operand awaits approval.

The allowed project boundary is `ctx.cwd`, not a separately discovered Git repository root. A session started in a repository subdirectory does not automatically allow sibling directories in that repository. A later `cd` changes operand resolution but does not change the allow-list for that bash call.

### Path rules

- Existing files and directories strictly below an allowed directory can pass automatically.
- An allowed directory itself, or a directory containing an allowed root, is blocked from automatic execution. This prevents deleting the project root, temp root, or their ancestors.
- A normal final component is checked through its parent directory. `rm link` can remove a symlink inside the project even when the target is outside.
- A trailing slash, `.` or `..`, and traversal through symlinked parent directories are resolved fully. `rm link/child` cannot use an in-project link to make an external target look local.
- Missing operands are skipped by the guard. The real rm then supplies normal behavior, including a no-op for `rm -f missing`.
- Initial options and `--` are recognized when identifying operands. Actual deletion flags are passed unchanged to `/bin/rm`.

Checks happen before deletion, but this is not an atomic filesystem transaction. Another process changing paths between validation and execution is outside the guard's protection.

### Confirmation and cleanup

With `ctx.hasUI`, the wrapper writes a NUL-separated list of blocked resolved paths to a request file. The extension watches the per-command directory and presents a pi confirmation dialog.

An approval writes an `allow` reply, and the wrapper executes the original rm invocation. That approval can authorize paths that failed the automatic allow-list, including blocked roots. A false confirmation result leaves deletion blocked. The dialog receives the turn's abort signal; host process cancellation can terminate the shell with its own status rather than the wrapper's ordinary refusal status.

Dialogs are serialized through a shared promise. Concurrent bash calls do not open competing confirmation dialogs. Each separate rm invocation requests its own decision; there is no remembered blanket approval.

The wrapper checks for a reply every 100 ms. There is no independent confirmation timeout. If the request directory disappears during cleanup, it treats the operation as declined. The extension removes per-call resources on `tool_result`, and clears any remaining resources at `turn_end`.

While asking, it emits `herdr:blocked` with the label `rm needs confirmation`. Herdr's pi integration can show the pane as blocked. Without a listener, that event has no visible effect.

In headless pi, the allow-list still works, but blocked calls fail immediately instead of waiting for a human.

### Errors and limitations

| Outcome | Behavior |
| --- | --- |
| Outside path, denied confirmation, or headless blocked call | Exit 3, list blocked operands/resolved paths and allowed directories, delete nothing through this invocation |
| Missing/invalid allow-list, inaccessible allowed directory, or an allowed directory resolving to `/` | Exit 64 before deletion |
| A configured directory contains `:` or a newline | Extension refuses to prefix and run the bash command |
| All operands allowed, or explicitly approved | Real `/bin/rm` runs and returns its normal status |

The OS temp directory and `/tmp` are broad allowances. `rm -rf /tmp/*` can remove other jobs' writable data, including logs and subagent artifacts. Allowing temp directories keeps `mktemp` cleanup usable; it does not reserve private temp space for each job.

This package does not intercept `/bin/rm`, `sudo rm`, `find -delete`, `git clean`, `rsync --delete`, Node/Python recursive deletion, or any other program that unlinks directly. It also does not register a `user_bash` handler for manually typed `!` commands. Changing `PATH`, redefining `rm`, or writing an `allow` reply can bypass it. It runs with the same permissions as the guarded command.

The wrapper requires POSIX Bash and Unix utilities, including `/bin/rm`. Drive-qualified Windows directories also contain `:`, which the prefix validator rejects. Native Windows/PowerShell removal protection is not implemented. There is no session-shutdown or crash-recovery cleanup handler, so abnormal termination can leave request directories behind.

### Examples

For a session cwd of `/work/project`:

```bash
rm -rf /work/project/generated
```

This passes automatically, assuming it is an ordinary in-project path.

```bash
rm -rf /work/other-project/generated
```

This asks in a UI-enabled session and fails with exit 3 in headless mode.

```bash
rm -rf /work/project
```

The project root itself is blocked from automatic deletion. Being on the allow-list does not make the root deletable without confirmation.

```bash
scratch=$(mktemp -d)
rm -rf "$scratch"
```

This remains usable when `mktemp` creates the directory below an allowed temp root.

### Source and existing verification

- Command prefix, request watcher, confirmation queue, and cleanup: `/Users/kpovolotskyy/ai-stuff/pi-extensions/rm-guard/index.ts`, lines 20 to 89.
- Canonicalization, operand policy, reply waiting, and final execution: `/Users/kpovolotskyy/ai-stuff/pi-extensions/rm-guard/bin/rm`, lines 4 to 126.
- Existing real-wrapper coverage: `/Users/kpovolotskyy/ai-stuff/pi-extensions/rm-guard/rm.test.ts`.
- Existing destructive Bash 3.2 container scenario, including an unguarded control: `/Users/kpovolotskyy/ai-stuff/pi-extensions/rm-guard/rm.docker.test.ts`.
- The research agent ran the existing suite and reported 30 passing tests, including three disposable-container scenarios. This exercises the real wrapper and request/reply transport, not live pi terminal/RPC dialogs or native Windows behavior.

## simple-subagent

### Purpose and interfaces

This package starts separate pi sessions, tracks their progress, and delivers a combined result when all agents in a job finish. It supports isolated conversations, optional forks of the parent's context, and two execution backends: ordinary child processes or interactive Herdr panes.

| Interface | Behavior |
| --- | --- |
| `runSubAgents({ agents })` | Start isolated agents and return a job ID plus session keys immediately |
| `cancelSubAgents({ jobId })` | Request cancellation of a running job |
| `runSubAgentsWithContext({ agents })` | Optional tool that schedules context forks and returns immediately |
| Node client `dispatch(agents)` | Same scheduling/result-delivery behavior as isolated `runSubAgents` |
| Node client `run(agents)` | Start isolated agents and wait for the combined result as a JavaScript value |
| `/subagents` | Show running jobs, choose one, and confirm cancellation |
| `/subagents cancel <jobId>` | Cancel a running job without the picker |
| `/forkTab` | Fork the current persisted session into an interactive Herdr tab, with no initial prompt |

There is no public polling/join tool. Use asynchronous pushed results when the parent can keep working, or the Node client's `run` when the result must feed another operation in the same script.

### Isolated-agent arguments

`agents` must contain at least one entry:

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | Yes | Display name and basis for result filename/generated session key |
| `prompt` | Yes | Task sent to the child |
| `cwd` | Yes | Absolute working directory; relative paths are rejected |
| `thinking` | Yes | One of `low`, `medium`, `high`, `xhigh`, `max` |
| `overrideModel` | No | Configured alias or explicit `provider/model`; otherwise inherit the caller's current model |
| `sessionKey` | No | Continue a managed child session; otherwise generate a fresh durable key |

The isolated-agent schema rejects unknown fields. Bare model names must be configured aliases. An unknown alias or absent caller model without a usable override fails rather than selecting a different model. Alias targets must be explicit `provider/model` strings.

Names and supplied session keys are sanitized for filenames. Spaces and unsupported characters become hyphens; a value empty after sanitizing is rejected. Use the actual returned session key when resuming, rather than assuming your original spelling is unchanged.

Example:

```json
{
  "agents": [
    {
      "name": "review-auth",
      "prompt": "Inspect authentication changes and report concrete regressions. Do not edit files.",
      "cwd": "/Users/kpovolotskyy/ai-stuff/pi-extensions",
      "thinking": "high"
    },
    {
      "name": "review-api",
      "prompt": "Inspect API changes and report concrete regressions. Do not edit files.",
      "cwd": "/Users/kpovolotskyy/ai-stuff/pi-extensions",
      "thinking": "high"
    }
  ]
}
```

Isolated means no inherited parent transcript. The child loads its own normal pi resources for its cwd and runs with inherited process environment and user permissions. Both backends pass `--approve`, explicitly trusting project-local resources for that child process. Parent-only command-line or SDK extension registration is not automatically injected into the child. In particular, the delegation lock requires this extension to load there through ordinary resource discovery.

It does not receive a new filesystem or Git worktree. Runtime-only authentication in the parent's in-memory SDK is not explicitly forwarded; the child needs credentials available through its own environment/profile. An absolute cwd and slash-containing model selection are not preflight checks of directory existence, provider access, or model availability.

### Configuration

Configuration is `<agent-dir>/simple-subagent.json`, normally `$HOME/.pi/agent/simple-subagent.json`. It loads when the extension loads; reload after changes.

| Field | Default | Behavior |
| --- | --- | --- |
| `enableForkTool` | `false` | Register the context-fork tool for the session |
| `modelAliases` | Empty object | Map short names to explicit `provider/model` values |

Example:

```json
{
  "enableForkTool": true,
  "modelAliases": {
    "sol": "openai-codex/gpt-5.6-sol"
  }
}
```

This makes `overrideModel: "sol"` meaningful and enables the separate context-fork interface. Alias names cannot contain `/` or leading/trailing whitespace. Invalid JSON, a non-object configuration, incorrect option types, or malformed aliases fail loading. Available alias names are included in the isolated tool's description.

Managed-child environment variables also control internal locking and fork registration. `PI_SIMPLE_SUBAGENT=1` marks a managed child, `PI_SIMPLE_SUBAGENT_FORK_TOOL=1` enables inherited fork-tool registration, and `PI_SIMPLE_SUBAGENT_CACHE_KEY` carries cache identity. Herdr launchers additionally publish result/event/prompt/start/abort paths through `PI_SIMPLE_SUBAGENT_HERDR_*` variables. These are runtime plumbing, not ordinary settings to add to your shell profile.

### Scheduling, progress, and delivery

1. Validate agent inputs, resolve effective models, and generate or normalize session keys.
2. Reserve each managed session path. The same cwd/session key cannot run twice concurrently within the owning extension runtime, including across separate jobs.
3. Create a private temporary run directory and prepare child sessions.
4. Start all requested agents through the selected backend. There is no configured concurrency cap or sequential task-chain API.
5. Track each agent's tools, status, final output, model, session IDs/paths, context usage, and available usage data.
6. Save final output to a Markdown file in the run directory.
7. Wait until every agent has settled, then either push one combined report or return it to the Node waiter.

The TUI displays a compact, ticking widget with job counts and each agent's latest tool call. It updates every second and disappears after settlement. The combined report includes each agent's result-file path, session key, session ID, and a copyable `pi --session` command. Results of at most 2,048 characters are also inlined. Longer results must be read from the advertised file.

Ordinary asynchronous completion is delivered with `pi.sendUserMessage(..., { deliverAs: 'steer' })`. While the parent is streaming, it becomes steering input; while idle, it can start a result-processing run. The extension has a T3 Code integration enabled by both `T3_MCP_URL` and `T3_MCP_BEARER_TOKEN`. It initializes an authenticated MCP connection, reads thread configuration, and sends the report with `t3_thread_send` in auto mode. One variable without the other is an error. A T3 delivery failure produces a UI error, with no retry or fallback local push. The job result remains retained; there is no public retrieval-by-job interface.

In pi print/JSON single-shot modes, a `turn_end` handler keeps the parent process alive until pending jobs settle. Returning immediately from the tool does not mean the one-shot parent exits before its agents finish.

The registry retains settled results until its session shuts down. Result files are temporary artifacts, whereas managed child sessions are persistent.

### Node client and local bridge

During each live session, the extension starts an authenticated TCP server on `127.0.0.1` with an OS-assigned port and a random 32-byte token. It sets:

| Variable | Purpose |
| --- | --- |
| `PI_SIMPLE_SUBAGENT_CLIENT` | File URL for the package's `client.mjs` |
| `PI_SIMPLE_SUBAGENT_ENDPOINT` | Session-local `tcp://127.0.0.1:<port>` endpoint |
| `PI_SIMPLE_SUBAGENT_TOKEN` | Authentication token for requests |

Requests and responses are newline-delimited JSON. The bridge validates protocol version, token, method, and isolated-agent schema. The endpoint is local, but the token and the commands run through it are not an OS permission boundary against the same user.

Use the client from a Node process launched inside that live pi environment:

```js
const { run } = await import(process.env.PI_SIMPLE_SUBAGENT_CLIENT)

const result = await run([
  {
    name: 'reviewer',
    prompt: 'Review the current changes. Report findings without editing files.',
    cwd: process.cwd(),
    thinking: 'high',
  },
])

if (result.isError) throw new Error(result.text)
console.log(result.agents[0].output)
```

`dispatch` resolves immediately with `{ jobId, agents: [{ name, sessionKey }] }`. `run` resolves with:

```ts
{
  jobId: string
  isError: boolean
  text: string
  agents: Array<{
    name: string
    sessionKey: string
    status: 'done' | 'failed' | 'interrupted'
    output?: string
    exitCode?: number
    sessionId?: string
    sessionPath?: string
    outputPath?: string
    effectiveModel?: string
    usage?: {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      cost: number
      turns: number
    }
  }>
}
```

A failed child makes `isError` true; it does not itself reject `run`. Connection, authentication, malformed requests, dispatch errors, and reading a missing result file reject. Check the result before consuming optional output. The wire response can include additional internal details beyond the selected fields shown here. Output is the complete recorded assistant text, but recording trims leading/trailing whitespace.

An asynchronous tool receipt remains a successful dispatch receipt even when a child fails later. Later failures are reported in the pushed user message, not by retroactively changing that tool result.

If the waiting script disconnects before settlement, its join is removed, but the job keeps running and its later result is pushed to the parent. Disconnecting after settlement but before the response arrives does not generate a replacement push; the result remains in artifacts and the child session. Shutdown closes the bridge and clears its environment variables.

### Persistent sessions and continuation

Managed JSONL files live in `<agent-dir>/sessions/--simple-subagent--` and are named:

```text
subagent-<16-character-cwd-hash>-<sessionKey>.jsonl
```

The hash derives from the resolved cwd string. A fresh key creates a fresh session; passing a previously returned key with the same cwd resumes that child. The directories are separate from result Markdown files, which are stored under the OS temporary directory.

Managed sessions are stored under pi's agent sessions directory. Pi 0.99.1's global session scan includes JSONL files from each child directory there, so these sessions participate in its global `/resume` list. You can also open the returned absolute session path with `pi --session`. Cancellation and failures report keys so partial child history can still be continued.

Session-path reservation prevents duplicate concurrent use inside this parent runtime. It is not a filesystem lock coordinating every independent pi process on the machine.

### Context forks

With `enableForkTool: true`, `runSubAgentsWithContext` exposes `name`, `prompt`, and optional `sessionKey`. Its schema is looser than the isolated schema, so isolated-agent unknown-field/minimum-string validation should not be assumed for forks. The public tool inherits cwd, model, and thinking from the parent; it does not expose isolated-agent overrides.

It first reserves a job and returns scheduling details with `terminate: true`. Children are started from `turn_end`, after the scheduling tool result has been persisted. The copied parent branch therefore includes a completed tool result rather than a dangling tool call. Host batch termination rules still determine whether that termination request ends the scheduling run.

A fork requires a persisted parent session. A child receives a unique session ID and sidecar `.fork.json` metadata recording its source parent, cwd, model, provider, thinking, and prompt-cache identity. Reusing a fork key checks those recorded invariants. A fork cannot be resumed through the isolated tool, and an incomplete session/metadata pair is an error.

Where the provider payload supports `prompt_cache_key`, the child can reuse the parent's cache identity. The report explicitly states first-turn cache-hit or cache-miss usage. This is cache-routing support, not a promise that a provider will produce a hit.

`/forkTab` is separate. It requires Herdr, a persisted session, and a current model. It opens a normal interactive fork tab inheriting model/thinking, with no assigned task or combined job report. It is available independently of whether the context-fork tool is enabled.

### Herdr backend

Inside Herdr, tool agents use real interactive pi panes in one background tab named `Subagents` per workspace. Progress/results travel through a local event bridge. Pane layout splits the largest available area; before a new run, finished panes close while active panes remain.

The companion plugin supplies a grouped Subagents overlay and a projection that hides tagged child panes from Herdr's built-in Agents view. They remain actual panes visible through `agent list`.

The overlay groups agents by parent, puts currently active groups first, and then sorts by recorded recency. It supports All/Active/Unseen filters. Its keys are Up/Down or `j`/`k` to select, Enter to open, Tab to change filters, `x` to close a finished selected pane, `X` to close finished panes in the filter, and Escape/`q` to close the overlay. Mouse selection and scrolling work too. Opening a completed pane through the overlay's successful focus helper marks it Viewed and removes it from Unseen. Other ways to focus a pane do not update this viewed record. The Herdr plugin declares Linux/macOS support, and its workspace setup lock explicitly rejects Windows.

Herdr integration is optional. Setup requires linking this package's companion plugin and installing Herdr's pi lifecycle integration, then binding or opening `local.simple-subagent`'s `subagents` entrypoint. Herdr owns one global transient Agents-view projection, so another plugin can prevent this package from claiming it.

Failure during Herdr setup before any child pane starts falls back to child-process execution and records the reason. Failure after pane creation fails that backend run rather than launching a duplicate job in the other backend.

### Cancellation, failures, and delegation limits

A job owns its own AbortController. Use the cancellation tool or `/subagents cancel` to cancel it. Process-mode cancellation sends SIGTERM to the direct pi child, then SIGKILL after five seconds if it remains unsettled. It does not explicitly kill a complete descendant process tree. Herdr cancellation first requests an abort through its marker and can close a nonresponding pane after bounded waits. A cancelled or failed job retains successful siblings' results and reports interrupted/failed children separately. Cancellation of a missing or already-settled job is not treated as success.

Session shutdown, a new session, or a session switch cancels pending jobs and suppresses result delivery into the outgoing conversation. Merely aborting the parent's active turn is not the same as shutting down its session; isolated jobs are not tied to the dispatch tool's ignored abort signal.

During a parent-assigned managed-child run, isolated/context-fork tools and the Node client's dispatch/run path reject delegation. They remain declared so the provider's tool prefix does not change. `agent_settled` unlocks them for normal interactive continuation in a retained Herdr pane. A later assigned run using the same key locks them again.

These locks constrain this extension's interfaces. They do not prevent a child shell from starting unrelated programs or invoking pi directly. Child processes and panes have the user's credentials and filesystem permissions. No per-agent token budget, spend cap, timeout setting, sandbox, or automatic worktree is provided.

### Source and existing verification

- Package/factory and `/forkTab`: `/Users/kpovolotskyy/ai-stuff/pi-extensions/simple-subagent/index.ts` and `/Users/kpovolotskyy/ai-stuff/pi-extensions/simple-subagent/extensions/extension.ts`.
- Tool schemas, scheduling, cancellation, widgets, delivery, and locking: `/Users/kpovolotskyy/ai-stuff/pi-extensions/simple-subagent/extensions/tools.ts`.
- Agent preparation, backend choice, result saving, and context forks: `/Users/kpovolotskyy/ai-stuff/pi-extensions/simple-subagent/extensions/execute-subagents.ts`.
- Job settlement, joiners, disconnect ownership, and shutdown: `/Users/kpovolotskyy/ai-stuff/pi-extensions/simple-subagent/extensions/jobs.ts`.
- Durable session names and fork metadata: `/Users/kpovolotskyy/ai-stuff/pi-extensions/simple-subagent/extensions/sessions.ts`.
- Pi global session discovery: [pinned session-manager source](https://github.com/earendil-works/pi/blob/fddc968b96052176e0f570949df2bdfdd700c740/packages/coding-agent/src/core/session-manager.ts#L1949-L1963).
- Node API/protocol: `/Users/kpovolotskyy/ai-stuff/pi-extensions/simple-subagent/client.mjs` and `/Users/kpovolotskyy/ai-stuff/pi-extensions/simple-subagent/extensions/client-bridge.ts`.
- Configuration and aliases: `/Users/kpovolotskyy/ai-stuff/pi-extensions/simple-subagent/extensions/config.ts` and `/Users/kpovolotskyy/ai-stuff/pi-extensions/simple-subagent/extensions/model.ts`.
- T3 routing: `/Users/kpovolotskyy/ai-stuff/pi-extensions/simple-subagent/extensions/t3-delivery.ts`.
- Herdr process/pane implementation: `/Users/kpovolotskyy/ai-stuff/pi-extensions/simple-subagent/extensions/herdr-runner.ts`, `/Users/kpovolotskyy/ai-stuff/pi-extensions/simple-subagent/extensions/herdr-child.ts`, and `/Users/kpovolotskyy/ai-stuff/pi-extensions/simple-subagent/herdr`.
- Existing real-model client lifecycle coverage: `/Users/kpovolotskyy/ai-stuff/pi-extensions/simple-subagent/evals/client-lifecycle.test.ts`. Other integration coverage includes real TCP/client/SDK and artifact/session flows. Some offline provider/Herdr protocol cases use test-controlled services; they are not real hosted-model or full Herdr UI verification. The live suite uses real model/child runs, but its claimed session-lock coverage is actually in offline integration. No direct T3 or demonstrated Windows end-to-end coverage was found. These files were inspected, not executed for this guide.

## tool-result-trim

### Purpose and interface

This package reduces text in completed tool results before it enters pi's conversation. It exposes no slash command, model tool, or shortcut. It registers one bash-specific `tool_result` handler and one generic handler for other tools.

It preserves full text in temp files so a compact result does not permanently discard the omitted data. This reduces context use; it is not secret redaction.

### Which results are processed

- `bash` always uses the dedicated handler.
- `read` is always left alone. Use pi's normal `offset` and `limit` pagination for file reads.
- Other tool names are processed by the generic handler unless excluded or absent from an explicit include-list.
- Generic processing works independently on each text content block. Non-text blocks, including images, remain in place.
- Empty, whitespace-only generic text blocks and `(no output)` are skipped.

`includeTools` and `excludeTools` filter only the generic handler. They cannot disable the dedicated bash handler, and adding `read` to `includeTools` cannot enable read trimming. `bash` and `read` are forcibly included in the generic exclusions to prevent duplicate bash handling and preserve read pagination.

### Configuration

The configuration file is `<agent-dir>/extensions/pi-tool-result-trim.json`, normally `$HOME/.pi/agent/extensions/pi-tool-result-trim.json`. `PI_CODING_AGENT_DIR` selects the agent directory, including support for a leading `~`.

Configuration loads once when the extension loads. A missing file uses built-in defaults. Invalid JSON, an unreadable file other than a missing one, or invalid recognized values fail extension loading. Run `/reload` after changing the file.

| Option | Default | Meaning |
| --- | --- | --- |
| `maxLineWidth` | 180 | Lines longer than this are candidates for middle shortening |
| `trimmedWidth` | 150 | Approximate amount of original line text retained, excluding the shortening marker |
| `headRatio` | 0.8 | Fraction of retained individual-line text taken from the beginning |
| `maxTotalTokens` | 2000 | Per-text-block character budget, estimated as tokens times 4 |
| `minTokensToTrim` | 200 | Blocks below this estimated size bypass all shortening and collapsing |
| `minDedupLines` | 4 | Minimum consecutive similar-run length eligible for collapsing |
| `includeTools` | Unset | When set, generic trimming only processes the exact names listed |
| `excludeTools` | `bash`, `read` | Additional generic exclusions can be supplied; bash/read stay excluded regardless |

Width, total-budget, and dedup options must be positive integers. The minimum trim threshold must be a non-negative integer. `headRatio` must be a number between 0 and 1. Include/exclude lists must be arrays of strings. The code validates each option separately; it does not require, for example, `trimmedWidth` to be less than `maxLineWidth`.

Example of changed settings, rather than restating defaults:

```json
{
  "maxTotalTokens": 3000,
  "excludeTools": ["grep"],
  "minDedupLines": 6
}
```

This raises the approximate budget, skips generic grep results, and requires longer repetitive runs before collapse. Bash is still trimmed and read is still untouched.

### Trimming algorithm

The package uses JavaScript string length divided by 4 as a token estimate. It does not load a tokenizer or measure UTF-8 bytes. Non-ASCII text therefore does not have the same budget semantics as pi's byte limit.

1. If the raw block is shorter than `minTokensToTrim * 4` characters, return it unchanged. With defaults, even a wide single line below 800 characters passes untouched.
2. Shorten lines longer than `maxLineWidth`. By default, keep approximately 120 characters from the beginning and 30 from the end, separated by ` [...] `. Surrogate-pair boundaries receive explicit handling.
3. Calculate whether the shortened lines fit within `maxTotalTokens * 4` characters.
4. Only if middle rows would need omission, try collapsing consecutive similar lines.
5. Apply row trimming again to the collapsed result. Keep approximately half the character budget from the beginning and half from the end, with `[... N lines omitted ...]` between them.

Row trimming keeps at least the first and last row when possible. The omission marker and result header add characters beyond the budget. This is an approximate output target, not a strict token ceiling. It is also per block, not a shared budget for a multi-block tool result.

### What counts as repetitive

The deduplication routine tokenizes words, numbers, whitespace, and other characters. It compares two adjacent lines to construct a common prefix/suffix pattern. Differing numbers can become variable slots, and a differing middle can become `*`.

The initial pair must share at least 15 fixed characters and fixed text covering at least half the longer line. Their lengths cannot differ by more than a factor of 1.5 when the shorter is nonempty. Subsequent lines must match the inferred pattern, and the run must reach `minDedupLines`.

The first line survives, followed by a marker such as:

```text
[× 9 similar: Downloading artifact * bytes]
```

The marker reports the other nine lines collapsed into the pattern. This is consecutive-run compression, not global deduplication and not a semantic log summary. Similar-looking lines can contain distinct values; read the full artifact when those values matter.

### Full-text preservation

The generic handler reuses `details.fullOutputPath` only when the result has exactly one text block and the referenced file is readable. Otherwise, if any block changes, it writes a new temp file named along the lines of `pi-tool-result-trim-<pid>-<counter>-<tool>.txt`.

A single-block artifact contains that original text. For multiple text blocks, the artifact includes the tool name, tool-call ID, and labeled sections for all original text blocks. Unchanged blocks and non-text blocks remain unchanged in the returned result.

A trimmed generic block begins with:

```text
[Tool result trimmed: ... Full text: /absolute/temp/path]
```

The dedicated bash handler recovers pi's complete saved output when available, strips pi's old truncation notice from displayed fallback text, and protects the ordinary nonzero-exit suffix. A trimmed bash result begins with:

```text
[Trimmed: ... Full output: /absolute/temp/path]
```

Both headers describe the actual transformations, such as repetitive lines collapsed, middle lines omitted, or long lines shortened. A result that needs no transformation passes through without a new artifact or header.

The extension does not clean up artifacts. Saved paths refer to files on the machine where the tools ran. Temp files can contain credentials, source code, or other sensitive text omitted from the compact result.

### Source and existing verification

- Configuration, generic filtering, block handling, and artifact formatting: `/Users/kpovolotskyy/ai-stuff/pi-extensions/tool-result-trim/src/index.ts`, lines 59 to 303.
- Bash full-log recovery and replacement: `/Users/kpovolotskyy/ai-stuff/pi-extensions/tool-result-trim/src/bash.ts`, lines 10 to 37.
- Default values, line shortening, conditional dedup, and row retention: `/Users/kpovolotskyy/ai-stuff/pi-extensions/tool-result-trim/src/trim.ts`, lines 3 to 149.
- Similar-run matching: `/Users/kpovolotskyy/ai-stuff/pi-extensions/tool-result-trim/src/dedup.ts`, lines 19 to 168.
- Exit suffix and temp-file helpers: `/Users/kpovolotskyy/ai-stuff/pi-extensions/tool-result-trim/src/tool-output.ts`.
- Existing real-pi integration coverage: `/Users/kpovolotskyy/ai-stuff/pi-extensions/tool-result-trim/index.integration.test.ts`. The harness uses a real model and actual bash/find execution, with Node and optional Bun runtimes.
- Adapted MIT-licensed algorithm attribution: `/Users/kpovolotskyy/ai-stuff/pi-extensions/tool-result-trim/THIRD_PARTY_NOTICES.md`.

## Comparison with pi's built-in bash truncation

The comparison below is pinned to pi 0.99.1, the installed version inspected for this document. Upstream source was cloned using GitHub CLI and verified to report that same version at commit `fddc968b96052176e0f570949df2bdfdd700c740`.

### Built-in behavior without this extension

Pi combines stdout and stderr, collects output incrementally, and produces a tail-oriented model-facing result.

- The limits are 2,000 lines and 50 KiB of UTF-8 text. Whichever limit is reached first determines the retained tail.
- It keeps complete lines from the end. If the last line alone exceeds 50 KiB, it keeps the end of that line at a valid UTF-8 boundary.
- It does not shorten individual long lines, collapse repetitive runs, or reserve room for the beginning of the output.
- Once output exceeds a limit, the accumulator writes complete raw output to a temporary `pi-bash-<random>.log` file. The final text includes a `[Showing lines ... Full output: ...]` or `[Showing last ... Full output: ...]` notice, and `details.fullOutputPath` identifies the file.
- The accumulator bounds its retained display data while streaming. It does not need to keep a huge completed log in memory.
- A successful command with no output returns `(no output)`. Nonzero exits append `Command exited with code N` and mark the result as an error. Timeout and abort paths report their own status.

There is a separate programmatic output path in this pi version. Bash defines `structuredContent` containing `output`, `truncated`, optional `full_output_path`, `exit_code`, and `wall_time_seconds`. That `output` has a 1 MiB budget, keeping the first and last 512 KiB around an omission marker for larger results. This is not the 50 KiB model-facing tail limit.

### What tool-result-trim changes

The extension does not replace bash or change its execution. It runs a `tool_result` handler after the normal tool has finished.

1. It looks for the original full-output file through `details.fullOutputPath`, or through pi's trailing full-output notice.
2. If readable, it loads that complete text. Consequently, the head of a large command output can reappear even though built-in bash had discarded it from the display tail.
3. It applies the extension's long-line, repetitive-run, and head/tail row trimming to that text.
4. If trimming happens, it replaces the final result with its own compact text and `[Trimmed: ... Full output: <path>]` header. It reuses pi's saved file when available.
5. If its algorithm makes no change, it leaves the original bash result alone. Recovering the full log does not itself force replacement.

| Behavior | Built-in bash | With tool-result-trim |
| --- | --- | --- |
| Main model-facing limit | 2,000 lines or 50 KiB | Approximate 2,000 tokens by default, using characters divided by 4 |
| Which part survives | Tail | Head and tail after line shortening and possible run collapsing |
| Per-line shortening | None | Lines over 180 characters keep about 120 leading and 30 trailing characters, plus ` [...] ` |
| Repetitive lines | Kept verbatim until tail truncation | Similar consecutive runs can collapse if row omission would otherwise be necessary |
| Small outputs | Unchanged within the hard limits | Outputs below 200 estimated tokens are left untouched, including long lines |
| Full output | Saved when built-in limits are exceeded | Saved whenever extension trimming happens, even below built-in limits; existing saved file reused |
| Streaming display | Normal incremental tail updates | Unchanged; compaction happens to the completed result |
| Budget precision | Hard line/UTF-8 byte limits on displayed output | Approximate character budget; notices and forced edge rows can exceed it |
| Other tools | Tool-specific built-in behavior | Generic text-block trimming as well, except `read` and configured exclusions |

`headRatio` controls how much of a shortened individual line comes from its beginning. It does not control row retention. Row trimming splits the character budget approximately equally between the beginning and end.

### Practical differences

A 12 KiB build log is below pi's 50 KiB limit, so built-in bash keeps it all. The extension can shorten it because 12 KiB of ASCII is above the default approximate 8,000-character budget.

A very large log with important initialization output and a final failure loses its initialization section under normal tail truncation. When the saved log is readable, the extension can show both the initialization and the failure.

A minified JSON line above the minimum-size threshold can be shortened even if the entire output is below 50 KiB. A single 500-character line does not trigger extension trimming with the default 800-character minimum.

Repeated progress lines do not collapse solely because they repeat. Deduplication runs only if line-shortened output would otherwise require middle-row omission. The similarity algorithm is textual, not aware of log severity or JSON structure.

### Integration caveats verified in pi 0.99.1

- Both extension handlers return replacement `content` without replacement `structuredContent`. Pi's `emitToolResult` explicitly removes existing structured content in this case. A trimmed result therefore does not preserve bash's original structured JSON payload, or another tool's structured payload. Unchanged results do preserve it.
- The bash handler replaces `details` with only `fullOutputPath`; pi's original truncation metadata is not preserved in a trimmed result. It also replaces the content array with one text block, so atypical additional blocks are not retained. The generic handler preserves block order/non-text blocks and does not replace details.
- If the saved full-output file is unreadable, the handler works with the text available in the event. It cannot reconstruct missing output.
- Only the standard trailing `Command exited with code N` suffix receives explicit protection. Timeout and abort messages do not have a dedicated preservation rule in this extension.
- Temp artifacts can contain secrets and are not deleted by this extension. The trim header is a pointer to retained data, not redaction.
- Do not load a separate `pi-bash-trim` package beside this package. Both would process bash output.

### Pinned upstream sources

- [Bash tool definition and execution](https://github.com/earendil-works/pi/blob/fddc968b96052176e0f570949df2bdfdd700c740/packages/coding-agent/src/core/tools/bash.ts), especially the output schema, final formatting, and error paths.
- [Default limits and tail truncation](https://github.com/earendil-works/pi/blob/fddc968b96052176e0f570949df2bdfdd700c740/packages/coding-agent/src/core/tools/truncate.ts).
- [Streaming output accumulator and full-output preservation](https://github.com/earendil-works/pi/blob/fddc968b96052176e0f570949df2bdfdd700c740/packages/coding-agent/src/core/tools/output-accumulator.ts).
- [Tool-result handler composition and structured-content removal](https://github.com/earendil-works/pi/blob/fddc968b96052176e0f570949df2bdfdd700c740/packages/coding-agent/src/core/extensions/runner.ts#L1174-L1227).

## pi-last-turn-review

### Purpose and commands

The package records Git before/after snapshots around a coding run and opens a native desktop window for file review or assistant-response annotation. It also offers guarded undo of the latest recorded changed run.

| Command | Scope and behavior |
| --- | --- |
| `/diff-turn` | Review the latest completed run with reviewable file changes on the active session branch |
| `/diff-git` | Review the current worktree against HEAD, including non-ignored untracked files |
| `/annotate-turn` | Annotate the latest text-bearing assistant message in the active conversation branch |
| `/undo-turn` | Restore the latest changed run's pre-run file state, only when all undo checks pass |

The commands take no meaningful arguments; their handlers ignore the argument string. The package adds no model tool or pi keyboard shortcut. Window-local keyboard shortcuts are described below.

Install the package's production dependency `glimpseui` before loading a local checkout. Diff rendering, Markdown rendering, syntax-worker bundles, and CSS are prebuilt under `/Users/kpovolotskyy/ai-stuff/pi-extensions/pi-last-turn-review/web/vendor` and inlined into window HTML. Opening a review does not download those assets from a CDN.

### What "turn" means here

Despite the command name, the file snapshot covers an agent run, potentially including multiple tool/model turns:

1. `before_agent_start` saves the submitted prompt text.
2. On `turn_start` with `turnIndex === 0`, find the Git repository root and capture the whole worktree tree.
3. At `agent_end`, capture the worktree again.
4. If the tree changed and there are reviewable files, create persistent before/after snapshot commits, update a private retention ref, and append a custom session entry.

A later run without reviewable changes does not replace the previous recorded snapshot. Thus `/diff-turn` means the latest changed run, not necessarily the latest assistant answer.

The snapshot is a whole-worktree comparison. Pre-existing dirty files become part of its baseline. Changes by another process during the run can be included; the package does not track tool ownership or authorship.

### Git storage and persistence

Capture uses a temporary `GIT_INDEX_FILE`, initializes it from HEAD when available, runs `git add -A`, and writes a Git tree. It does not stage changes in your actual index or move your branch.

Snapshot commits are ordinary Git objects created with `git commit-tree`. A keepalive commit retains the latest before/after pair under:

```text
refs/pi-last-turn-review/sessions/<sanitized-session-id>
```

The session receives a `last-turn-review` custom entry containing the repository root, snapshot commit IDs, prompt, and completion timestamp. On `session_start` and session-tree navigation, the extension scans the active branch backward to restore the most recent valid snapshot whose Git objects still exist.

An undo appends `last-turn-review-undo`. Restoration stops at that entry, so it does not silently offer an older run as the next undo. Undo also removes the latest snapshot ref and in-memory record. This is a one-run undo operation, not an undo/redo stack.

The custom entry is durable session metadata rather than an ordinary model-facing message. The Git objects contain complete snapshotted file contents, including data that has not been committed on your normal branch.

### File diff review

`/diff-turn` compares the stored snapshot commits, so later file edits do not change what that historical diff displays. It checks that the current cwd belongs to the same repository as the saved snapshot.

`/diff-git` uses current files. In a repository with HEAD, tracked differences include staged and unstaged worktree contents relative to HEAD, plus non-ignored untracked paths. It does not display index and worktree changes as separate review stages. In an unborn repository, known cached/untracked paths are treated as added.

Changed paths are classified as added, modified, deleted, or renamed. Git rename detection is enabled. The visible list excludes a fixed set of binary/archive/media/font/object-file extensions, `.map`, and `.min.js`/`.min.css`. This is filename-based filtering, not a universal binary detector.

The native window has:

- All changed files stacked in one scrollable region.
- Sticky file headers and a sidebar that follows scrolling.
- Unified/split layout, line wrapping, and full-file-context controls.
- Clickable old-side or new-side line numbers for a single-line comment.
- Dragging across line numbers for a range comment.
- File-level comments, mark-reviewed state, and per-file collapse.
- An overall comment and submit/cancel actions.
- `j` and `k` to move between files, and Cmd/Ctrl+Enter to finish.

File content crosses the host/window bridge through request messages. The window requests every review file at startup, not just the visible file. There is no application-level file-size or load-concurrency cap. Syntax highlighting runs in web workers with bundled language grammars; the README describes other languages as plain text. The active pi theme selects a fixed light or dark palette when the window opens.

Only one diff or annotation window can be open per extension runtime. Pi shows a waiting view in the terminal; Escape closes the window and cancels the operation. Closing the native window likewise returns without feedback. Shutdown clears the waiting UI and closes the active window.

### What happens when feedback is submitted

Submission composes a prompt from the overall comment and file/line/range comments. Old-side line comments retain an `old` location label. The prompt starts with `Please address the following code review comments.`

Crucially, the extension calls `ctx.ui.setEditorText`. It does not automatically submit that prompt or start another agent run. You can inspect or edit the generated feedback before pressing Enter. It replaces the editor's contents rather than appending to an existing draft.

Marking a file reviewed is window review state; it is not a separate instruction to the agent in the composed feedback.

### Assistant-response annotation

`/annotate-turn` scans the active branch backward for the latest assistant message with nonempty text. A newer tool-only assistant message is skipped. There is no check that the selected message is the final answer of a successful run. Annotation does not require a Git repository.

It renders Markdown and supports comments on headings, paragraphs, list items, table rows, single code lines, and selected text passages. A selection contained in one anchor keeps the selected quotation. A selection spanning blocks records their Markdown source-line range instead.

The generated prompt starts with `Address this feedback:` and includes an overall note when supplied, plus quoted passages and comments. Quotations are capped at 300 characters. It does not insert the complete original response into the prompt. Feedback goes into the pi editor for manual submission.

Copy text uses the selected text or, when nothing is selected, the whole original Markdown. Local clipboard commands are `pbcopy` on macOS, `clip.exe` on Windows, and `wl-copy`, `xclip`, or `xsel` on other platforms. Annotation has no global Cmd/Ctrl+Enter finish shortcut. The finish button stays disabled until a nonempty comment or overall note exists.

No text-bearing assistant message means nothing can be annotated. Diff and annotation windows require pi UI availability and a desktop environment able to run Glimpse; they are not headless model tools. Inline UI bundles do not establish a blanket offline guarantee for arbitrary Markdown images or links.

### Undo behavior

`/undo-turn` and the Undo turn button in a `/diff-turn` window share the same operation. The window's button discards pending review comments and asks for confirmation in the pi terminal. `/diff-git` has no corresponding turn-undo scope.

Undo proceeds only after:

1. Restoring the current session branch's snapshot and checking the repository matches.
2. Confirming the entire current captured worktree equals the saved after-tree.
3. Computing all paths changed between the before and after snapshots.
4. Asking you to confirm the listed changes.
5. Rechecking the current tree before mutation and validating affected paths.
6. Refusing staged index changes on any affected path.
7. Refusing unmodeled files or directories that would be overwritten or recursively deleted.

It removes modeled added/new rename paths, restores old paths through `git restore --worktree` from the before-snapshot, and verifies the resulting tree equals the expected before-tree. Unrelated staged entries stay unchanged. The command does not rewind conversation messages or restore a prior model configuration.

The visible diff can exclude binary files, while the undo path operates on the complete snapshot difference. If a recorded run changed both reviewable text and a binary file, undo includes the binary change too. The terminal confirmation lists changed paths before execution.

### Errors, limits, and source references

No Git repository, no saved changed snapshot, a different current repository, missing Git objects, or no reviewable current files produce notifications rather than invented diffs. Snapshot capture failures at run start simply leave no new baseline; persistence failures at run end warn. Native-window and renderer failures produce notifications. File-content loaders convert failed `git show` and filesystem reads into empty contents, so an empty diff side does not prove an empty file.

Current-Git review is not frozen or locked. The file list is enumerated before content loads, and each first content load is cached for that window. Concurrent edits can produce a mixed-time view. The display parser also uses newline/tab-separated Git output rather than NUL-delimited paths, so unusual filenames are not robustly supported.

Undo is not transactional. It deletes new paths before restoration and verification, with no rollback for a later failure. Its checks reduce accidental overwrite risk but do not prevent concurrent filesystem races.

This is review and guarded worktree restoration, not a backup system. It cannot undo arbitrary later edits, staged changes on affected files, index-only operations, Git history changes, ignored-file changes, or external side effects. Snapshot Git objects also deserve the same privacy care as other repository data.

- Lifecycle registration and commands: `/Users/kpovolotskyy/ai-stuff/pi-extensions/pi-last-turn-review/src/index.ts`, lines 1338 to 1597.
- Snapshot commit/ref storage and guarded undo: the same file, lines 223 to 544 and 1256 to 1335.
- Native-window flow and insertion into the editor: the same file, lines 975 to 1240.
- Current/historical diff enumeration and file filtering: `/Users/kpovolotskyy/ai-stuff/pi-extensions/pi-last-turn-review/src/git.ts`.
- Feedback formatting: `/Users/kpovolotskyy/ai-stuff/pi-extensions/pi-last-turn-review/src/prompt.ts`.
- Diff and annotation HTML: `/Users/kpovolotskyy/ai-stuff/pi-extensions/pi-last-turn-review/src/ui.ts`, with window scripts under `/Users/kpovolotskyy/ai-stuff/pi-extensions/pi-last-turn-review/web`.
- Existing real-window pointer-event review coverage: `/Users/kpovolotskyy/ai-stuff/pi-extensions/pi-last-turn-review/test/harness.mts` and `/Users/kpovolotskyy/ai-stuff/pi-extensions/pi-last-turn-review/test/smoke.js`.
- Existing Markdown annotation window coverage: `/Users/kpovolotskyy/ai-stuff/pi-extensions/pi-last-turn-review/test/annotate-harness.mts` and `/Users/kpovolotskyy/ai-stuff/pi-extensions/pi-last-turn-review/test/annotate-smoke.mts`.

## remote-handoff

### Purpose and interface

Remote Handoff moves one selected pi conversation branch and a project snapshot to a trusted SSH host. It starts interactive pi there, supports detach/reattach and continuation, then brings conversation history, credentials, and reviewed file changes back.

It is a personal interactive workflow, not a remote job queue or sandbox. Starting a handoff does not send an autonomous task prompt. After automatic attachment, you continue the conversation in remote pi yourself.

The local command is `/remote-handoff` with no arguments. Extra arguments are rejected. It requires pi TUI mode; terminal attachment, paging, and merge review also need TTY stdin/stdout. No model tool, registered pi shortcut, separate executable, or extension-specific CLI flag is provided.

### Requirements and saved hosts

| Local machine | Remote host |
| --- | --- |
| Git, `less`, pi, Node 22.19+, npm, OpenSSH `ssh` and `scp` | Bash, Git, Node 22.19+, npm, tar, flock, pkill, OpenSSH ssh |
| Batch-mode SSH/scp access and an active session with an absolute persisted session path | Registry access for private pi/runtime and uncached dependency installation |
| Local agent `settings.json` and valid `auth.json` | Herdr 0.8.2+ or the tools/network access needed by its official installer |
| A Git project with at least one commit and configured Git identity, or an ordinary directory | Task-specific compilers, browsers, CLIs, and other dependencies already installed |

The persisted local session file need not have been materialized yet. The extension can retain its manager header/branch and create it on return. Existing Git projects need an identity because handoff snapshots are actual Git commits. Ordinary-directory private repositories get an extension identity.

The diff viewer forces `GIT_PAGER=less`. Full Git for Windows includes it; MinGit does not satisfy that requirement by itself. Local source has Windows branches, but the remote runtime needs a Unix-like host with the listed tools. A macOS remote without `flock` fails preflight.

Hosts are managed through the `remotes` menu and stored in `<agent-dir>/pi-remote-handoff-remotes.json` as a JSON array. One saved host is selected automatically; several produce a picker; none prompts for a target. Targets are `host` or `user@host` using letters, digits, `_`, `.`, and `-`. Inline ports, IPv6 literals, spaces, URLs, and extra SSH options are not accepted. Use an SSH config alias for a nonstandard port or identity configuration.

SSH/scp use batch mode, a 10-second connect timeout, and a five-second server-alive interval. The extension does not unlock keys, request passwords, disable host-key checks, or enable agent forwarding. Recognized locked-key failures report `Your SSH key is locked`.

On macOS/Linux, it can share a connection through a private temp-directory control socket, with `ControlPersist=60`. Directory ownership, permissions, and path constraints must pass; otherwise it uses separate connections. Windows uses separate connections for every step.

Herdr is searched on PATH, in `$HOME/.local/bin/herdr`, and in `$HOME/.pi-remote-handoff/herdr/herdr`. If absent or too old, Remote Handoff invokes the official installer into its own managed directory and checks the resulting version. Checksum behavior belongs to that external installer, not a verifier implemented in this extension.

### Local menu states

Menu entries change with the stored local phase and observed remote state. These are actions selected in the menu, not `/remote-handoff <action>` arguments.

| State | Actions |
| --- | --- |
| No handoff | Start; manage saved remotes |
| Startup reserved or uncertain | Check startup status |
| Remote run active | Attach; status; stop and prepare result |
| Remote run stopped without a result | Continue remotely; status; discard |
| Result prepared | View diff; continue remotely; apply; discard |
| Incomplete remote workspace | Status; discard |
| Local apply/return interrupted | Continue apply recovery or ownership return |
| Apply succeeded but cleanup failed | Retry cleanup; cleanup status |
| Host classified unreachable | Retry connection; abandon unreachable handoff |

A separate attachment lease prevents two local controllers from simultaneously owning the terminal. Another controller's attachment restricts the menu to status/retry and prevents concurrent recovery.

One project can have one handoff. Git projects are keyed by their common Git directory, so linked worktrees cannot start separate handoffs. Ordinary directories are keyed by their canonical absolute cwd. Different projects can have handoffs at the same time.

### Starting and reserving ownership

1. Wait for local pi to be idle, resolve the project, reject unsupported repository features, and check the selected host/runtime prerequisites.
2. Export the session header and active conversation branch. Preserve a local original-branch copy and hash the original session file or its not-yet-materialized equivalent.
3. Snapshot project contents with a temporary Git index. Create a private handoff ref/commit and bundle its reachable history, leaving the real index and user branch unchanged.
4. Build a portable pi profile, save the credential baseline, and create a fresh header-only local control conversation.
5. Save a `reserved` task with handoff/task/launch IDs before upload starts. The original conversation is now locally blocked while remote launch is uncertain.
6. Upload, prepare the private remote workspace/profile/runtime, and launch pi under the recorded launch ID.
7. Reconcile remote launch records. A confirmed matching launch promotes ownership to the remote task, switches local pi to the control conversation, and attaches.

The launch ID is recorded remotely under `flock` before starting Herdr/pi. A lost SSH acknowledgment is reconciled against that ID rather than blindly launching another process. A matching launch proves launch ownership, not successful provider authentication or a healthy first model request.

The extension blocks ordinary input, resuming, forking, tree navigation, and compaction of the original conversation while remote ownership is active. Unrelated local conversations and repository edits remain available. Opening the original remotely owned conversation directly can shut down that local pi with an explanation. These are cooperative extension checks, not OS protection against another program editing session files.

### What goes remote

| Data | Scope |
| --- | --- |
| Conversation | Header plus the active branch, rewritten to remote cwd; not every abandoned branch |
| Project files | Tracked and non-ignored untracked files in Git, or non-ignored files in an ordinary directory |
| Git history | History reachable from the handoff snapshot, not every repository ref |
| Pi profile | Settings, configured existing local packages/resources, selected agent files, and shared skills |
| Pi credentials | Separate private authentication file with a baseline for later three-way return |

Submodules, embedded repositories/gitlinks, content filters, and Git LFS are unsupported. Ignored files and empty filesystem directories are not a general archive payload. Historical tracked secrets can travel through the Git bundle even when current ignore rules would hide a working file.

Ordinary-directory mode keeps private Git metadata under `<agent-dir>/remote-handoff/directories/<canonical-cwd-hash>`. It never creates `.git` inside the project. If someone runs `git init` while that handoff is active, the task keeps using its private repository and does not read or remove the newly created project `.git`.

### Portable profile details

Existing local packages are copied into the private profile and their settings paths are rewritten. Explicit local extension/skill/prompt/theme resources are copied too, including a containing package where required. Conventional agent resources, system/append prompts, instruction files, models, keybindings, presets, and `simple-subagent.json` are included. `$HOME/.agents/skills` is copied when present.

This is an allowlisted profile, not the whole local home or agent directory. Local session archives, arbitrary top-level agent files, and the saved remote-host list are not generally copied. Global `mcp.json` is not in the top-level copied-file list. Project `.pi` configuration can still travel as ordinary project files when eligible.

Package sources such as `npm:` or `git:` remain source declarations for remote pi rather than copied local trees. Missing configured paths and resource patterns remain declarations; the builder does not guarantee those targets exist remotely. The local Remote Handoff package entry is excluded when it resolves to this package root; a dedicated companion is added to remote pi instead.

Inside Git-based source trees, profile traversal copies `git ls-files --cached --others --exclude-standard` entries. Tracked files survive ignore rules; gitignored generated build output does not. Outside Git, traversal copies files except nested `.git` and `node_modules`. Profile symlinks are followed and materialized, not retained as links. Linked directories use the target repository's rules, dangling links are skipped, and cycles/special entries fail.

Home-prefixed settings strings are rewritten to the portable profile home. This does not parse embedded shell commands or arbitrary path strings, and does not transfer local environment variables. Remote pi still inherits the remote user's real `HOME`; only its pi agent directory is private through `PI_CODING_AGENT_DIR`.

### Transfer and shared caches

Initial upload is one gzip-compressed bidirectional SSH stream, not a tar archive or scp upload. Newline-delimited JSON frames describe objects/control files, followed by raw byte bodies.

The receiver first reports which SHA-256 profile objects are missing. Only missing content is uploaded, followed by scripts, conversation, Git bundle, credential baseline, and manifests. New object bodies are checked against their hashes. Writes use private temporary files and rename. Existing cached objects are reused by existence, not continually rehashed.

Remote storage is organized under `$HOME/.pi-remote-handoff`:

```text
runtime/<exact-local-pi-version>
herdr
profile-objects/<sha256>
package-dependencies/<cache-key>
workspaces/<project-name>-<namespace-hash>/repository
workspaces/<project-name>-<namespace-hash>/profile/home/.pi/agent
workspaces/<project-name>-<namespace-hash>/control
```

The private pi runtime matches the executing local pi version, not the development dependency version in the extension manifest. Host workspaces share runtime versions, profile objects, and dependency caches, while each handoff gets a fresh materialized profile and private credentials.

Dependency preparation installs production/optional dependencies. It omits dev dependencies and temporarily removes the root package's `scripts`; it does not build ignored outputs. Dependency lifecycle scripts are not disabled by that profile install, unlike the private pi runtime's `--ignore-scripts` installation.

Ordinary cache keys include the scriptless manifest, package-lock/shrinkwrap/npmrc inputs, and remote Node/npm/OS/architecture details. Packages using local/link/workspace dependencies use broader portable-package contents in the key. This does not rewrite dependency paths or guarantee preserved relative layouts. Cached `node_modules` can be hardlinked into workspaces, so modifying those dependency files can modify shared cache inodes.

Profile objects, dependency caches, private runtime versions, and managed Herdr survive task cleanup and have no pruning policy. Sensitive copied profile content can remain in those caches after apply or discard.

### Remote interaction, detach, stop, and continue

Remote pi opens the canonical handed-off session with inherited project-trust choice and the remote companion. There is no initial task prompt or restricted tool set. Any number of interactive prompts can follow.

Inside remote pi, `/remote-handoff` offers:

- Detach and return to local pi.
- Stop and prepare result.
- Show status.

Detach ends the terminal attachment, not remote pi. Herdr's own detach key is also available, but nested local Herdr can consume its prefix first; the companion menu avoids that conflict.

The local control conversation observes detached status every three seconds while that controller session is alive. It reports prepared results, stopped/no-result runs, lost connections, and restoration. This is not a standalone monitoring daemon. Local shutdown stops observation without automatically stopping the remote handoff.

Stop writes a remote marker. The companion checks it every 250 ms, aborts an active turn when needed, and shuts down pi. Local graceful stop waits up to ten seconds, then can offer force stop of the dedicated Herdr session. Force stop can leave no prepared result.

After pi exits, the runner captures recent pane output, validates the canonical session path, snapshots current remote files into a result commit/bundle, and publishes a matching-launch result under the launch lock. A failed pi run can still yield partial work when capture succeeds. Signal/startup/capture failures do not guarantee a result.

Continue rechecks/repairs the private profile and exact pi runtime, starts a new launch ID, and attaches. A prepared result must first be invalidated, with confirmation. If continuation subsequently fails, that old prepared bundle is no longer available for apply, though repository/conversation work remains.

Repair validates selected manifest/settings/directory/auth invariants. It does not prove every extension, built output, or dependency is usable. Reconstruction uses the original profile manifest, not a fresh copy of current local profile edits.

### View diff and reconcile local edits

`view diff` downloads/imports the prepared result and shows handoff-snapshot-to-result changes through `git diff --stat --binary` in less. `q` returns to the menu. It neither applies files nor asks for apply confirmation.

Apply snapshots the current local project and checks added-path collisions, including otherwise ignored/untracked local targets:

- If the local files still equal the handoff snapshot and no collision exists, prepare a direct binary patch.
- Otherwise, create a detached temporary worktree and local snapshot commit, then let Git perform its normal three-way merge against the remote result.
- Open a local child pi with a temporary copy of the returned conversation in that worktree. Its prompt asks it to resolve clear text conflicts, inspect clean merges for semantic conflicts, and ask you about ambiguous, binary, or path-collision decisions.
- The review companion offers Complete merge review, Leave merge review, and Status. Completion refuses unresolved Git merge paths. Leaving deletes review worktree/session data and keeps the remote prepared result available.

The merge reviewer uses the current local profile and normal permissions. The temporary worktree and instructions are not an enforced filesystem sandbox, and completion does not prove semantic correctness. It is still human/model-assisted review.

A completed review builds an apply-only patch relative to the current local snapshot, not the original handoff snapshot. The final diff is paged in less and requires explicit confirmation. Local files are checked again after review/confirmation and during credential return. If they changed before plan persistence, preparation/review restarts against current files.

### Apply, crash recovery, and cleanup

After confirmation, the extension returns credentials, records an `applying` plan with patch/conversation hashes and before/after trees, installs the reviewed conversation, switches to it, and applies the binary patch without `--index`.

Existing staged index state stays unchanged. Incoming tracked-file changes remain unstaged; incoming new files can remain untracked. It does not create/merge/switch your user branch, commit your index, or push anything.

Apply replaces the original JSONL with the selected portable branch plus remote/review history, rewritten to the original local cwd/session identity. It does not merge every original abandoned branch back into the returned file. Discard, in contrast, preserves the unchanged existing original full session file.

Recovery recognizes whether files/session already match the returned candidate or the recorded before/after tree and skips completed steps. A project matching neither recorded tree fails instead of guessing. Credentials, session installation, and file application are not one atomic transaction, and there is no automatic rollback of completed steps.

Local success is saved as `cleanup-pending` before remote cleanup. Cleanup removes the dedicated Herdr session, remote workspace, local task data, and private refs/ordinary-directory Git database. If it fails, retry cleanup only cleans resources. It does not reapply files, return credentials again, or replace conversation history again.

Persisted task state is version 8 with no migration from other versions. After local restart, another conversation in the same project can reopen the menu and observe/attach/stop/continue/discard or enter recovery. Hard process death does not guarantee removal of transient review worktrees/candidates.

### Credential merge, discard, and abandonment

SSH access and pi provider credentials are separate. The local `auth.json` baseline is transferred into a private remote profile. The extension does not intentionally use or edit the remote user's shared pi auth file.

Apply and discard merge returned credentials per provider against the baseline:

| Local/remote change | Result |
| --- | --- |
| Same value on both sides | Keep that value |
| Only remote changed | Use remote, including additions/deletions |
| Only local changed | Keep local, including additions/deletions |
| Both changed differently | Ask which complete local/returned credential to keep |

Fields from two credential versions are never combined. Conflict questions occur outside the file lock, and the local auth file is rechecked before saving; intervening changes repeat selection. A missing/invalid/symlink private auth file, changed local agent directory, or cancelled conflict choice blocks return. Provider record shape validation does not prove account access or credential freshness.

Discard confirms, verifies the unchanged original conversation, returns refreshed credentials, removes remote/local handoff resources, and returns original ownership. It needs a reachable host. A cancelled session switch can leave a recoverable `returning` phase.

Abandon unreachable handoff is an explicit irreversible-loss choice for a host that will not return. It verifies/returns the unchanged original conversation and removes only local task resources/refs. It cannot recover remote edits, history, or refreshed credentials, and cannot delete or stop remote work. The remote process can continue after local abandonment.

### Security, costs, and operational limits

Trust the SSH host, local/remote profiles, configured packages, and merge reviewer. Remote pi runs with the full permissions of the SSH user; local review pi retains local user permissions. Conversation/tool output, source, reachable history, profiles, npm configuration, and credentials can contain secrets. There is no secret scanner or general redaction.

Owner-only POSIX permissions protect private artifacts from ordinary other users where enforced. They are not encryption at rest, remote-user/root isolation, secure deletion, or verified Windows ACL policy. Cache retention and symlink-following profile copies are particularly important for sensitive content.

SSH observations classify transport failures separately from marked remote command failures. Locked-key detection reports its specific error. Menus preserve uncertain startup rather than assuming a failed SSH response means nothing launched.

The connect timeout is not an overall operation deadline. Package installs, remote scripts, and flock waits have no general cancellation deadline. Upload has no resumable byte offset, and workflow recovery does not roll back past model usage, credential writes, or invalidated results.

Remote prompts use the transferred profile's model credentials/settings. Merge review makes real local model calls. Reopening/restarting review can add calls. There is no fixed model, spend limit, token budget, price estimator, or billing isolation. Provisioning also uses network bandwidth, npm downloads, remote CPU/disk, and growing caches. Detached status checks make SSH requests every three seconds while the control conversation remains open.

### Example workflow

1. Open a persisted conversation in the project and run `/remote-handoff`.
2. Choose start and select an SSH alias such as `build-host`.
3. After automatic attachment, ask remote pi to perform the task. Its machine dependencies must already exist.
4. Use the remote companion to detach without stopping work.
5. Later attach again, or choose stop and prepare result from the local menu.
6. View diff, then apply. Resolve any prompted merge-review decisions.
7. Review the final apply-only diff and confirm. Returned changes stay unstaged or untracked; the existing index stays intact.

### Source and existing verification

- Lifecycle/menu, ownership, observation, apply/return recovery: `/Users/kpovolotskyy/ai-stuff/pi-extensions/remote-handoff/src/index.ts`, especially lines 674 to 1301 and 1303 to 1716.
- Version-8 task phases and paths: `/Users/kpovolotskyy/ai-stuff/pi-extensions/remote-handoff/src/state.ts`.
- Snapshot/bundle/private-directory repository and binary patch operations: `/Users/kpovolotskyy/ai-stuff/pi-extensions/remote-handoff/src/git.ts`.
- Session branch export/hash validation/return: `/Users/kpovolotskyy/ai-stuff/pi-extensions/remote-handoff/src/session.ts`.
- Provider-level auth validation/three-way return: `/Users/kpovolotskyy/ai-stuff/pi-extensions/remote-handoff/src/auth.ts`.
- Portable resources/object manifest: `/Users/kpovolotskyy/ai-stuff/pi-extensions/remote-handoff/src/profile.ts`.
- Upload framing and SSH failures/multiplexing: `/Users/kpovolotskyy/ai-stuff/pi-extensions/remote-handoff/src/transfer.ts` and `/Users/kpovolotskyy/ai-stuff/pi-extensions/remote-handoff/src/remote.ts`.
- Remote provisioning/observation/continuation: `/Users/kpovolotskyy/ai-stuff/pi-extensions/remote-handoff/src/remote-workspace.ts`.
- Dedicated launch control, profile/cache preparation, receiver validation: `/Users/kpovolotskyy/ai-stuff/pi-extensions/remote-handoff/remote/control.cjs`, `/Users/kpovolotskyy/ai-stuff/pi-extensions/remote-handoff/remote/profile.cjs`, `/Users/kpovolotskyy/ai-stuff/pi-extensions/remote-handoff/remote/transfer.cjs`, and `/Users/kpovolotskyy/ai-stuff/pi-extensions/remote-handoff/remote/validate-profile.cjs`.
- Remote stop/result capture: `/Users/kpovolotskyy/ai-stuff/pi-extensions/remote-handoff/remote/companion.ts` and `/Users/kpovolotskyy/ai-stuff/pi-extensions/remote-handoff/remote/runner.sh`.
- Temporary merge review and companion: `/Users/kpovolotskyy/ai-stuff/pi-extensions/remote-handoff/src/merge-review.ts` and `/Users/kpovolotskyy/ai-stuff/pi-extensions/remote-handoff/src/merge-review-companion.ts`.
- Existing real SSH/Herdr/pi verification script: `/Users/kpovolotskyy/ai-stuff/pi-extensions/remote-handoff/e2e/remote-handoff.e2e.sh`. Its direct, ordinary-directory, merge, and restart scenarios exercise actual transfer, detach/continue, profile repair, conversation return, index preservation, and cleanup. The merge scenario uses a real model. Source was inspected only; it was not executed here. It does not cover every auth-conflict, lost-acknowledgment, force-stop, abandonment, crash-recovery, binary-collision, cache-corruption, or platform case.

## How the extensions interact

### rm-guard and tool-result-trim

They act at different points in the tool lifecycle. `rm-guard` prepends shell environment setup before a model-issued bash command runs. `tool-result-trim` changes its completed output afterward. Trimming cannot make an unsafe command safe, and rm protection does not keep command output out of model context.

The trimming package does not replace the bash tool, so it does not compete with rm-guard for registration of that tool. Its bash handler and generic handler are intentionally separate; the generic handler always excludes bash to avoid double processing.

### Subagents and local files

An isolated subagent starts without the parent's conversation, but it can use the same project directory and credentials. Neither isolated nor context-forked children get a separate filesystem automatically. Give agents separate responsibilities or working directories when they would otherwise edit the same files concurrently.

The rm guard's decision to ask uses `ctx.hasUI`, not the fact that the process is called a subagent. Headless child runs cannot approve blocked deletion. Herdr-backed children run interactive pi panes, so they can have a usable confirmation UI.

A subagent completion report is a user message, not a tool result. Do not assume generic tool-result trimming processes that pushed report. Reading an agent's saved report through `read` still uses pi's normal read pagination. A Node client run carried inside bash can produce a bash result that the trim handler processes.

### Last-turn review and concurrent changes

Last-turn review measures the entire Git worktree between its before/after snapshots. It does not attribute changes to individual processes or tools. Files changed by a subagent or by a human during that interval can appear in the same diff.

Undo is intentionally stricter than review. It checks the whole current worktree against the recorded after-snapshot and separately refuses staged changes on affected paths. A successful review does not imply that undo remains available after subsequent editing or staging.

### Remote Handoff and the other packages

The portable profile carries configured local packages and selected agent resources to the remote workspace. Package dependency installation happens remotely. Portability still depends on remote executables, filesystem paths, OS support, ignored build artifacts, and credentials; copying an extension does not install its machine dependencies.

Remote Handoff excludes its local lifecycle extension from the copied package entry and adds a remote companion that provides the remote detach/stop/status menu. The other extensions retain their own behavior in remote pi when included and loadable.

Ignoring generated output in a Git-based package also excludes that output from its portable copy. This matters for any extension that requires prebuilt assets. Review the copied package's actual tracked files rather than assuming every file on the local disk will arrive.

Remote merge review and last-turn review are separate workflows. Remote Handoff creates a temporary merge worktree and child pi conversation to reconcile returned work with intervening local edits. Last-turn review opens the saved local before/after diff and only supports exact guarded undo.

### Platform scope

| Extension | Platform facts established by this checkout |
| --- | --- |
| `rm-guard` | The wrapper requires a POSIX Bash and Unix utilities, including `/bin/rm`. This is not native PowerShell deletion protection. |
| `simple-subagent` | Node child-process execution and TCP bridge have cross-platform code paths. The optional Herdr plugin declares Linux/macOS support, and its workspace lock rejects Windows. No Windows e2e result was verified. |
| `tool-result-trim` | Uses Node filesystem, OS temp-directory, and path APIs; no external tokenizer or shell dependency is introduced by trimming itself. |
| `pi-last-turn-review` | Requires a desktop native window through Glimpse and Git for file review. Native focus and clipboard handling have OS-specific branches. No GUI smoke run was performed here. |
| `remote-handoff` | Local transport and terminal handling have macOS/Linux/Windows branches. The remote runtime requires a Unix-like environment with Bash, flock, pkill, and tar. Windows local SSH runs without connection sharing. |

This table describes implementation requirements and inspected branches, not a claim that the documentation task verified every platform.
