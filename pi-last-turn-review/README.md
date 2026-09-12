# pi-last-turn-review

A tiny pi package for reviewing what just changed before you keep going.

## Install

This repository contains multiple pi packages, so install this package from a checkout:

```sh
npm --prefix pi-last-turn-review install
pi install ./pi-last-turn-review
```

A one-command Git install for this package requires publishing it separately or moving it to its own repository.

## What it does

- Opens a native diff review window for the latest agent turn with file changes.
- Renders all changed files stacked in one scroll region with [`@pierre/diffs`](https://diffs.com/), sticky file headers and a file sidebar that follows your scroll position. Syntax highlighting runs in web workers.
- Inline comments: click a line number for one line, drag across line numbers for a range. Works on the old and the new side. Each file header has File comment, Mark reviewed and Collapse.
- Toolbar toggles for unified/split view, line wrap and full-file context. `j`/`k` jump between files, `Cmd/Ctrl+Enter` finishes the review.
- Inserts the review feedback back into pi for the agent to address.
- Can review current Git working-tree changes too.
- Can annotate the latest assistant response: rendered markdown, click a paragraph, list item, table row or single code line to comment on it, or select text to comment on a passage.
- Can undo the latest changed agent turn when the worktree still matches it.
- The `/diff-turn` window has an **Undo turn** button that discards pending comments and runs the same undo (confirmed in the terminal).

## Commands

- `/diff-turn` — review the latest agent turn diff.
- `/diff-git` — review current Git changes.
- `/annotate-turn` — annotate the latest assistant response.
- `/undo-turn` — undo the latest changed agent turn.

## Development

```sh
npm install
npm run check
node test/harness.mts            # open the real window with a sample four-file diff
node test/harness.mts test/smoke.js   # drive it with pointer events and assert the submit payload
node test/annotate-harness.mts   # open the annotate window with sample markdown
node test/annotate-smoke.mts     # add comments on a list item, code line, table row and a selection, assert the submit payload
npm run build:vendor             # rebuild web/vendor/ after changing @pierre/diffs, scripts/shiki-shim.js or Tailwind classes
```

`web/vendor/` holds the prebuilt `@pierre/diffs` bundles (main + worker), `markdown-it` and the compiled Tailwind CSS. They are inlined into the windows, so nothing is fetched from the network. `scripts/shiki-shim.js` lists the languages that get highlighted; anything else renders as plain text.

## License

MIT. Portions are based on work from [`badlogic/pi-diff-review`](https://github.com/badlogic/pi-diff-review).
