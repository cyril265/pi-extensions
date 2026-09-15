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
