# pi-hud-footer

Custom [pi](https://github.com/mariozechner/pi) footer HUD with:

- current directory
- git branch
- context usage
- provider and model
- thinking level
- adaptive idle timer showing time since the agent settled
- total cost for the current session, including an upper-bound cache-write estimate for
  `openai-codex-*` GPT-5.6 providers when Codex omits write-token usage
- Anthropic and Codex quotas updated immediately from provider response headers, with direct
  usage-API refreshes preserving the provider-specific quota windows from `pi-sub-bar`
- persisted quota cache restored without a startup request, automatic refresh every 180 seconds,
  a 120-second minimum request interval, and forced refresh attempts on turn end and model selection

## Install

```bash
pi install npm:pi-hud-footer
```

Pinned install:

```bash
pi install npm:pi-hud-footer@0.1.0
```

## Package

This package exposes one pi extension:

```json
{
  "pi": {
    "extensions": ["./extensions/hud-footer.ts"]
  }
}
```
