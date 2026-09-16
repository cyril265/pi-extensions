# pi-audit

Audits Pi packages before install/update, then installs approved local snapshots.

- `pi-audit install <source> [-l|--local]` — audit source, then choose yes, no, or ask; ask opens a read-only Pi session for follow-up questions before returning to the decision prompt. Approved snapshots install globally or into the project with `--local`.
  - Example: `pi-audit install npm:@scope/pi-package`
  - Example: `pi-audit install git:github.com/user/pi-package --local`
- `pi-audit update [package]` — update matching managed package by package name, original source, or audited snapshot path; with no package, checks all managed packages, audits available updates first, saves `<agent-dir>/audit-runs/<timestamp>.json`, then prompts for each. Update audits get the previous audit result and a unified diff from the installed snapshot to the candidate.
  - Example: `pi-audit update @scope/pi-package`
  - Example: `pi-audit update audited-packages/npm/pi-package`
  - Example: `pi-audit update`
- `pi-audit update-all` — same as `pi-audit update` without a package.
- Run reports go to `<agent-dir>/audit-runs/` (`~/.pi/agent/audit-runs/` unless `PI_CODING_AGENT_DIR` is set). `<timestamp>` is the ISO generation time with `:` and `.` replaced by `-`. Each report lists every audited or failed update with the current manifest, the candidate revision (`version` or `gitHead` plus `pinnedSource`), and the audit result or failure stage.
- Install, update, and migrate decisions accept `[y]es`, `[n]o`, or `[a]sk`. Follow-up sessions are ephemeral and can only read, search, and list files.
- Snapshot manifests (`.pi-audit.json`) record the npm version or git commit and a `pinnedSource` so reviewed candidates can be reproduced later.
- Packages with a `package.json` get their production dependencies installed (lifecycle scripts ignored) before the audit, so the model can follow imports into `node_modules`, and `npm audit` advisories are handed to the model as evidence. The generated `package-lock.json` is stored with the snapshot and the post-approval `npm ci` installs exactly the audited versions. If the audited package declares `scripts.postinstall`, `pi-audit` shows the command and asks whether to run it.
- `pi-audit migrate` — convert existing npm/git Pi packages into audited local snapshots and remove the original install from `<agent-dir>/npm`, `<agent-dir>/git`, or the project `.pi/` equivalents.

## Install

`pi-audit` is a CLI, not a Pi package. Link it into your `PATH` from this directory:

```sh
npm link
```

Audit runs and `ask` follow-up sessions call `pi --provider openai-codex --model gpt-5.6-sol --thinking medium`.

## Tests

`npm test` runs end-to-end against a temp project and a temp `PI_CODING_AGENT_DIR` that symlinks your `auth.json` and `models.json`. It installs a local fixture, `npm:pi-simplify`, and `npm:pi-context-view`, and runs five real pi audits (about three minutes).
