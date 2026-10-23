import { spawnSync } from 'node:child_process'

const result = spawnSync(
  process.env.HERDR_BIN_PATH || 'herdr',
  [
    'plugin',
    'pane',
    'open',
    '--plugin',
    process.env.HERDR_PLUGIN_ID || 'local.herdr-settle',
    '--entrypoint',
    'shelf',
  ],
  { stdio: 'inherit', windowsHide: true },
)
process.exit(result.status ?? 1)
