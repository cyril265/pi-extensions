# Provider System Prompt Append

Pi extension that adds the current provider's provider-specific system prompt append on each turn.

## Files

Use the same naming style as Pi's `APPEND_SYSTEM.md`, with the provider name in the filename:

```text
~/.pi/agent/APPEND_SYSTEM.anthropic.md
~/.pi/agent/APPEND_SYSTEM.openai-codex.md

.pi/APPEND_SYSTEM.anthropic.md
.pi/APPEND_SYSTEM.openai-codex.md
```

Project files are read only when the project is trusted. Project files win over global files for the same provider.

## Turn Behavior

The extension reads the current model provider for each `before_agent_start` event. After `/model` switches, the next turn uses that provider's append file.

The provider append is applied idempotently to each fresh system prompt. It does not accumulate duplicates.

## Command

```text
/provider-system-prompt-append
```

Shows the current provider and the active provider append file, if one exists.
