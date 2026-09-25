# rm-guard

Pi extension that puts a path-checking `rm` first in `PATH` for every `bash` command. `rm` can
only delete inside the project, the user temp dir, or `/tmp`; for anything else it asks you
first. It guards `rm` only, see "Not covered".

Every bash command gets `bin/` from this package first in `PATH`. `bin/rm` checks each operand
after the shell expanded variables and globs, refuses anything that is not inside the session
cwd, the user temp dir, or `/tmp`, and otherwise runs `/bin/rm`. All operands are checked before
anything is deleted.

## Asking the user

When pi runs with a UI, a blocked `rm` does not fail right away. `bin/rm` writes the resolved
paths of the blocked operands to a request file in a per-command temp dir (`PI_RM_ASK_DIR`), and
the extension shows a confirm dialog listing them. Yes runs `/bin/rm` with the original
arguments. No, Escape, or aborting the turn makes `rm` exit 3 with `The user declined this
deletion.` One dialog per `rm` call, so `make clean` with three blocked `rm` calls asks three
times. Dialogs from parallel commands are shown one after another. There is no timeout; the
command waits until you answer. If the ask dir disappears while `rm` waits (the turn ended or was
aborted), `rm` exits 3.

Without a UI (`pi -p`, subagents) blocked calls exit 3 immediately, as before.

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

- A plain operand is checked by its parent directory, so `rm link` removes only the link, even
  when the link points outside.
- `link/` and glob results like `link/child` are resolved through the link, because `/bin/rm`
  follows it there. `.` and `..` are resolved fully as well.
- An allowed root itself and anything containing one are refused. `rm -rf .` from the root,
  `rm -rf /abs/path/to/project`, and `rm -rf ..` from a project under `/tmp` all fail.
- Operands that do not exist are skipped, so `rm -f missing` stays a no-op.
- Blocked calls exit 3 and print every blocked operand, its resolved path, and the allowed
  directories.
- Configuration errors (an allowed directory is `/` or missing) exit 64 without deleting
  anything. The extension refuses to start a command when a directory contains `:` or a newline.

## Not covered

`/bin/rm`, `sudo rm`, `find -delete`, `git clean`, `rsync --delete`, `rimraf`, `shutil.rmtree`,
and anything else that unlinks without calling `rm`. For those you need an OS sandbox or a backup
the agent cannot reach. The guarded command runs as your user and sees `PI_RM_ASK_DIR`, so it
could also write its own `allow` reply. This is an accident guard, not a sandbox.

## Tests

```bash
npm test
```

`rm.test.ts` runs the real wrapper through `/bin/bash` in a temp tree. `rm.docker.test.ts` runs
`rm -rf "$UNSET"/*` on real bash 3.2 inside a `bash:3.2` container, with a control run that shows
the container filesystem is destroyed without the guard. Docker must be running.
