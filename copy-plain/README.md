# pi-copy-plain

Pi extension that adds `/copy-plain`.

The command copies the last assistant message like Pi's built-in `/copy`, but prepares the
clipboard for pasting outside Pi:

- `text/plain`: clean plain text with Markdown markers removed.
- `text/html`: rich fallback for apps that consume HTML from the clipboard, such as Slack in
  its default WYSIWYG composer on macOS.

If rich clipboard support is unavailable, the command still copies the clean plain-text version.

Slack note: rich HTML paste works with Slack's default WYSIWYG composer. If Slack's
“Format messages with markup” preference is enabled, Slack intentionally pastes copied messages as
plain text.

## Install

Add this directory as a Pi package, for example from this repository:

```json
{
  "packages": ["/absolute/path/to/pi-extensions/copy-plain"]
}
```

Then run `/reload` in Pi.
