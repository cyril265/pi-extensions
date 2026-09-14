# presets

Named configurations for model, thinking level, readonly mode, and extra system prompt
instructions.

## Install

Add this directory to `packages` in `~/.pi/agent/settings.json` (or `.pi/settings.json`), then
run `/reload`.

## Configure

Presets live in `~/.pi/agent/presets.json` and `<cwd>/.pi/presets.json`. Both files are merged
and a project preset replaces a global one with the same name.

```json
{
  "plan": {
    "provider": "openai-codex",
    "model": "gpt-5.2-codex",
    "thinkingLevel": "high",
    "readonly": true,
    "instructions": "You are in PLANNING MODE..."
  }
}
```

`provider` and `model` are applied together; the model must exist in the registry and have an
API key, otherwise the preset is not applied. `thinkingLevel` takes a pi thinking level.
`readonly: true` removes `edit` and `write` from the active tools. `instructions` is appended to
the system prompt on every request while the preset is active.

## Use

- `pi --preset <name>` starts the session with that preset.
- `/preset` opens a searchable selector with a `(none)` entry that clears the preset.
- `/preset <name>` switches directly.
- `Ctrl+Shift+U` cycles through `(none)` and the preset names in alphabetical order.

The active preset shows as `preset:<name>` in the status line and is stored in the session, so
resuming restores it. On restore the model is not re-applied; only the name, tools, and
instructions come back.

## Readonly turns

`/readonly <prompt>` and `<prompt> !readonly` run a single turn without `edit` and `write`. The
`!readonly` suffix must be at the end of the prompt and is stripped before the prompt is sent.
Both need an idle agent and warn otherwise.

For that turn the extension shows a `readonly` status and appends `Readonly request: NO EDITS!`
to the system prompt. On `agent_end` the previous tools are restored and the status is cleared.
