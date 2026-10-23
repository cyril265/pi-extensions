# piq

Small one-shot wrappers around `pi`.

## Commands

- `piq <prompt>` means "pi question". Prints an answer.
- `pix <prompt>` means "pi execute". Fills the shell input without pressing Enter.

Both use `openai-codex/gpt-5.6-sol:medium` and replace `pil`, `pim`, and `pic`.

Both also read piped stdin. With arguments and piped text, both are sent. With no arguments on a TTY, they ask for the prompt interactively.

## Command mode

`pix` returns a shell command by placing it into your terminal input field. It does not press Enter.

Example:

```sh
pix merge origin main into local
```

fills:

```sh
git fetch origin main && git merge origin/main
```

## Install

```sh
npm link
```

`npm link` compiles a small C helper (`native/tiocsti.c` → `build/tiocsti`) used by
`pix` to place the command into the terminal. This needs a C compiler (`cc`/`clang`/`gcc`)
on `PATH`. Rebuild it any time with `npm run build`.

## Notes

- Auto-discovered pi extensions are disabled.
- `piq` retains pi's built-in tools for investigation and actions.
- `pix` runs with `--no-builtin-tools`, loads `extensions/respond-command.ts`, and exposes only the `respond_command` tool.
- `piq` and `pix` run with `pi --no-session`, so they do not create or resume sessions.
- `pix` fills the terminal input via the `TIOCSTI` ioctl (compiled helper, no
  python dependency). Works on macOS and BSD. On recent Linux kernels `TIOCSTI`
  is gated behind the `dev.tty.legacy_tiocsti` sysctl (off by default); when it
  is disabled the injection fails and `pix` reports the error.
- `PIQ_COMMAND_RESPONSE_FILE` overrides the file `respond_command` writes to. The
  default is `<tmpdir>/piq/command-response/<pid>.json`.
