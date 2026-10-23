# herdr-settle

Closes finished pi tabs in Herdr and keeps them on a shelf you can reopen from. Modeled on T3 Code's
thread settling.

## Install

Add this directory to `packages` in `~/.pi/agent/settings.json`, then run `/reload` in open pi
sessions. Link the Herdr plugin for the shelf and the tab action:

```bash
herdr plugin link /absolute/path/to/pi-extensions/herdr-settle
```

Bind the shelf in `~/.config/herdr/config.toml`, then run `herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+s"
type = "plugin_action"
command = "local.herdr-settle.open"
description = "settled tabs"
```

Requires Herdr 0.8.2 or newer, the Herdr pi integration (`herdr integration install pi`), Node 26,
and `glab` for merge request checks.

## Automatic settling

The extension runs in every interactive pi inside a Herdr pane, except simple-subagent children.
It checks 10 to 30 seconds after a session starts, then every 30 to 35 minutes. It settles the tab
when:

- the branch's GitLab merge request merged or closed after the last user message, or
- the session has had no messages for 7 days.

Only GitLab is checked. Branches with a GitHub remote, the default branch, `main`, and `master`
are ignored. An open merge request for the branch stops merge-based settling but not inactivity.

A check never closes the tab when:

- the tab is focused,
- this pi is working, has queued messages, or has unsent text in its editor,
- the session changed while the check ran,
- another agent in the tab is working or blocked, or is not pi,
- another pi in the tab has no session file, or wrote to it in the last 7 days (inactivity only),
- another pane in the tab runs a command, such as a dev server,
- a simple-subagent pane in the workspace is working or blocked.

Settling records every pi session in the tab on the shelf, then closes the tab.

## Idle subagent panes

On the same schedule, each pi closes simple-subagent panes (panes with the `simple_subagent`
token) in every workspace whose session file has not changed for 14 hours. Working, blocked, and
focused subagent panes stay. Closed subagent panes do not go on the shelf; continue one with the
`pi --session` command from its result message. The check looks up
the pane's current tab, so a pi pane moved into another tab settles the tab it is in now. A GitLab
lookup failure shows one warning per pi process, with the log path; inactivity settling still
applies.

All pi processes run their `glab` calls one at a time, through a lock at
`<agent dir>/herdr-settle/glab.lock`. glab renews an expired GitLab OAuth login with a refresh token
that works only once, so parallel calls could fail with `invalid_grant`. A call that still fails with
`invalid_grant`, because a `glab` outside herdr-settle renewed the login at the same moment, is
retried once after 2 seconds.

## Shelf

The `local.herdr-settle.open` action opens a popup with the settled tabs, newest first.

| Key | Action |
| --- | --- |
| `Enter` | Reopen the tab in its workspace and resume its pi sessions |

When settling closed a workspace's last tab, Herdr closes the workspace too. Reopening then uses
an open workspace with the same name, or creates it again in the tab's folder with that name.
| `↑` / `↓`, `k` / `j` | Select |
| `d` / `x` | Remove from the shelf |
| `q` / `Esc` | Close |

Reopening counts as activity, so the reopened tab is not settled again for 7 days unless its merge
request changes. Reopening refuses when a session file or its directory is gone; remove such
entries with `d`. When only some sessions start, those leave the shelf and the rest stay for another
try.

The **Settle tab** action in the tab context menu settles that tab by hand. It refuses while an
agent in the tab is working or blocked, and it closes running commands.

## Storage

Events go to `<agent dir>/herdr-settle/shelf.jsonl`, where the agent directory is
`PI_CODING_AGENT_DIR` or `~/.pi/agent`. Plugin actions run with the Herdr server's environment, so
the shelf popup and **Settle tab** use the server's agent directory. A pi started with a different
`PI_CODING_AGENT_DIR` writes to its own shelf, which the popup does not show. Reopened pi processes
get the agent directory recorded when their tab settled. `skipped` events record why a due check left a tab open;
they are written only when the reason changes.

## Log

`<agent dir>/herdr-settle/log.jsonl` gets one line per check, **Settle tab** action, and reopen from
the shelf, from every process. Past 10 MB one process moves it to `log.old.jsonl`, replacing the
previous one; a lock keeps concurrent processes from rotating twice.

Each line has the start time (`at`), duration (`ms`), `pid`, `op` (`check`, `settle-action`, or
`reopen`), `outcome`, the session and cwd, and whatever the operation found: the merge request
result, `lookupError`, `reason`, `blockers`, closed subagent panes, the shelf id, and `error`.
`commands` lists the `herdr`, `git`, and `glab` calls that finished before the line was written,
with arguments, start offset `t` and duration `ms` in milliseconds, exit code, and on failure the
command's output. A `settled` line is written before `herdr tab close`, so it never includes that
call.

Every string is cut to 2000 characters, marked with `…[+N chars]`. Credentials in URLs, such as
`https://oauth2:TOKEN@host`, become `https://***@host`. The log still holds paths, branch names,
and command output, so treat it as private. On macOS and Linux it is created with mode `0600`; on
Windows it inherits the permissions of the agent directory.

| Outcome | Meaning |
| --- | --- |
| `busy` | pi was working, had queued messages, or had unsent editor text |
| `kept` | nothing is due |
| `skipped` | settling was due, but `blockers` kept the tab open |
| `changed` | the session changed while the check ran |
| `stale` | the session was replaced or shut down while the check ran |
| `settled` | the tab went on the shelf; written before the tab closes, and followed by a `failed` line if closing fails |
| `reopened` | the shelf reopened the tab |
| `failed` | the operation threw; see `error` |
| `interrupted` | the process exited mid-operation, for example Ctrl+C in the shelf during a reopen |

```bash
tail -n 20 ~/.pi/agent/herdr-settle/log.jsonl | jq -c '{at, pid, op, outcome, lookupError}'
```

## Test

`log.integration.test.ts` runs real Node processes against the log and needs no Herdr: 60
processes rotating at once, and an operation cut short by `process.exit`.

The end-to-end tests drive real pi and Herdr processes in new unfocused tabs. The plugin action
test runs when `local.herdr-settle` is linked; it writes a settled and a removed event to the Herdr
server's shelf. The merge request test needs a GitLab remote with merged merge requests:

```bash
HERDR_SETTLE_TEST_GITLAB_REMOTE=git@gitlab.com:group/project.git npm test
```
