# Astra reasoning

Change Astra's thinking level without rewriting the request's original reasoning effort.
Works with Pi's normal Shift+Tab selector, `/thinking`, and `pi.setThinkingLevel()`.
No tools, commands, provider replacements, or settings.

## Install

```bash
pi install /Users/kpovolotskyy/ai-stuff/pi-extensions/astra-reasoning
```

Then run `/reload`. Tested with Pi 0.85.1.

## How it works

The extension saves reasoning changes as hidden session messages. Before sending an
Astra request, it converts those messages into native `configuration_update` input
items and keeps the original top-level `reasoning.effort`. Earlier input items,
instructions, tools, and cache keys stay unchanged.

Changes made while streaming take effect after the current turn's tool results.
Consecutive selector changes become one update. Session resume and forks retain
the reasoning history. Forks get a new cache key because Pi creates a new session.
Ordinary Pi compaction creates a new prompt prefix and retains any updates still
in the recent history.

Only `gpt-6-astra` on `openai-codex-responses` is eligible. Other models keep their
normal behavior and never receive these internal messages. The live Codex endpoint
rejects native updates for GPT-5.6 Sol, Luna, and Terra.

Server-side automatic truncation and compaction cannot be combined with native
updates. This does not disable Pi's normal summary-based compaction. Do not load
this alongside another extension that implements the same reasoning rewrite.

Cache hits depend on the server. A live probe retained 5,120 cached tokens across
a native low-to-high update; changing top-level effort dropped cache reads to zero.
The response metadata still reported the original effort, so that probe confirms
cache reuse and protocol acceptance, not the model's effective reasoning effort.

The technique comes from
[Igor Warzocha's pi-codex-conversion](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-conversion).
This package does not depend on it.

## Tests

```bash
cd /Users/kpovolotskyy/ai-stuff/pi-extensions/astra-reasoning
npm ci --ignore-scripts
npm run typecheck
npm run test:live
```

Live integration tests use the real Pi SDK and your existing Codex login. They
consume model quota. Without `PI_ASTRA_LIVE_TEST=1`, `npm test` skips them.
