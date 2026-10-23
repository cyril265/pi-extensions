# pi-hud-footer

Custom [pi](https://github.com/mariozechner/pi) footer HUD with:

- current directory
- git branch
- context usage
- model
- thinking level
- adaptive idle timer showing time since the agent settled
- total cost for the current session, including an upper-bound cache-write estimate for numbered
  `openai-codex-<n>` subscription providers on `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-5.6-sol`,
  counted only for assistant messages that report zero cache-write tokens
- Anthropic and Codex quotas updated immediately from provider response headers, with direct
  usage-API refreshes preserving the provider-specific quota windows from `pi-sub-bar`
- persisted quota cache restored without a startup request, automatic refresh every 180 seconds,
  a 120-second minimum request interval, and forced refresh attempts on turn end and model selection
- optional per-model colors for the model name
- [`@arhen/pi-core-tps-stats`](https://www.npmjs.com/package/@arhen/pi-core-tps-stats), when installed,
  shown muted as `60 tps • 1,9s ttft`
- [`@calesennett/pi-codex-fast`](https://www.npmjs.com/package/@calesennett/pi-codex-fast) `Fast`/`Ultrafast`
  status, shown only for `openai-codex` and `openai-codex-<n>` providers

## Install

Add this directory as a Pi package:

```json
{
  "packages": ["/path/to/pi-extensions/footer"]
}
```

Then run `/reload` in Pi.

## Model colors

Create `~/.pi/agent/pi-hud-footer.json`, or `$PI_CODING_AGENT_DIR/pi-hud-footer.json` if that
variable is set:

```json
{
  "modelColors": {
    "claude-opus-*": "#d75f5f",
    "gpt-5.6-sol": "#00aaff"
  }
}
```

- Keys are model ids. `*` matches any characters, so `claude-opus-*` covers every Opus id.
- An exact id wins over a wildcard. Among wildcards, the first match in the file wins.
- Values are hex colors: `#rgb` or `#rrggbb`.
- Models without a match keep the default bold model name.
- Invalid entries are skipped with a warning. The rest of the file still applies.
- The file is read when a session starts. Run `/reload` after editing it.

## Package

This package exposes one pi extension:

```json
{
  "pi": {
    "extensions": ["./extensions/hud-footer.ts"]
  }
}
```
