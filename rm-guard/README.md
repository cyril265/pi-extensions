# rm-guard

Pi extension that puts a path-checking `rm` first in `PATH` for every `bash` command the model
runs. `rm` can only delete directories inside the project, the user temp dir, or `/tmp`; for a
directory anywhere else it asks you first. Files and symlinks are deleted without a check. It
guards `rm` only, see "Not covered".

`bin/rm` checks each directory operand after the shell expanded variables and globs, refuses any
that is not inside the session cwd, the user temp dir, or `/tmp`, and otherwise runs `/bin/rm`.
All operands are checked before anything is deleted, so one blocked directory keeps the files in
the same call too.

## How the guard reaches bash

The extension does not change the command text. On session start it puts `bin/` first in pi's own
`PATH` and sets `PI_RM_ALLOW` (the allowed directories) and `PI_RM_ASK_DIR` in pi's environment.
Every process pi starts inherits them, so this works with pi's built-in `bash` tool and with
replacements such as `pi-background-terminals`, whose titles, `/ps` view, and duplicate check see
the command exactly as the model wrote it. Session shutdown removes all three again.

`bin/rm` only guards processes that carry `PI_SESSION_ID`, which pi and `pi-background-terminals`
set for the model's `bash` commands only. Commands you run with `!`, MCP servers, and
subprocesses of other extensions also find `bin/rm` first, but it hands them straight to
`/bin/rm`.

## Asking the user

When pi runs with a UI, a blocked `rm` does not fail right away. `bin/rm` writes the resolved
paths of the blocked directories to a request file in a per-session temp dir (`PI_RM_ASK_DIR`), and
the extension shows a confirm dialog listing them. Yes runs `/bin/rm` with the original
arguments. No or Escape makes `rm` exit 3 with `The user declined this deletion.` One dialog per
`rm` call, so `make clean` with three blocked `rm` calls asks three times. Dialogs from parallel
commands are shown one after another. There is no timeout; the command waits until you answer.

The ask dir lives as long as the session, so a command that `pi-background-terminals` moved to the
background still asks after its tool call returned, also while the agent is idle. When the
session ends (quit, `/new`, `/resume`, `/fork`, `/reload`), the dialog closes and a waiting `rm`
exits 3.

Without a UI (`pi -p`, subagents) blocked calls exit 3 immediately, as before. A headless pi
clears an inherited `PI_RM_ASK_DIR`. A child pi that does not load rm-guard keeps the parent's
settings, so its blocked `rm` calls ask in the parent's UI.

While a dialog is open, the extension emits `herdr:blocked` on `pi.events`. The herdr pi
integration (`herdr integration install pi`) then shows the pane as blocked with the message
`rm needs confirmation`. Without herdr, nothing listens and the event has no effect.

The temp dirs are allowed so that `T=$(mktemp -d); ...; rm -rf "$T"` keeps working. macOS
`mktemp` ignores `TMPDIR`, so a private scratch dir cannot capture it. The cost: `rm -rf /tmp/*`
and `rm -rf "$TMPDIR"/*` delete everything writable there, including other jobs' temp data.

This catches the two documented ways agents wiped home directories in 2026:

- `rm -rf "$BUILD_DIR"/*` with the variable unset, which expands to `rm -rf /*`
- `rm -rf "$HOME"` after the model tried to point `HOME` at a temp dir in an earlier command,
  and `cd $UNSET && rm -rf *`, where a bare `cd` lands in `$HOME`

Both expand to directories. A glob that matches only files, such as `rm -f "$UNSET"/*.log`, is
not caught.

Text-level guards such as leash cannot see the second group. This guard also reaches `rm` inside
`bash script.sh`, `make clean`, `xargs rm`, `find -exec rm`, and subprocesses, because they all
resolve `rm` through `PATH`.

## Install

```json
{
  "packages": ["/absolute/path/to/pi-extensions/rm-guard"]
}
```

## Rules

- Only directories are checked. Files, other non-directories, symlinks, and operands that do not
  exist are skipped, so `rm ../outside/file` and `rm -f missing` run unchanged.
- `rm link` removes only the link, even when it points to a directory outside. `link/` and glob
  results like `link/sub` are resolved through the link, because `/bin/rm` follows it there.
  `.` and `..` are resolved fully as well.
- An allowed root itself and anything containing one are refused. `rm -rf .` from the root,
  `rm -rf /abs/path/to/project`, and `rm -rf ..` from a project under `/tmp` all fail.
- Blocked calls exit 3 and print every blocked directory, its resolved path, and the allowed
  directories.
- Configuration errors (an allowed directory is `/` or missing, or `PI_RM_ALLOW` is not set)
  exit 64 without deleting anything. When the session cwd or temp dir contains `:` or a newline,
  session start reports an error and leaves `PI_RM_ALLOW` unset, so every guarded `rm` exits 64.
- On Windows, drive paths such as `C:\work` are passed to Git Bash as `/c/work`.

## Not covered

Files deleted with `rm`, and `/bin/rm`, `sudo rm`, `find -delete`, `git clean`, `rsync --delete`,
`rimraf`, `shutil.rmtree`, and anything else that unlinks without calling `rm`. For those you need
an OS sandbox or a backup the agent cannot reach. The guarded command runs as your user and sees
`PI_RM_ASK_DIR`, so it could also write its own `allow` reply, and a command that unsets
`PI_SESSION_ID` gets plain `/bin/rm`. This is an accident guard, not a sandbox.

## Tests

```bash
npm test
```

`rm.test.ts` runs the real wrapper through `/bin/bash` in a temp tree. `rm.docker.test.ts` runs
`rm -rf "$UNSET"/*` on real bash 3.2 inside a `bash:3.2` container, with a control run that shows
the container filesystem is destroyed without the guard. Docker must be running.

```bash
npm run test:e2e
```

`extension.e2e.test.ts` starts pi in RPC mode with this extension, once with the built-in `bash`
tool and once with `pi-background-terminals`, and lets `openai-codex/gpt-5.6-luna:minimal` run
commands. It checks that the shell runs the model's command unchanged, that a blocked `rm` asks,
that a backgrounded command asks after its tool call returned, and that `!` commands are not
guarded. Each case deletes a directory outside the project. It spends model credits and needs an
`openai-codex` login.
