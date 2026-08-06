# wt

`wt` is a tiny Node script that wraps `git worktree` for branch-per-task work.

**Requirements:** Git, Node 22.18+ (for built-in TypeScript type stripping), and Perl for the `cd` prefill.

**Install:** symlink `wt.mts` as `wt` into your `PATH`, e.g. `ln -s "$PWD/wt.mts" ~/.local/bin/wt`.
The extension has to stay on the real file: Node only strips types from `.ts`/`.mts` files.

Compared to plain `git worktree add`, it also:

- names the worktree directory from the branch (`repo_branch-name`) next to the current repo
- fetches `origin` before creating it, unless `--no-fetch`
- creates the branch from `main` by default, or `--base <ref>`
- refuses `wt new <branch>` when the branch already exists locally or as `origin/<branch>`
- clones existing remote branches with `wt clone <branch>` from `origin/<branch>`
- restores an existing local branch into a worktree when it exactly matches `origin/<branch>`
- accepts copied remote refs as `wt clone origin/<branch>`
- creates new branches with no upstream inherited from `main`
- configures branch pushes to target `origin/<branch>` without pushing
- prefills `cd <path>` in interactive terminals after `wt new` and `wt clone`
- copies useful Rider `.idea` settings into the new worktree
- sanitizes copied Rider VCS mappings and attached-folder layout for the new worktree
- can print a worktree path, run a command in it, or remove it by branch name

## Usage

```sh
wt new <branch>
wt new <branch> --base origin/main
wt new <branch> --path ../custom-dir
wt clone <branch>
wt clone origin/<branch>
```

Get all commands/options:

```sh
wt help
```
