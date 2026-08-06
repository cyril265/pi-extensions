# piq

Small one-shot wrappers around `pi`.

## Commands

- `pil <prompt>` — low reasoning, normal answer
- `pim <prompt>` — medium reasoning, normal answer
- `pic <prompt>` — GPT-5.6 Sol with medium reasoning, command mode

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
- `pic` enables only the built-in `respond_command` extension/tool.
- `pil`, `pim`, and `pic` run with `pi --no-session`, so they do not create or resume sessions.
- `pic` fills the terminal input via the `TIOCSTI` ioctl (compiled helper, no
  python dependency). Works on macOS and BSD. On recent Linux kernels `TIOCSTI`
  is gated behind the `dev.tty.legacy_tiocsti` sysctl (off by default); when it
  is disabled the injection fails and `pic` reports the error.
