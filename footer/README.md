# pi-hud-footer

Custom [pi](https://github.com/mariozechner/pi) footer HUD with:

- current directory
- git branch
- context usage
- provider and model
- thinking level
- adaptive idle timer showing time since the agent settled
- total cost for the current session, including an upper-bound cache-write estimate for numbered
  `openai-codex-<n>` subscription providers on `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-5.6-sol`,
  counted only for assistant messages that report zero cache-write tokens
- Anthropic and Codex quotas updated immediately from provider response headers, with direct
  usage-API refreshes preserving the provider-specific quota windows from `pi-sub-bar`
- persisted quota cache restored without a startup request, automatic refresh every 180 seconds,
  a 120-second minimum request interval, and forced refresh attempts on turn end and model selection

## Install

Add this directory as a Pi package:

```json
{
  "packages": ["/path/to/pi-extensions/footer"]
}
```

Then run `/reload` in Pi.

## Package

This package exposes one pi extension:

```json
{
  "pi": {
    "extensions": ["./extensions/hud-footer.ts"]
  }
}
```
