# pi-tool-result-trim

Pi extension that smart-trims text tool results before they enter the conversation context.

It registers the pinned `pi-bash-trim@1.0.2` extension for `bash`, leaves `read` to Pi's built-in pagination, then applies the same trimming library to other text tool results by default.
Non-text blocks, such as images, are preserved.

## What It Does

For each text block outside `bash` and `read` tool results:

1. Short results pass through unchanged.
2. Very long lines keep their beginning and end, with `[...]` in the middle.
3. Consecutive similar lines are collapsed when row trimming is needed.
4. If the result is still too large, middle rows are omitted while keeping the head and tail.

Whenever trimming happens, the untrimmed text is written to a temp file and referenced in the result header.
If a tool already exposes `details.fullOutputPath`, that file is reused.

## Install

Add this directory as a Pi package:

```json
{
  "packages": ["/absolute/path/to/pi-extensions/tool-result-trim"]
}
```

Then run `/reload` in Pi.

Do not install `npm:pi-bash-trim@1.0.2` separately as a Pi package; this package already registers it for `bash`.

## Configuration

Create `~/.pi/agent/extensions/pi-tool-result-trim.json`:

```json
{
  "maxTotalTokens": 3000,
  "excludeTools": ["grep"],
  "minDedupLines": 6
}
```

All fields are optional.

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

The trimming behavior comes from `pi-bash-trim@1.0.2`, including BPE-aware token counting.
