# simple-subagent

Pi extension for asynchronous subagents:

- `runSubAgents({ agents: [...] })` dispatches isolated agents and immediately returns an 8-character job ID and session keys
- `collectSubagents({ jobId })` waits for results not already delivered
- `runSubAgentsWithContext({ agents: [...] })` asynchronously forks the parent context; disabled by default
- `nodeScript({ code })` runs trusted one-shot JavaScript that composes Pi's stock tools and isolated subagents
- `/subagents` opens a running-job picker with cancellation; `/subagents cancel <jobId>` is the scriptable path

When a job settles, uncollected results are pushed into the parent conversation. Pi queues the
message as steering while streaming or starts a result-processing turn while idle. Cancelling
a waiting `collectSubagents` call leaves the job running. Jobs are cancelled on session shutdown,
`/new`, session switches, and `/subagents cancel`.

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

## Tool

- uses caller model
- `overrideModel`: optional per-agent model override. Configured aliases resolve through `modelAliases`; `provider/model` selects an explicit model. Unknown bare aliases fail immediately. Runtime details use `suppliedModel` for the provided value and `effectiveModel` for the resolved model.
- `thinking`: `low`, `medium`, `high`, `xhigh`, or `max`
- `prompt`: prompt sent to child pi process
- result output reports the final context used without exposing aggregate usage or cost
- results of 2048 characters or fewer are inlined alongside the result path
- `cwd`: working directory for child pi run

## nodeScript

`nodeScript` runs its `code` as an async JavaScript function body in a fresh worker. The worker
has a frozen `tools` object and a captured `console` object. It has no Pi imports or persistent
state. The tool call always displays the complete script with JavaScript syntax highlighting.
The result starts with one status and timing line, renders console output in muted text, and
syntax-highlights JSON returns. It shows at most ten return-value lines until expanded; status and
console lines do not count toward that limit.

The `tools` object exposes exactly these methods:

```text
read
write
edit
bash
grep
find
ls
runSubAgents
collectSubagents
```

Every successful call resolves to:

```ts
{
  text: string
  content: Array<TextContent | ImageContent>
  details: unknown
}
```

Validation and execution failures reject the call, so scripts can use normal `try/catch`.
Calls can run sequentially or through `Promise.all`.

```js
const template = await tools.read({ path: "/absolute/path/to/reviewer.md" })
const diff = await tools.bash({ command: "git diff main...HEAD" })
const prompt = `${template.text}\n\n${diff.text}`

return tools.runSubAgents({
  agents: [
    {
      name: "correctness",
      thinking: "high",
      cwd: "/absolute/path/to/project",
      prompt,
    },
    {
      name: "simplicity",
      thinking: "high",
      cwd: "/absolute/path/to/project",
      prompt,
    },
  ],
})
```

Strings returned by the script stay unchanged. Other JSON-serializable values are formatted as
indented JSON. Omitting a return or returning `undefined` fails. Captured console lines appear
before the returned value. Combined output is limited to 2000 lines or 50KB. When it exceeds
either limit, the result includes the path to a temporary file containing the complete output.

`nodeScript` is not a security sandbox. Run only code you trust. Nested native calls use Pi's stock
implementations with the parent `cwd` and effective image and shell settings. They do not use
active or overridden tool instances. They also bypass active-tool restrictions, permission
extensions, and nested `tool_call` or `tool_result` hooks. The outer `nodeScript` call still uses
Pi's normal tool lifecycle.

Pressing Escape terminates the worker and aborts active native calls. A waiting
`collectSubagents` call is removed, but dispatched subagent jobs keep running. Session shutdown
also terminates workers, then applies simple-subagent's existing behavior of cancelling all jobs.
If a script returns while one of its tool promises is unresolved, `nodeScript` aborts those calls
and fails.

Collection keeps the existing winner-takes-result behavior. A collector that is waiting first gets
the result. If push delivery wins first, a later collect reports that no undelivered result remains.
`runSubAgentsWithContext`, extension tools, and MCP tools are not available inside `nodeScript`.

## Isolated subagent behavior

Each agent runs in a separate `pi` process in JSON/print mode. Dispatch does not wait for it.
In parent print or JSON single-shot mode, Pi holds the process open at `turn_end` until all jobs settle.

Inside Herdr, each workspace uses one background tab named `Subagents`. Every subagent runs a
normal interactive Pi TUI in that tab, while the tool receives progress and the final result
through a local event bridge. Panes are split along the largest available area, alternating
right/down as their shape changes so larger runs stay usable. Before a new run, finished panes
in the workspace are closed while active panes remain. Workspace setup uses a kernel-owned lock
that is released if the launcher crashes.

During its parent-assigned run, a subagent cannot call `runSubAgents`, `collectSubagents`, or
`runSubAgentsWithContext`. `nodeScript` remains available, but its nested `runSubAgents` and
`collectSubagents` calls hit the same lock. Once the run settles, the subagent tools become
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
- completed fork results use the same collect-or-push delivery as isolated jobs
- each fork reports first-turn parent-cache usage explicitly without conflating cache telemetry with child execution success

- `/forkTab` forks the current session into a new interactive Herdr tab, inherits the model and thinking level, and sends no prompt
