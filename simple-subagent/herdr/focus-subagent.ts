import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { updateHerdrRecord } from '../extensions/herdr-state.ts'

const herdr = process.env.HERDR_BIN_PATH
if (!herdr) throw new Error('HERDR_BIN_PATH is required')

const paneId = process.argv[2]
if (!paneId) throw new Error('Pane ID is required')
const recordPath = process.argv[3]

// The overlay that spawned this helper is still closing; retry until Herdr accepts the focus.
let focused = false
for (let attempt = 0; attempt < 10 && !focused; attempt++) {
  try {
    execFileSync(herdr, ['agent', 'focus', paneId], { stdio: 'ignore' })
    focused = true
  } catch {
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}

if (focused) {
  if (recordPath && fs.existsSync(recordPath)) {
    updateHerdrRecord(recordPath, { viewedAt: new Date().toISOString() })
  }
} else {
  process.exit(1)
}
