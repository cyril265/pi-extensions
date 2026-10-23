# session-search

Full-text search over your previous pi session files.

## Install

```bash
npm install
```

The extension imports `@ff-labs/fff-node`, so the dependencies must be installed in this
directory before it can load. Then add this directory to `packages` in
`~/.pi/agent/settings.json` (or `.pi/settings.json`) and run `/reload`.

## Tool

`sessions-search` searches the session JSONL files and always skips the current session file.
Its description tells the model to use it only when the user asks for it.

| Parameter | Type | Default |
| --- | --- | --- |
| `query` | string, required | |
| `caseSensitive` | boolean | `false` |
| `maxResults` | number, 1 to 500 | `10` |

The query is a plain substring match, not a regex. With `caseSensitive: false` the query is
lowercased and matched smart-case.

Each result is one line with the entry timestamp, the project (basename of the session `cwd`),
the entry role, the line number, and a snippet around the match, followed by
`<absolute path>:<line>` so you can read the full entry.

## Session directory

Normal persisted sessions live in project-specific directories below one sessions root. The
extension searches that root, so results can come from any working directory.

The configured root is resolved in this order:

1. `PI_CODING_AGENT_SESSION_DIR`.
2. `sessionDir` from `settings.json` in the agent directory.
3. `<agent dir>/sessions`.

A custom directory reported by the session manager, such as one passed with `--session-dir`, takes
precedence when it is outside the configured root. The agent directory is `PI_CODING_AGENT_DIR` or
`~/.pi/agent`. Relative paths resolve against the session cwd and `~` is expanded.

## Notes

- The file index is built once per directory and rescanned before every search. Scanning has a
  30 second timeout; files larger than 1 GiB are skipped.
- The index is released on session shutdown.
