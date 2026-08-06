# prewalk

Transparent [Prewalk](https://stencil.so/blog/prewalk)-style handoff built on
top of the sibling `simple-subagent` extension. The frontier model explores,
plans, and makes the first edit in your normal session; a cheaper executor
finishes the implementation as a **forked subagent**; the frontier model then
verifies the result. The workflow remains visible in the parent transcript;
the executor instead receives a filtered, continuous trajectory so it can
continue the work without being distracted by handoff mechanics. There is no
automatic model switching or context rewriting in the parent session.

## Setup

Configure the executor once (stored in `~/.pi/agent/prewalk.json`):

```text
/prewalk-config openai-codex/gpt-5.6-luna low
/prewalk-config            # show current config
```

## Use

```text
/prewalk <task description>
/prewalk                   # task comes from the conversation
```

`/prewalk` sends a **visible** workflow template and enables the
`dispatch_executor` tool for this session. The model then:

1. explores and writes the full plan,
2. makes the first (most decision-heavy) edit itself,
3. receives a one-time nudge after its first successful `edit` or `write`, then
   calls `dispatch_executor` — without instructions in the normal case (the
   executor is told to continue with the inherited todo list and plan);
   instructions carry only post-plan deltas or re-dispatch rework,
4. verifies the executor's report (`git diff`, tests) when it returns.

The executor runs via `simple-subagent` as a fork of the current session on
the configured cheap model. It inherits the whole trajectory; the prewalk
template, dispatch, nudge, and result messages are filtered from its context
(only inside the child process — the parent transcript is never touched).
Executor sessions are resumable: re-dispatch with the `sessionKey` from the
report.

## Notes

- `dispatch_executor` is registered only after `/prewalk` starts, and is
  restored when resuming a session where Prewalk was already started.
  `pi-claude-code-use` discovers it before the next model request and aliases
  it to `mcp__prewalk__dispatch_executor` for Anthropic OAuth.
- Prompt-cache inheritance is intentionally skipped for the fork (different
  model, cache would miss anyway).
- Requires `simple-subagent` as a sibling directory (imported directly).

```bash
npm run check   # typecheck
npm test        # node --test
```
