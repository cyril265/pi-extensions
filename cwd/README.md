# pi-cwd

Continue the current Pi session in another working directory without losing its history.

## Install

Add this directory to `packages` in the global `~/.pi/agent/settings.json`, so `/cwd` remains available after switching projects:

```json
{
  "packages": ["/path/to/pi-extensions/cwd"]
}
```

Reload Pi, then run:

```text
/cwd ../another-project
/cwd ~/src/project
/cwd /absolute/path/to/project
```

The command creates a session copy under the target working directory and switches to it. When the current session directory is not Pi's default `--<path>--` directory for the current working directory, the copy stays in that session directory instead. Pi then reloads cwd-bound tools, settings, context files, skills, prompts, extensions, and project trust. A persisted source session remains unchanged and is recorded as the copied session's parent. Before the first assistant response, `/cwd` instead materializes the current in-memory session directly in the target directory.

When Pi runs interactively in Warp, `/cwd` also updates the tab title and emits Warp's OSC 7 working-directory sequence. The title uses the target directory name, while OSC 7 updates Warp's tab working directory and Git branch display; it does not change the parent shell's directory after Pi exits.

`/cwd` is unavailable when Pi runs with `--no-session`.
