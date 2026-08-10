# Prompt Template Shell

Adds Claude Code-style dynamic context commands to Pi prompt templates:

```markdown
---
description: Summarize the current branch
argument-hint: "[focus]"
---
Branch: !`git branch --show-current`

Status:
!`git status --short`

Focus: ${1:-everything}
```

Invoke the template normally:

```text
/summary tests
```

The extension executes each `` !`command` `` in the session working directory and replaces it
with the command output before Pi sends the prompt to the model. Template arguments such as `$1`,
`${@:2}`, and `$ARGUMENTS` work inside commands and normal template text.

Only command markers written in loaded prompt-template files are expanded. The extension ignores
markers typed directly into the editor, introduced through arguments in normal template text, or
found in skills. Prompt templates without dynamic commands keep using Pi's built-in expansion.

A command timeout, launch error, or non-zero exit stops the prompt before the model is called. The
timeout is 30 seconds.

## Install

Add the package directory to `~/.pi/agent/settings.json` or `.pi/settings.json`, then run `/reload`:

```json
{
  "packages": [
    "/absolute/path/to/pi-extensions/prompt-template-shell"
  ]
}
```

## Security

Template commands run locally with your full permissions. Install prompt packages only from sources
you trust. Arguments interpolated inside a command are shell source, so pass only values you trust.
