# pi-editors

Pi extension that opens the current working directory in an editor:

```text
/rider
/zed
```

On macOS, the commands open the Rider or Zed application through `/usr/bin/open`. On Windows,
`rider64.exe` and `zed.exe` must be on `PATH`.

## Install

Add this directory to `packages` in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["/absolute/path/to/pi-extensions/editors"]
}
```

Then run `/reload` in Pi.
