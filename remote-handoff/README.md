# Remote Handoff

Remote Handoff hands one Pi conversation and its project files to Pi on a trusted SSH host, then brings the conversation and file changes back.

It is a personal interactive tool. Remote machine setup is manual, and remote Pi runs with the full permissions of the SSH user.

## Requirements

The local machine needs:

- Git with `less` as its pager (full Git for Windows includes it, MinGit does not)
- Node.js 22.19.0 or newer
- Pi
- npm
- OpenSSH `ssh` and `scp`

The remote host needs:

- Bash
- Git
- Node.js 22.19.0 or newer
- npm and required registry access
- `tar`
- `flock`
- `pkill`
- OpenSSH `ssh`
- Herdr 0.8.2 or newer, or what Remote Handoff needs to install it: `curl`, `awk`, one of `sha256sum`, `shasum`, or `openssl`, and access to `herdr.dev` and GitHub

Both `ssh` and `scp` must reach the host in batch mode. Saved targets use `host` or `user@host` syntax.

On macOS and Linux, Remote Handoff reuses one SSH connection per host through OpenSSH connection sharing. The control socket lives in a private directory under the system temporary directory and closes 60 seconds after the last use. Windows OpenSSH does not support connection sharing, so each remote step opens its own connection.

The project can be a Git repository with at least one commit or an ordinary directory. For an ordinary directory, Remote Handoff treats Pi's current working directory as the project root and keeps private Git metadata under the Pi agent directory. It does not create `.git` in the project.

`.gitignore` rules apply in both modes. Git submodules, embedded repositories, Git LFS, and Git content filters are unsupported.

Install browser tools and other task-specific programs on the remote host before starting a handoff. Remote Handoff does not install machine dependencies.

Remote Handoff looks for Herdr 0.8.2 or newer on the remote `PATH`, in `~/.local/bin/herdr`, and in `~/.pi-remote-handoff/herdr/herdr`. When none exists, it runs Herdr's official installer with `HERDR_INSTALL_DIR=~/.pi-remote-handoff/herdr`. The installer downloads the latest stable release and verifies its SHA-256 checksum. It does not replace the host's normal Herdr installation.

## Install

```bash
pi install /path/to/pi-extensions/remote-handoff
```

Open a persisted Pi conversation in the project, then run:

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

One project can have one handoff. Remote Handoff keys Git projects by their Git common directory, so linked worktrees cannot start separate handoffs. It keys ordinary directories by their canonical absolute path. Different projects can have handoffs at the same time.

## Start a handoff

`start` checks the project and the selected remote host. It uses the only saved host automatically, asks when several hosts exist, or prompts for a host when none exist.

Remote Handoff transfers:

- the selected branch of the active Pi conversation
- tracked files and non-ignored untracked files from a Git project
- non-ignored files from an ordinary directory
- Git history reachable from the handoff snapshot, including private snapshot history for an ordinary directory
- a private portable Pi profile
- Pi credentials in a separate `0600` file

Ignored files stay local.

The portable profile follows `.gitignore` too. Remote Handoff always copies each configured package, resource, and agent-directory entry. Inside a directory that belongs to a Git work tree, it copies only the files that `git ls-files --cached --others --exclude-standard` lists for that work tree. Tracked files are always copied. Symlinked directories use the ignore rules of the repository they point into. Directories outside Git are copied in full, apart from `node_modules` and `.git`. A local package whose built output is gitignored, such as `dist/`, arrives without that output.

An ordinary-directory handoff continues using its private Git metadata if someone runs `git init` in the project while the handoff is active. Remote Handoff never reads or removes that new `.git` directory.

Remote Handoff prepares the local snapshot, then reserves the conversation while it uploads the handoff, prepares the remote private profile, and starts Pi. The upload is one compressed SSH stream. Profile file contents are stored by SHA-256 in `~/.pi-remote-handoff/profile-objects` on the remote host, so later handoffs upload only files whose contents changed. It records a unique launch ID before asking the remote host to start Pi. The remote launch records the same ID under `flock` before starting Herdr or Pi.

The conversation remains locally reserved while launch status is uncertain. Local prompts cannot continue that conversation during this period. Remote Handoff transfers ownership only after it confirms the matching remote launch. A lost SSH acknowledgment is reconciled by launch ID and cannot start a second Pi process.

After confirmation, local Pi switches to a private control conversation and attaches automatically.

## Work remotely

A remote run can contain any number of prompts and responses.

Run `/remote-handoff` inside remote Pi to:

- detach and leave Pi running
- stop Pi and prepare a result
- show status

Detach returns to the local control conversation. Other local Pi conversations and local repository edits remain available. The handed-off conversation itself stays blocked locally.

Attach uses Herdr's own terminal client over `ssh -t`. Herdr's `ctrl+b q` also detaches, and a literal `ctrl+b` needs `ctrl+b ctrl+b`. When local Pi runs inside a local Herdr session, local Herdr receives `ctrl+b` first, so use `/remote-handoff` in remote Pi to detach.

The control conversation watches detached work and reports when a result is prepared or when Pi stops without one.

`stop and prepare result` aborts an active turn when needed, shuts down Pi, and captures the current conversation and repository state. A failed Pi process also prepares partial work when capture succeeds.

If graceful stop times out, Remote Handoff offers force stop. Force stop ends the dedicated Herdr session and can leave no result. The handoff remains available for continuation or discard.

`continue remotely` checks the private profile and Pi runtime, attempts repairs when needed, starts a new run with a new launch ID, and attaches. Continuing a prepared result deletes that result first. A fresh result must be prepared before apply.

## Review and apply

`view diff` shows the changes between the handoff snapshot and the prepared result in `less` through `git diff`. Press `q` to return to the lifecycle menu. It does not prompt for apply and does not touch the real index or worktree.

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

Remote Handoff shows the final apply-only changes in `less` and requires confirmation. It checks the local snapshot again after confirmation. If local files changed during review, it discards the attempt and restarts against the latest files.

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

The exact local Pi version is installed under `~/.pi-remote-handoff/runtime/<version>` on the remote host. Workspaces on that host share each runtime version, the profile object store, and the portable package dependency cache in `~/.pi-remote-handoff/package-dependencies`. Installing a new version leaves other versions untouched. Each handoff still gets a fresh private profile copied from the object store.

A dependency cache entry is keyed by the package manifest without `scripts`, its `package-lock.json`, `npm-shrinkwrap.json`, and `.npmrc`, and the remote Node, npm, and OS versions. Other file changes in the package reuse the entry. Packages that use local-path dependencies, `link:` dependencies, or npm workspaces are keyed by the contents of every portable package instead. Cached `node_modules` trees are hard-linked into the workspace when the file system allows it.

`profile-objects` and `package-dependencies` are caches. Remote Handoff never prunes them. Delete them only while no handoff uses the host.

## Security and transfer scope

Conversation JSONL, project files, reachable Git history, profile files, and credentials can contain secrets. Review the project and Pi profile before handing them to a host.

Remote Pi is not sandboxed. Use only SSH hosts and Pi configuration that you trust.

## Develop

```bash
npm install
npm run build
```

`npm run build` is `tsc --noEmit`, so it only typechecks and produces no output files.

Run the full real end-to-end verification after lifecycle changes:

```bash
npm run verify:e2e
```

This uses the configured SSH host, real Pi credentials, real Herdr sessions, and a real merge-review model call. It creates isolated temporary repositories and profiles and cleans them afterward. Run one scenario with `E2E_SCENARIO=direct|directory|merge|restart`.
