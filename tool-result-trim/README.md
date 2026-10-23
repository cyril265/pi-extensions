# pi-tool-result-trim

Pi extension that smart-trims text tool results before they enter the conversation context.

It trims `bash` output, leaves `read` to Pi's built-in pagination, and applies the same trimming to other text tool results by default.
Non-text blocks, such as images, are preserved.

## What It Does

For `bash` output and for each text block of other tool results except `read`:

1. Short results pass through unchanged.
2. Very long lines keep their beginning and end, with `[...]` in the middle.
3. Consecutive similar lines are collapsed when row trimming is needed.
4. If the result is still too large, middle rows are omitted while keeping the head and tail.

Whenever trimming happens, the untrimmed text is written to a temp file and referenced in the result header.
If a tool already exposes `details.fullOutputPath`, that file is reused.
For `bash`, the header reads `[Trimmed: … Full output: <path>]`. For other tools, it reads `[Tool result trimmed: … Full text: <path>]`.

Token counts are estimated as characters divided by 4, the same estimate Pi uses for context size.
No tokenizer is loaded, so the extension adds about 3–4 MB of memory.

## Install

Add this directory as a Pi package:

```json
{
  "packages": ["/absolute/path/to/pi-extensions/tool-result-trim"]
}
```

Then run `/reload` in Pi.

Do not also install `npm:pi-bash-trim` as a Pi package. This package already trims `bash` output, and both would process the same result.

## Configuration

Create `~/.pi/agent/extensions/pi-tool-result-trim.json`:

```json
{
  "maxTotalTokens": 3000,
  "excludeTools": ["grep"],
  "minDedupLines": 6
}
```

All fields are optional. The trimming options apply to `bash` and to the other tools.

| Option | Default | Description |
| --- | ---: | --- |
| `maxLineWidth` | 180 | Line length that triggers middle trimming. |
| `trimmedWidth` | 150 | Approximate width after long-line trimming. |
| `headRatio` | 0.8 | Fraction of kept long-line text taken from the beginning. |
| `maxTotalTokens` | 2000 | Approximate budget before middle rows are omitted. |
| `minTokensToTrim` | 200 | Results below this approximate size pass through untouched. |
| `minDedupLines` | 4 | Minimum consecutive similar lines to collapse. |
| `includeTools` | unset | If set, only these tool names are trimmed. |
| `excludeTools` | `["bash", "read"]` | Tool names that should never be trimmed by the generic handler. `bash` and `read` are always excluded. |

The trimming and line-collapsing logic is adapted from [`pi-bash-trim`](https://github.com/mgabor3141/yapp/tree/main/packages/bash-trim) 1.0.2 under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Test

```sh
npm test
```

The test starts the real `pi` CLI with only this extension, a real model (`openai-codex/gpt-5.6-luna:minimal`), and the real `bash` and `find` tools. It runs every case under Node, and under Bun when `bun` is on `PATH`. It needs a logged-in `openai-codex` account.
