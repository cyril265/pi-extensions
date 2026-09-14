# pi-audit

Audits Pi packages before install/update, then installs approved local snapshots.

- `pi-audit install <source> [-l|--local]` — audit source, then choose yes, no, or ask; ask opens a read-only Pi session for follow-up questions before returning to the decision prompt. Approved snapshots install globally or into the project with `--local`.
  - Example: `pi-audit install npm:@scope/pi-package`
  - Example: `pi-audit install git:github.com/user/pi-package --local`
- `pi-audit update [package]` — update matching managed package by package name, original source, or audited snapshot path; with no package, checks all managed packages, audits available updates first, saves `<project>/.pi/audit-runs/<timestamp>.json`, then prompts for each.
  - Example: `pi-audit update @scope/pi-package`
  - Example: `pi-audit update audited-packages/npm/pi-package`
  - Example: `pi-audit update`
- `pi-audit update-all` — check every unpinned managed package, audit all newer sources first, save `<project>/.pi/audit-runs/<timestamp>.json`, then prompt for each available update.
- Run reports always go to the `.pi/audit-runs/` directory of the current project, also for global installs. `<timestamp>` is the ISO generation time with `:` and `.` replaced by `-`.
- Install, update, and migrate decisions accept `[y]es`, `[n]o`, or `[a]sk`. Follow-up sessions are ephemeral and can only read, search, and list files.
- Update audit reports record immutable npm versions or git commits so reviewed candidates can be reproduced later.
- npm and git snapshots install dependencies with lifecycle scripts ignored; if the audited package declares `scripts.postinstall`, `pi-audit` shows the command and asks whether to run it.
- `pi-audit migrate` — convert existing npm/git Pi packages into audited local snapshots.

## Install

`pi-audit` is a CLI, not a Pi package. Link it into your `PATH` from this directory:

```sh
npm link
```

Audit runs and `ask` follow-up sessions call `pi --provider openai-codex --model gpt-5.6-sol --thinking medium`.
