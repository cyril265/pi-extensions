# Pi Warp Notifications

Pi extension that emits Warp's structured CLI-agent OSC 777 protocol so Pi completions and permission prompts appear in Warp's agent inbox.

## Install

Use directly:

```bash
pi -e ../warp-notifications/index.ts
```

Or symlink globally:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/../warp-notifications" ~/.pi/agent/extensions/warp-notifications
```

Then restart Pi or run `/reload`.

## Behavior

Events are emitted only when `TERM_PROGRAM=WarpTerminal` and `WARP_CLI_AGENT_PROTOCOL_VERSION` is set. The extension is disabled when `PI_SIMPLE_SUBAGENT=1`.

It emits these events:

- `session_start` on the first event of a session
- `prompt_submit` when a turn starts
- `stop` when a turn ends and from `/warpnotify-test`
- `question_asked` for a matched sandbox prompt
- `permission_replied` after that dialog closes

## Test

In Pi:

```text
/warpnotify-test
```

Claude sandbox network/write prompts are forwarded as Warp `question_asked` events when their select title exactly matches the sandbox prompts (`Network blocked ... allowedDomains` or `Write blocked ... allowWrite`). `question_asked` marks the session as needing input without writing the prompt text into Warp's tab-title summary field.

After the dialog closes, the extension emits `permission_replied` to clear the blocked state. It does not fuzzy-match unrelated dialogs or emit fake completion notifications for prompts.

## Note

Warp source currently defines `CLIAgent::Pi` but does not enable a Pi listener in `cli_agent_sessions/listener/mod.rs`. Every payload is sent with `agent: "pi"`, so inbox entries stay Pi entries once Warp enables that listener.
