import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { open } from 'glimpseui'
import { buildReviewHtml } from '../src/ui.ts'
import type { ReviewFile, ReviewFileContents, ReviewWindowData } from '../src/types.ts'

// Opens the real review window with a three-file diff (modified, added, deleted).
// Usage: node test/harness.mts            -> interactive, closes on submit/cancel
//        node test/harness.mts test/smoke.js -> runs the script inside the page and asserts the submit payload

const files: ReviewFile[] = [
  { id: 'f1', path: 'web/app.js', comparison: { status: 'modified', oldPath: 'web/app.js', newPath: 'web/app.js', displayPath: 'web/app.js', hasOriginal: true, hasModified: true } },
  { id: 'f2', path: 'src/new.ts', comparison: { status: 'added', oldPath: null, newPath: 'src/new.ts', displayPath: 'src/new.ts', hasOriginal: false, hasModified: true } },
  { id: 'f3', path: 'src/gone.ts', comparison: { status: 'deleted', oldPath: 'src/gone.ts', newPath: null, displayPath: 'src/gone.ts', hasOriginal: true, hasModified: false } },
  { id: 'f4', path: 'src/broken.zig', comparison: { status: 'modified', oldPath: 'src/broken.zig', newPath: 'src/broken.zig', displayPath: 'src/broken.zig', hasOriginal: true, hasModified: true } },
]
const contents: Record<string, ReviewFileContents> = {
  f1: { originalContent: execFileSync('git', ['show', 'HEAD:./web/app.js'], { encoding: 'utf8' }), modifiedContent: readFileSync('web/app.js', 'utf8') },
  f2: { originalContent: '', modifiedContent: 'export const a = 1\nexport const b = 2\nexport const c = 3\nexport const d = 4\n' },
  f3: { originalContent: 'export function gone() {\n  return 1\n}\n', modifiedContent: '' },
}
const data: ReviewWindowData = {
  title: 'Harness review',
  repoRoot: process.cwd(),
  mode: 'last-turn',
  scopeLabel: 'Last turn',
  scopeHint: 'Hover a line number and click + to comment.',
  theme: { appearance: 'dark', bg: '#0b1020', panel: '#111827', hover: '#1f2937', active: '#243044', badge: '#1e293b', border: '#263244', text: '#e5e7eb', strong: '#f8fafc', muted: '#9ca3af', dim: '#6b7280', accent: '#60a5fa', success: '#34d399', error: '#fb7185', warning: '#fbbf24', diffAdded: '#22c55e', diffRemoved: '#ef4444' },
  files,
}

const script = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : null
const win = open(buildReviewHtml(data), { width: 1600, height: 1000, title: 'harness' })

win.on('message', (message: any) => {
  if (message.type === 'log') {
    console.log(message.text)
    return
  }
  if (message.type === 'request-file' && message.fileId === 'f4') {
    win.send(`window.__reviewReceive(${JSON.stringify({ type: 'file-error', requestId: message.requestId, fileId: 'f4', scope: 'review', message: 'git show failed: exit code 128' })})`)
    return
  }
  if (message.type === 'request-file') {
    const reply = { type: 'file-data', requestId: message.requestId, fileId: message.fileId, scope: 'review', ...contents[message.fileId] }
    win.send(`window.__reviewReceive(${JSON.stringify(reply)})`)
    return
  }
  console.log(JSON.stringify(message, null, 2))
  if (message.type === 'submit' && script != null) {
    const summary = message.comments.map((c: any) => `${c.fileId} ${c.side} ${c.startLine}-${c.endLine}`).join(', ')
    const expected = 'f2 modified 2-3, f3 original 2-2, f3 file null-null'
    console.log(summary === expected ? 'PASS' : `FAIL\n  expected: ${expected}\n  actual:   ${summary}`)
    process.exit(summary === expected ? 0 : 1)
  }
  if (message.type === 'submit' || message.type === 'cancel' || message.type === 'undo' || message.type === 'renderer-error') process.exit(0)
})
win.on('closed', () => process.exit(0))

if (script != null) {
  setTimeout(() => win.send(`(async () => { const log = text => window.glimpse.send({ type: 'log', text: String(text) }); try { ${script} } catch (e) { log('SCRIPT ERROR ' + e.message + '\\n' + e.stack) } })()`), 4000)
  setTimeout(() => { console.log('FAIL: timeout'); process.exit(1) }, 30000)
}
