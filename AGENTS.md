## OS Compatability

make sure all code is macos and windows compatible

# tests
write only meaningful e2e tests, no unit test spam

## Changelog

Before committing, update the root `CHANGELOG.md` with all notable changes. Within each dated release, group entries under `### <extension-name>` headings. Use `### General` for changes that are not specific to one extension.

## Sync

Treat `/Users/kpovolotskyy/ai-stuff/ai-lab/` `pi/` as a remote of this repository. The source `HEAD` hash recorded in each sync commit message is the merge base.

Before starting work, pull `ai-lab`. Find its last sync commit, read the recorded source hash, and diff `pi/` between that commit and `ai-lab` `HEAD`. Apply that diff here before making any other change.

After each push from this repository, sync its pushed `HEAD` tree to `/Users/kpovolotskyy/ai-stuff/ai-lab/pi/`. Commit and push the synced files in `ai-lab`, and include the source `HEAD` hash in the commit message.

Exclude `AGENTS.md` from the sync. Never touch `/Users/kpovolotskyy/ai-stuff/ai-lab/pi/AGENTS.md`: do not copy over it, do not edit it, do not delete it.

## Pi libraries

Before starting work, after applying the `ai-lab` diff, move every package's Pi libraries (`@earendil-works/*` and `typebox`) to the latest published Pi release:

1. Read the targets: `npm view @earendil-works/pi-coding-agent version`, and the `typebox` version in that release's `dependencies`.
2. In each folder with a `package-lock.json`, run `npm install --save-dev --save-exact <name>@<version>` for libraries pinned to an exact version, and `npm update <names>` for `*` ranges, which leaves `package.json` unchanged.
3. Run the `check`/`build` and `test` scripts of every package whose lockfile changed, and fix what breaks before starting the task. Skip live tests that spend model credits or need a remote host.
4. Record the update under `### General` in the changelog.
