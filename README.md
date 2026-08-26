# Remote Handoff

Remote Handoff hands one Pi conversation and its repository state to Pi on a trusted SSH host, then brings the conversation and file changes back.

It is a personal interactive tool. Remote machine setup is manual, and remote Pi runs with the full permissions of the SSH user.

## Requirements

The local machine needs:

- Git
- Herdr 0.8.2 or newer
- Node.js 22.19.0 or newer
- Pi
- npm
- `tar`
- OpenSSH `ssh` and `scp`

The remote host needs:

- Bash
- Git
- Herdr matching the exact local build
- Node.js 22.19.0 or newer
- npm and required registry access
- `tar`
- `flock`
- OpenSSH `ssh`

Both `ssh` and `scp` must reach the host in batch mode. Saved targets use `host` or `user@host` syntax.

The project must be a Git repository with at least one commit. Git submodules, Git LFS, and Git content filters are unsupported.

Install browser tools and other task-specific programs on the remote host before starting a handoff. Remote Handoff installs neither machine dependencies nor Herdr.

## Install

```bash
pi install /absolute/path/to/pi-remote-handoff
```

Open a persisted Pi conversation in the repository, then run:

```text
/remote-handoff
```

Remote Handoff has no command arguments. It opens a menu with the actions valid for the current handoff.

## Lifecycle

With no handoff, the menu offers:

- `start`
- `remotes`

While remote Pi is active:

- `attach`
- `status`
- `stop and prepare result`

When remote Pi stopped without a result:

- `continue remotely`
- `status`
- `discard`

When a result is prepared:

- `view diff`
- `continue remotely`
- `apply`
- `discard`

After local apply succeeds but remote cleanup fails:

- `retry cleanup`
- `status`

After an SSH connection failure, Remote Handoff offers `retry connection` and `abandon unreachable handoff` while the handed-off conversation still belongs to the handoff.

One Git repository can have one handoff. Remote Handoff keys this rule by the repository's Git common directory, so linked worktrees cannot start separate handoffs. Different repositories can have handoffs at the same time.

## Start a handoff

`start` checks the repository, local Herdr, and the selected remote host. It uses the only saved host automatically, asks when several hosts exist, or prompts for a host when none exist.

Remote Handoff transfers:

- the selected branch of the active Pi conversation
- tracked files
- non-ignored untracked files
- Git history reachable from the handoff snapshot
- a private portable Pi profile
- Pi credentials in a separate `0600` file

Ignored files stay local.

Remote Handoff prepares the local snapshot, then reserves the conversation while it uploads the handoff, prepares the remote private profile, and starts Pi. It records a unique launch ID before asking the remote host to start Pi. The remote launch records the same ID under `flock` before starting Herdr or Pi.

The conversation remains locally reserved while launch status is uncertain. Local prompts cannot continue that conversation during this period. Remote Handoff transfers ownership only after it confirms the matching remote launch. A lost SSH acknowledgment is reconciled by launch ID and cannot start a second Pi process.

After confirmation, local Pi switches to a private control conversation and attaches automatically.

## Work remotely

A remote run can contain any number of prompts and responses.

Run `/remote-handoff` inside remote Pi to:

- detach and leave Pi running
- stop Pi and prepare a result
- show status

Detach returns to the local control conversation. Other local Pi conversations and local repository edits remain available. The handed-off conversation itself stays blocked locally.

The control conversation watches detached work and reports when a result is prepared or when Pi stops without one.

`stop and prepare result` aborts an active turn when needed, shuts down Pi, and captures the current conversation and repository state. A failed Pi process also prepares partial work when capture succeeds.

If graceful stop times out, Remote Handoff offers force stop. Force stop ends the dedicated Herdr session and can leave no result. The handoff remains available for continuation or discard.

`continue remotely` checks the private profile and Pi runtime, attempts repairs when needed, starts a new run with a new launch ID, and attaches. Continuing a prepared result deletes that result first. A fresh result must be prepared before apply.

## Review and apply

`view diff` shows the changes between the handoff snapshot and the prepared result. Closing the viewer returns to the lifecycle menu. It does not prompt for apply and does not touch the real index or worktree.

When local files still match the handoff snapshot, apply builds a direct binary patch.

When local files changed, Remote Handoff starts merge review:

1. It snapshots the current local files with a temporary Git index.
2. It creates a detached temporary worktree whose merge base is the handoff snapshot.
3. Git performs its normal three-way merge first.
4. A child Pi opens a temporary copy of the handed-off conversation in that worktree.
5. Pi inspects textual conflicts and clean merges for semantic conflicts.
6. Pi asks when intent is ambiguous, including binary and untracked-path collisions.
7. Completing review builds a patch containing only changes relative to the current local files.

Leaving merge review deletes the temporary worktree and conversation copy. The prepared result remains available.

Remote Handoff shows the final apply-only patch and requires confirmation. It checks the local snapshot again after confirmation. If local files changed during review, it discards the attempt and restarts against the latest files.

After confirmation, Remote Handoff returns credentials, records a recoverable apply plan, returns the reviewed conversation, and applies the patch without updating the Git index. Existing staged state stays staged. Incoming changes remain unstaged.

Remote Handoff records local apply success before remote cleanup. If cleanup fails, `retry cleanup` only removes remote and local handoff resources. It never reapplies the result.

## Discard and abandonment

`discard` returns refreshed credentials, verifies and returns the unchanged original conversation, and removes the remote and local handoff data. It refuses when the host is unreachable.

Use `abandon unreachable handoff` only when the host will not return. It verifies and returns the unchanged original conversation, then removes local handoff metadata and refs. It cannot recover or delete remote files, remote conversation changes, or refreshed remote credentials.

## Authentication

Each handoff uses a private remote Pi profile. Remote Handoff never reads or changes the remote user's shared `~/.pi/agent/auth.json`.

Apply and discard merge returned credentials by provider against the handoff baseline:

- one-sided additions, changes, and deletions survive
- identical changes merge automatically
- when local and remote changed the same provider differently, the TUI asks which complete credential to keep

Credential fields from two versions are never combined.

The exact local Pi version is installed under `~/.pi-remote-handoff/runtime` on the remote host. Workspaces on that host share the runtime and portable package dependency caches. Each handoff still gets a fresh private profile.

## Security and transfer scope

Conversation JSONL, reachable Git history, profile files, and credentials can contain secrets. Review the repository and Pi profile before handing them to a host.

Remote Pi is not sandboxed. Use only SSH hosts and Pi configuration that you trust.

## Develop

```bash
npm install
npm run build
```

Run the full real end-to-end verification after lifecycle changes:

```bash
npm run verify:e2e
```

This uses the configured SSH host, real Pi credentials, real Herdr sessions, and a real merge-review model call. It creates isolated temporary repositories and profiles and cleans them afterward. Run one scenario with `E2E_SCENARIO=direct|merge|restart|namespace`.
