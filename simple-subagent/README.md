# simple-subagent

Pi extension for asynchronous subagents:

- `runSubAgents({ agents: [...] })` starts an array of isolated agents and returns immediately
- the Node client's `dispatch(agents)` does the same from a script; its `run(agents)` waits and resolves with every agent's output
- `cancelSubAgents({ jobId })` cancels a running job
- `runSubAgentsWithContext({ agents: [...] })` asynchronously forks the parent context; disabled by default
- `/subagents` opens a running-job picker with cancellation; `/subagents cancel <jobId>` is the scriptable path

`runSubAgents` and the fork tool push completed results as user messages into the parent
conversation. Pi queues the message as steering while streaming or starts a result-processing turn
while idle. The client's `run` returns the result to its caller instead. The registry retains
completed results until the owning session shuts down. Disconnecting a waiting `run` leaves the
job running. Jobs are cancelled on session shutdown, `/new`, session switches, `cancelSubAgents`,
and `/subagents cancel`.

The TUI shows a ticking compact widget with job counts and each agent's latest tool call.

When Pi runs inside Herdr, tool subagents run in real Herdr panes instead of hidden child
processes. They are hidden from Herdr's built-in Agents view and appear in the grouped
Subagents view instead.

## Install

```bash
pi install /absolute/path/to/simple-subagent
```

Then reload:

```text
/reload
```

## Node client

For each live Pi session the extension sets `PI_SIMPLE_SUBAGENT_CLIENT` to a `file://` URL of
`client.mjs`. A Node script run through Pi's bash tool imports it to start agents whose prompts
are built in code, for example from a skill's template files or a diff. Outside a live session
both functions reject. `node` must be on `PATH`.

```js
const { dispatch, run } = await import(process.env.PI_SIMPLE_SUBAGENT_CLIENT)
```

Both take the same array as `runSubAgents.agents`: every entry needs `name`, `prompt`, an
absolute `cwd`, and `thinking`; `overrideModel` and `sessionKey` are optional; unknown keys are
rejected.

`dispatch(agents)` behaves like the tool: it resolves at once with
`{ jobId, agents: [{ name, sessionKey }] }` and the result is pushed into the parent conversation
when every agent finishes. Use it when the parent should keep working or end its turn.

`run(agents)` waits for every agent and resolves with the result, which is the way to use one
agent's output in the same step, for example to feed it into a second agent or to write it to
a file without the parent reading it:

```js
const result = await run([
  { name: 'reviewer', prompt: 'Review the current changes for correctness.', cwd: process.cwd(), thinking: 'high' },
])
if (result.isError) throw new Error(result.text)
console.log(result.agents[0].output)
```

```ts
{
  jobId: string
  isError: boolean          // any agent failed or was interrupted; always check it
  text: string              // the report runSubAgents would deliver, including failure reasons
  agents: Array<{
    name: string
    sessionKey: string
    status: 'done' | 'failed' | 'interrupted'
    output?: string         // the agent's final response; absent when no result was recorded
    exitCode?: number
    sessionId?: string
    sessionPath?: string    // resume with `pi --session <sessionPath>`
    outputPath?: string
    effectiveModel?: string
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number }
  }>
}
```

Both functions reject on connection, authentication, and validation errors. A failed agent does
not reject `run`; read `isError` and `text`. The same `cwd + sessionKey` cannot run twice in
parallel; sequential reuse continues the child session.

Killing the script while `run` waits leaves the job running, and its result is pushed to the
parent conversation instead. If the script disconnects after the job settled but before the
response was written, nothing is pushed; the result stays in the run directory and the child
session. The child processes inherit `PI_SIMPLE_SUBAGENT_*`, but a managed child's own
extension replaces them, and its bridge rejects both functions during the parent-assigned run.

## Configuration

Create `~/.pi/agent/simple-subagent.json`:

```json
{
  "enableForkTool": true,
  "modelAliases": {
    "opus": "anthropic/claude-opus-5",
    "fable": "anthropic/fable-5",
    "codex": "openai-codex/gpt-5.6-sol"
  }
}
```

Reload Pi after changing the file. The configured alias names are included in the
`runSubAgents` tool description.

The file and both settings are optional. Without them, the fork tool is disabled and no model
aliases are defined. Invalid JSON or invalid configured values still fail during extension loading.

For Herdr, link the companion plugin and install Pi's lifecycle integration:

```bash
herdr plugin link /absolute/path/to/simple-subagent
herdr integration install pi
```

Bind the grouped view in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+s"
type = "plugin_action"
command = "local.simple-subagent.open"
description = "subagents"
```

Verify the setup:

```bash
herdr plugin list   # shows local.simple-subagent
```

Pressing the bound key (`prefix+s` above) opens the Subagents overlay.
If no key is bound, open it directly:

```bash
herdr plugin pane open --plugin local.simple-subagent --entrypoint subagents --placement overlay --focus
```

### Herdr Agents view

Before creating panes, every Herdr-backed run installs a plugin-owned Agent-view projection
that omits panes marked with the `simple_subagent` metadata token. This automatically hides
tool subagents from Herdr's built-in Agents list and its associated navigation targets while
keeping them available in the Subagents overlay. The subagents remain real panes, continue
to appear through `agent list`.

Herdr supports one global transient Agent-view projection. Herdr can reject setup while
another plugin owns that projection; in that case the tool uses the fallback described below.
The projection ends when the server exits or the companion plugin is disabled or unlinked.

## Isolated agent fields

- `overrideModel`: optional per-agent model override; without it the caller's model is used. Configured aliases resolve through `modelAliases`; `provider/model` selects an explicit model. Unknown bare aliases fail immediately. Runtime details use `suppliedModel` for the provided value and `effectiveModel` for the resolved model.
- `thinking`: `low`, `medium`, `high`, `xhigh`, or `max`
- `prompt`: prompt sent to child pi process
- result output reports the final context used without exposing aggregate usage or cost
- results of 2048 characters or fewer are inlined alongside the result path
- `cwd`: absolute working directory for the child pi run; a relative path is rejected

## Isolated subagent behavior

Each agent runs in a separate `pi` process in JSON/print mode. Dispatch does not wait for it.
In parent print or JSON single-shot mode, Pi holds the process open at `turn_end` until all jobs settle.

Inside Herdr, each workspace uses one background tab named `Subagents`. Every subagent runs a
normal interactive Pi TUI in that tab, while the tool receives progress and the final result
through a local event bridge. Panes are split along the largest available area, alternating
right/down as their shape changes so larger runs stay usable. Before a new run, finished panes
in the workspace are closed while active panes remain. Workspace setup uses a kernel-owned lock
that is released if the launcher crashes.

During its parent-assigned run, a subagent cannot call `runSubAgents`,
`runSubAgentsWithContext`, or the Node client. Once the run settles, the subagent tools become
available in the retained Herdr pane for normal interactive continuation. Their schemas remain
active while execution is locked so the provider prompt-cache prefix does not change at
settlement; the assigned prompt instructs the agent not to call them. Reusing a session key starts
the next parent-assigned run locked again without changing session reuse behavior.

If Herdr setup fails before any subagent pane starts (projection setup, pane discovery, or tab
creation), the tool falls back to child-process mode and includes the Herdr reason as a warning.
Failures after panes start still fail the Herdr run instead of starting duplicate agents.

The temporary overlay Subagents view groups tool-created panes by parent (most recently active
group first, with per-group active/done counts), supports All/Active/Unseen filters, keyboard
navigation, mouse selection and scrolling, and opens the selected pane with Enter or click.

Rows show each agent's prompt preview (or cwd when the prompt is empty). Overlay keys: `↑/↓`
or `j/k` select, `Enter` opens the pane, `Tab` cycles the filter, `x` closes the selected pane
once it is finished (done/failed/interrupted; a message explains refused closes), `X` closes
all finished panes in the current filter, and `Esc`/`q` closes the overlay. Mouse click and
scroll are supported.

A completed pane counts as Unseen until you open it: opening a pane marks it Viewed, and it
then shows as Viewed instead of Done and drops out of the Unseen filter.

### Session behavior

- omit `sessionKey`: a durable key such as `auth-review-K7m4P2qX` is generated and returned
- set `sessionKey`: reuse that child session
- generated and supplied sessions live in `<pi agent dir>/sessions/--simple-subagent--/`
- managed session filenames use `subagent-<cwd hash>-<sessionKey>.jsonl`
- the result includes the session key; reuse it to resume the child
- completed results show the Pi session ID and a copyable `pi --session <path>` command
- cancelled and failed jobs report their session keys so the parent can continue them
- partial failures retain successful result paths, report each failed agent inline, and mark
  the tool result as an error
- do not run the same `cwd + sessionKey` twice in one parallel call
- `runSubAgentsWithContext` supports the same generated or supplied session keys

Result markdown files are still written to a temporary run directory; only the pi session JSONL files are persistent.

Managed sessions are included in pi's global `/resume` scan.

## Fork behavior

Enable the separate fork tool with `enableForkTool` in `~/.pi/agent/simple-subagent.json`.

- the fork includes the completed `runSubAgentsWithContext` tool result, so the child receives valid parent context without a dangling tool call
- `runSubAgentsWithContext` accepts `name`, `prompt`, and optional `sessionKey`; model, thinking level, and cwd are inherited and locked
- fork sessions have unique Pi session IDs and inherit the parent's prompt cache key so OpenAI routes parent and child requests to the same cache identity across processes and connections
- fork dispatch returns `terminate: true`; execution starts after the scheduling turn has persisted its tool result
- fork progress and child tool calls are shown live above the editor, then retained in the result message
- completed fork results are delivered automatically
- each fork reports first-turn parent-cache usage explicitly without conflating cache telemetry with child execution success

- `/forkTab` forks the current session into a new interactive Herdr tab, inherits the model and thinking level, and sends no prompt

## Evals

For interface comparisons based on completed coding tasks, parent progress, dependencies,
recovery, and token usage, see [behavior evals](evals/behavior/README.md). They compare the
production tools alone (`native`) with production tools plus the Node client (`client`).
`npm run eval:behavior` previews a campaign; add `--execute` to make real model calls.
Defaults are one repetition and four trials, with shared request/token/time caps;
`--rerun-failed` targets saved failures and `--regrade` recomputes reports offline.

`npm run test:live` runs Pi with `openai-codex/gpt-5.6-sol` at medium thinking against real
children and covers tool routing, automatic delivery, the Node client's blocking output,
disconnection, cancellation, session locking, and long responses.
