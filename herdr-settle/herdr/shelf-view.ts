import os from 'node:os'
import { emitKeypressEvents, type Interface } from 'node:readline'
import { appendShelf, logged, reopenTab, type SettledTab, settledTabs } from '../settle.ts'

interface Keypress {
  name?: string
  ctrl?: boolean
}

if (!(process.stdin.isTTY && process.stdout.isTTY)) {
  throw new Error('The settled tabs view requires an interactive terminal')
}

const REASONS: Record<SettledTab['reason'], string> = {
  inactive: 'idle 7d+',
  'mr-merged': 'MR merged',
  'mr-closed': 'MR closed',
  manual: 'settled by hand',
}

let tabs: SettledTab[] = []
let selected = 0
let message = ''
let busy = false
let closed = false
let signature = ''
let renderedMinute = -1

emitKeypressEvents(process.stdin, { escapeCodeTimeout: 50 } as unknown as Interface)
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.write('\u001b[?1049h\u001b[?25l')

refresh(true)
const refreshTimer = setInterval(() => refresh(false), 2000)
process.stdin.on('keypress', onKeypress)
process.stdout.on('resize', render)
process.on('SIGINT', () => close(130))
process.on('SIGTERM', () => close(143))

function refresh(force: boolean): void {
  const selectedId = tabs[selected]?.id
  const next = settledTabs()
  const nextSignature = next.map(tab => tab.id).join('|')
  if (!force && nextSignature === signature && Math.floor(Date.now() / 60_000) === renderedMinute)
    return
  tabs = next
  signature = nextSignature
  const index = selectedId ? tabs.findIndex(tab => tab.id === selectedId) : -1
  selected = Math.max(0, Math.min(index === -1 ? selected : index, tabs.length - 1))
  render()
}

function onKeypress(_text: string, key: Keypress): void {
  if (key.ctrl && key.name === 'c') {
    close(0)
    return
  }
  if (busy) return
  switch (key.name) {
    case 'escape':
    case 'q':
      close(0)
      break
    case 'up':
    case 'k':
      selected = Math.max(0, selected - 1)
      message = ''
      render()
      break
    case 'down':
    case 'j':
      selected = Math.min(tabs.length - 1, selected + 1)
      message = ''
      render()
      break
    case 'return':
      void reopenSelected()
      break
    case 'd':
    case 'x':
      removeSelected()
      break
  }
}

async function reopenSelected(): Promise<void> {
  const tab = tabs[selected]
  if (!tab) return
  busy = true
  message = `Reopening ${tab.label}…`
  render()
  try {
    await logged({ op: 'reopen', tabId: tab.tabId, shelfId: tab.id, cwd: tab.cwd }, async entry => {
      await reopenTab(tab)
      entry.outcome = 'reopened'
    })
    close(0)
  } catch (error) {
    busy = false
    message = error instanceof Error ? error.message : String(error)
    refresh(true)
  }
}

function removeSelected(): void {
  const tab = tabs[selected]
  if (!tab) return
  appendShelf({ type: 'removed', id: tab.id, at: new Date().toISOString() })
  message = `Removed ${tab.label}`
  refresh(true)
}

function render(): void {
  if (closed) return
  const width = process.stdout.columns
  const height = process.stdout.rows
  renderedMinute = Math.floor(Date.now() / 60_000)
  const rows: string[] = []
  rows.push('')
  rows.push(`\u001b[1m  Settled tabs (${tabs.length})\u001b[0m`)
  rows.push(`\u001b[2m${'─'.repeat(Math.max(0, width - 1))}\u001b[0m`)

  const listHeight = Math.max(1, height - rows.length - 3)
  const visible = Math.max(1, Math.floor(listHeight / 2))
  const start = Math.max(
    0,
    Math.min(Math.max(0, tabs.length - visible), selected - Math.floor(visible / 2)),
  )
  if (tabs.length === 0) rows.push('\u001b[2m  Nothing settled yet.\u001b[0m')
  for (const [offset, tab] of tabs.slice(start, start + visible).entries()) {
    const isSelected = start + offset === selected
    const marker = isSelected ? '>' : ' '
    const style = isSelected ? '\u001b[1;36m' : '\u001b[1m'
    rows.push(`${style}${columns(`${marker} ${tab.label}`, age(tab.at), width - 2)}\u001b[0m`)
    const sessions = tab.sessions.length === 1 ? '1 session' : `${tab.sessions.length} sessions`
    rows.push(
      `\u001b[2m${truncate(`    ${REASONS[tab.reason]} · ${home(tab.cwd)} · ${sessions}`, width - 1)}\u001b[0m`,
    )
  }

  while (rows.length < height - 2) rows.push('')
  rows.push(
    message
      ? `\u001b[33m${truncate(message, width - 1)}\u001b[0m`
      : '\u001b[2m  ↑↓ move  Enter reopen  d remove  q close\u001b[0m',
  )
  process.stdout.write(
    `\u001b[H${rows
      .slice(0, height)
      .map(row => `${row}\u001b[K`)
      .join('\r\n')}\u001b[J`,
  )
}

function columns(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - Array.from(left).length - right.length)
  return truncate(`${left}${' '.repeat(gap)}${right}`, width)
}

function truncate(value: string, max: number): string {
  const characters = Array.from(value)
  return characters.length <= max ? value : `${characters.slice(0, Math.max(0, max - 1)).join('')}…`
}

function home(value: string): string {
  const dir = os.homedir()
  return value.startsWith(dir) ? `~${value.slice(dir.length)}` : value
}

function age(at: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

function close(code: number): void {
  if (closed) return
  closed = true
  clearInterval(refreshTimer)
  process.stdin.setRawMode(false)
  process.stdin.pause()
  process.stdout.write('\u001b[?25h\u001b[?1049l')
  process.exit(code)
}
