# Provider and Model System Prompt Append

Pi extension that adds the current provider's and model's system prompt appends on each turn.

## Files

Use the same naming style as Pi's `APPEND_SYSTEM.md`, with the provider name in the filename:

```text
~/.pi/agent/APPEND_SYSTEM.anthropic.md
~/.pi/agent/APPEND_SYSTEM.openai-codex.md
~/.pi/agent/APPEND_SYSTEM.anthropic.claude-opus-4-6.md
~/.pi/agent/APPEND_SYSTEM.openrouter.anthropic%2Fclaude-opus-4.md

.pi/APPEND_SYSTEM.anthropic.md
.pi/APPEND_SYSTEM.openai-codex.md
.pi/APPEND_SYSTEM.anthropic.claude-opus-4-6.md
.pi/APPEND_SYSTEM.openrouter.anthropic%2Fclaude-opus-4.md
```

Model filenames include both the provider and model ID. The model ID is encoded with
`encodeURIComponent`, so `/` becomes `%2F` and `:` becomes `%3A`.

Provider and model appends stack when both exist. The provider append is added first, followed by the
model append. Project files are read only when the project is trusted. A project file wins over its
global counterpart.

## Turn Behavior

The extension reads the current provider and model for each `before_agent_start` event. After `/model`
switches, the next turn uses the new provider and model append files.

The appends are applied idempotently to each fresh system prompt. They do not accumulate duplicates.

## Command

```text
/provider-system-prompt-append
```

Shows the current model and the active provider and model append files.
