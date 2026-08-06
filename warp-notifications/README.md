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

## Test

In Pi:

```text
/warpnotify-test
```

Claude sandbox network/write prompts are forwarded as Warp `question_asked` events when their select title exactly matches the sandbox prompts (`Network blocked ... allowedDomains` or `Write blocked ... allowWrite`). `question_asked` marks the session as needing input without writing the prompt text into Warp's tab-title summary field.

After the dialog closes, the extension emits `permission_replied` to clear the blocked state. It does not fuzzy-match unrelated dialogs or emit fake completion notifications for prompts.

## Note

Warp source currently defines `CLIAgent::Pi` but does not enable a Pi listener in `cli_agent_sessions/listener/mod.rs`, so this extension uses Warp's supported `auggie` structured-agent path as a compatibility shim. Inbox may label events as Auggie until Warp enables Pi there.
