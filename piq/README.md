# piq

Small one-shot wrappers around `pi`.

## Commands

- `pil <prompt>` — `openai-codex/gpt-5.5:low`, normal answer
- `pim <prompt>` — `openai-codex/gpt-5.5:medium`, normal answer
- `pic <prompt>` — `openai-codex/gpt-5.6-sol:medium`, command mode

All three also read piped stdin. With arguments and piped text, both are sent. With no arguments on a TTY, they ask for the prompt interactively.

## Command Mode

`pic` returns a shell command by placing it into your terminal input field. It does not press Enter.

Example:

```sh
pic merge origin main into local
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
`pic` to place the command into the terminal. This needs a C compiler (`cc`/`clang`/`gcc`)
on `PATH`. Rebuild it any time with `npm run build`.

## Notes

- Auto-discovered pi extensions are disabled.
- `pic` runs with `--no-builtin-tools`, loads `extensions/respond-command.ts`, and exposes only the `respond_command` tool.
- `pil`, `pim`, and `pic` run with `pi --no-session`, so they do not create or resume sessions.
- `pic` fills the terminal input via the `TIOCSTI` ioctl (compiled helper, no
  python dependency). Works on macOS and BSD. On recent Linux kernels `TIOCSTI`
  is gated behind the `dev.tty.legacy_tiocsti` sysctl (off by default); when it
  is disabled the injection fails and `pic` reports the error.
- `PIQ_COMMAND_RESPONSE_FILE` overrides the file `respond_command` writes to. The
  default is `<tmpdir>/piq/command-response/<pid>.json`.
