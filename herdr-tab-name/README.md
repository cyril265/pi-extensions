# herdr-tab-name

Names the pi session and its herdr tab after the task you are working on.

## Install

Add this directory to `packages` in `~/.pi/agent/settings.json` (or `.pi/settings.json`), then
run `/reload`. The `herdr` CLI must be on `PATH`.

Outside a herdr pane the extension does nothing: it returns immediately unless `HERDR_ENV=1`
and `HERDR_TAB_ID` are set.

## Behavior

Before each prompt the extension asks a model for two names from the recent user requests and
assistant replies: a session name of 2 to 6 words (at most 70 characters) and a tab label of 2
to 3 words (at most 16 characters). Naming runs on every prompt for the first 5 turns, then on
every 5th turn. Only the last 5 turns are sent as evidence, long messages are clipped to head
and tail, and the model call runs beside the normal agent response instead of delaying it.

Manual names win:

- A tab label that is not herdr's automatic number and does not match the label this extension
  set stops automatic renaming.
- A session name you set with `/name` is mirrored to the tab and ends automatic naming.

`/tab-name` regenerates both names now, skipping the turn window and the ownership checks.

The first failure per session is reported as a warning; later failures stay quiet.

## Model and cost

The naming model is hardcoded to `openai-codex/gpt-5.6-luna` with medium reasoning effort and a
4000 token cap. It uses the API key from pi's model registry.

Every model call appends one JSON line with tokens and cost to
`<agent dir>/tmp/herdr-tab-name/usage.jsonl`, where the agent directory is `PI_CODING_AGENT_DIR`
or `~/.pi/agent`:

```bash
jq -s 'map(.cost) | add' ~/.pi/agent/tmp/herdr-tab-name/usage.jsonl
```

The names chosen per tab are stored next to it in `<tab id>.txt`.
