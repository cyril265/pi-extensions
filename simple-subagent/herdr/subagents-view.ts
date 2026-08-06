import { execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  getHerdrRecordPath,
  type HerdrSubagentRecord,
  pruneHerdrRecords,
  readHerdrRecords,
} from '../extensions/herdr-state.ts'

type Filter = 'all' | 'active' | 'unseen'
type PaneStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
type ViewAgent = HerdrSubagentRecord & { paneStatus: PaneStatus }
type ClickTarget = {
  rowStart: number
  rowEnd: number
  columnStart: number
  columnEnd: number
  action: () => void
}

const herdrPath = process.env.HERDR_BIN_PATH
if (!herdrPath) throw new Error('HERDR_BIN_PATH is required')
const herdr: string = herdrPath
if (!(process.stdin.isTTY && process.stdout.isTTY)) {
  throw new Error('The Subagents view requires a terminal')
}

let filter: Filter = 'all'
let selected = 0
let selectedId: string | undefined
let agents: ViewAgent[] = []
let clickTargets: ClickTarget[] = []
let closed = false
let refreshing = false
let message: string | undefined
let messageTimer: NodeJS.Timeout | undefined
let renderedLines: string[] = []
let renderedSize = ''
const execFileAsync = promisify(execFile)

const reset = '\x1b[0m'
const dim = '\x1b[2m'
const bold = '\x1b[1m'
const blue = '\x1b[34m'
const green = '\x1b[32m'
const yellow = '\x1b[33m'
const red = '\x1b[31m'
const inverse = '\x1b[7m'
const terminalEscape = String.fromCharCode(27)

async function runHerdr(args: string[]): Promise<string> {
  try {
    const result = await execFileAsync(herdr, args, { encoding: 'utf8' })
    return result.stdout
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    throw new Error(failure.stderr?.trim() || failure.stdout?.trim() || failure.message)
  }
}

async function loadAgents(): Promise<ViewAgent[]> {
  const response = JSON.parse(await runHerdr(['pane', 'list'])) as {
    // biome-ignore lint/style/useNamingConvention: Herdr's JSON response uses snake_case.
    result: { panes: Array<{ pane_id: string; agent_status: PaneStatus }> }
  }
  const panes = new Map(response.result.panes.map(pane => [pane.pane_id, pane.agent_status]))
  pruneHerdrRecords(new Set(panes.keys()))
  const workspaceId = process.env.HERDR_WORKSPACE_ID
  const records = readHerdrRecords().filter(
    record => panes.has(record.paneId) && (!workspaceId || record.workspaceId === workspaceId),
  )
  const latestParentLabels = new Map<string, { label: string; createdAt: string }>()
  for (const record of records) {
    const current = latestParentLabels.get(record.parentSessionId)
    if (!current || record.createdAt > current.createdAt) {
      latestParentLabels.set(record.parentSessionId, {
        label: record.parentLabel,
        createdAt: record.createdAt,
      })
    }
  }
  const viewAgents = records.map(record => ({
    ...record,
    parentLabel: latestParentLabels.get(record.parentSessionId)?.label || record.parentLabel,
    paneStatus: panes.get(record.paneId) as PaneStatus,
  }))
  const groups = new Map<string, { active: boolean; lastActivity: string }>()
  for (const agent of viewAgents) {
    const group = groups.get(agent.parentSessionId) || { active: false, lastActivity: '' }
    if (agent.paneStatus === 'working' || agent.paneStatus === 'blocked') group.active = true
    const activity = agent.updatedAt
    if (activity > group.lastActivity) group.lastActivity = activity
    groups.set(agent.parentSessionId, group)
  }
  return viewAgents.sort((left, right) => {
    const leftGroup = groups.get(left.parentSessionId) as { active: boolean; lastActivity: string }
    const rightGroup = groups.get(right.parentSessionId) as {
      active: boolean
      lastActivity: string
    }
    if (leftGroup.active !== rightGroup.active) return leftGroup.active ? -1 : 1
    if (leftGroup.lastActivity !== rightGroup.lastActivity) {
      return rightGroup.lastActivity.localeCompare(leftGroup.lastActivity)
    }
    const parentIdentity = left.parentSessionId.localeCompare(right.parentSessionId)
    if (parentIdentity !== 0) return parentIdentity
    return left.createdAt.localeCompare(right.createdAt)
  })
}

function isActive(agent: ViewAgent): boolean {
  return agent.paneStatus === 'working' || agent.paneStatus === 'blocked'
}

function isDone(agent: ViewAgent): boolean {
  return agent.paneStatus === 'done' || agent.status === 'done'
}

function isUnseen(agent: ViewAgent): boolean {
  return isDone(agent) && !agent.viewedAt
}

function isFinished(agent: ViewAgent): boolean {
  return isDone(agent) || agent.status === 'failed' || agent.status === 'interrupted'
}

function filteredAgents(): ViewAgent[] {
  if (filter === 'active') return agents.filter(isActive)
  if (filter === 'unseen') return agents.filter(isUnseen)
  return agents
}

function statusText(agent: ViewAgent): { icon: string; label: string; color: string } {
  if (agent.status === 'failed') return { icon: '×', label: 'Failed', color: red }
  if (agent.status === 'interrupted') return { icon: '■', label: 'Interrupted', color: red }
  if (agent.paneStatus === 'working') return { icon: '●', label: 'Working', color: blue }
  if (agent.paneStatus === 'blocked') return { icon: '!', label: 'Blocked', color: yellow }
  if (isDone(agent)) {
    return agent.viewedAt
      ? { icon: '○', label: 'Viewed', color: dim }
      : { icon: '✓', label: 'Done', color: green }
  }
  return { icon: '○', label: 'Idle', color: dim }
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value
  return `${value.slice(0, Math.max(0, width - 1))}…`
}

function cleanup(): void {
  if (closed) return
  closed = true
  clearInterval(refreshTimer)
  process.stdout.write(
    [
      terminalEscape,
      '[?1000l',
      terminalEscape,
      '[?1006l',
      terminalEscape,
      '[?25h',
      terminalEscape,
      '[0m',
    ].join(''),
  )
  process.stdin.setRawMode(false)
  process.stdin.pause()
}

function close(): void {
  cleanup()
  process.exit(0)
}

function showMessage(value: string): void {
  message = value
  if (messageTimer) clearTimeout(messageTimer)
  messageTimer = setTimeout(() => {
    message = undefined
    render()
  }, 2000)
  render()
}

function focusAgent(agent: ViewAgent): void {
  const helper = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./focus-subagent.ts', import.meta.url)),
      agent.paneId,
      getHerdrRecordPath(agent.id),
    ],
    {
      detached: true,
      env: process.env,
      stdio: 'ignore',
    },
  )
  helper.unref()
  close()
}

async function closeSelectedPane(): Promise<void> {
  const agent = filteredAgents()[selected]
  if (!agent) return
  if (isActive(agent)) {
    showMessage(`Cannot close ${agent.name} while it is working`)
    return
  }
  if (!isFinished(agent)) {
    showMessage('Only finished subagents can be closed')
    return
  }
  try {
    await runHerdr(['pane', 'close', agent.paneId])
  } catch {
    // The pane may already be gone; the reload below drops it either way.
  }
  try {
    fs.unlinkSync(getHerdrRecordPath(agent.id))
  } catch {
    // The record may already be pruned.
  }
  showMessage(`Closed ${agent.name}`)
  await refresh()
}

async function closeFinishedPanes(): Promise<void> {
  const finished = filteredAgents().filter(agent => isFinished(agent) && !isActive(agent))
  if (finished.length === 0) {
    showMessage('No finished subagents to close')
    return
  }
  await Promise.allSettled(
    finished.map(async agent => {
      try {
        await runHerdr(['pane', 'close', agent.paneId])
      } catch {
        // The pane may already be gone; remove its stale record below.
      }
      try {
        fs.unlinkSync(getHerdrRecordPath(agent.id))
      } catch {
        // The record may already be pruned.
      }
    }),
  )
  showMessage(`Closed ${finished.length} finished subagent${finished.length === 1 ? '' : 's'}`)
  await refresh()
}

function setFilter(next: Filter): void {
  filter = next
  selected = 0
  selectedId = undefined
  render()
}

function moveSelection(direction: 1 | -1): void {
  const visibleAgents = filteredAgents()
  selected = Math.max(0, Math.min(Math.max(0, visibleAgents.length - 1), selected + direction))
  selectedId = visibleAgents[selected]?.id
  render()
}

function render(): void {
  const visibleAgents = filteredAgents()
  if (visibleAgents.length === 0) {
    selected = 0
    selectedId = undefined
  } else {
    const index = selectedId ? visibleAgents.findIndex(agent => agent.id === selectedId) : -1
    if (index >= 0) {
      selected = index
    } else {
      selected = Math.max(0, Math.min(selected, visibleAgents.length - 1))
      selectedId = visibleAgents[selected].id
    }
  }

  const width = Math.max(1, process.stdout.columns ?? 1)
  const height = Math.max(1, process.stdout.rows ?? 1)
  clickTargets = []

  if (width < 30 || height < 10) {
    const message = 'pane too small'
    const lines: string[] = []
    const messageRow = Math.max(0, Math.floor((height - 1) / 2))
    for (let row = 0; row < height; row++) {
      if (row !== messageRow) {
        lines.push('')
        continue
      }
      const padding = Math.max(0, Math.floor((width - message.length) / 2))
      lines.push(`${' '.repeat(padding)}${truncate(message, width - padding)}`)
    }
    flushLines(lines, width, height)
    return
  }

  const contentWidth = width - 4
  const pageSize = Math.max(1, Math.floor((height - 8) / 3))
  const pageStart = Math.floor(selected / pageSize) * pageSize
  const page = visibleAgents.slice(pageStart, pageStart + pageSize)
  const allCount = agents.length
  const activeCount = agents.filter(isActive).length
  const unseenCount = agents.filter(isUnseen).length
  const lines: string[] = []

  lines.push(`${' '.repeat(Math.max(0, width - 3))}${dim}×${reset}`)
  clickTargets.push({
    rowStart: 1,
    rowEnd: 1,
    columnStart: width - 2,
    columnEnd: width,
    action: close,
  })

  const tabs = [
    { id: 'all' as const, label: `All ${allCount}` },
    { id: 'active' as const, label: `Active ${activeCount}` },
    { id: 'unseen' as const, label: `Unseen ${unseenCount}` },
  ]
  let tabLine = '  '
  let tabColumn = 3
  for (const tab of tabs) {
    tabLine += filter === tab.id ? `${bold}[${tab.label}]${reset}` : ` ${tab.label} `
    const tabWidth = tab.label.length + 2
    clickTargets.push({
      rowStart: 3,
      rowEnd: 3,
      columnStart: tabColumn,
      columnEnd: tabColumn + tabWidth - 1,
      action: () => setFilter(tab.id),
    })
    tabLine += '  '
    tabColumn += tabWidth + 2
  }
  lines.push('')
  lines.push(tabLine)
  lines.push(`${dim}${'─'.repeat(width)}${reset}`)

  if (page.length === 0) {
    lines.push('')
    if (agents.length === 0) {
      lines.push(
        `${dim}  ${truncate('No subagents yet. Agents appear here when Pi runs runSubAgents from a pane in this workspace.', contentWidth)}${reset}`,
      )
    } else {
      lines.push(`${dim}  No subagents in this view.${reset}`)
    }
  } else {
    let previousParentId = ''
    for (const [pageIndex, agent] of page.entries()) {
      if (agent.parentSessionId !== previousParentId) {
        const group = visibleAgents.filter(item => item.parentSessionId === agent.parentSessionId)
        const groupActive = group.filter(isActive).length
        const summary = [
          groupActive > 0 ? `${groupActive} active` : '',
          group.length - groupActive > 0 ? `${group.length - groupActive} done` : '',
        ]
          .filter(Boolean)
          .join(' · ')
        lines.push(
          `${bold}${yellow}  ${truncate(summary ? `${agent.parentLabel} (${summary})` : agent.parentLabel, contentWidth)}${reset}`,
        )
        previousParentId = agent.parentSessionId
      }
      const absoluteIndex = pageStart + pageIndex
      const status = statusText(agent)
      const age = relativeTime(agent.completedAt || agent.createdAt)
      const statusWidth = 13
      const nameWidth = Math.max(1, contentWidth - statusWidth - age.length - 5)
      const plain = `  ${status.icon} ${truncate(agent.name, nameWidth).padEnd(nameWidth)} ${status.label.padEnd(statusWidth)} ${age}`
      const rowStart = lines.length + 1
      lines.push(
        absoluteIndex === selected
          ? `${inverse}${plain.padEnd(width)}${reset}`
          : `  ${status.color}${status.icon}${reset} ${truncate(agent.name, nameWidth).padEnd(nameWidth)} ${status.color}${status.label.padEnd(statusWidth)}${reset} ${dim}${age}${reset}`,
      )
      const prompt = agent.prompt.trim().replace(/\s+/g, ' ')
      lines.push(`${dim}    ${truncate(prompt || agent.cwd, contentWidth - 4)}${reset}`)
      clickTargets.push({
        rowStart,
        rowEnd: rowStart + 1,
        columnStart: 1,
        columnEnd: width,
        action: () => focusAgent(agent),
      })
    }
  }

  while (lines.length < height - 3) lines.push('')
  lines.push(message ? `${yellow}  ${truncate(message, contentWidth)}${reset}` : '')
  lines.push(
    `${dim}  ${truncate('↑/↓/j/k select   Enter open   Tab filter   x close   X close all finished   Esc/q close', contentWidth)}${reset}`,
  )
  while (lines.length < height) lines.push('')
  flushLines(lines, width, height)
}

// Emits only the rows that changed since the last frame, in a single write. Rows
// are addressed absolutely instead of walked with `\n` so unchanged ones can be
// skipped, and each still ends with `\x1b[K` so emptied rows are cleared.
function flushLines(lines: string[], width: number, height: number): void {
  const size = `${width}x${height}`
  if (size !== renderedSize) {
    renderedLines = []
    renderedSize = size
  }

  const frame = Array.from({ length: height }, (_unused, row) => lines[row] ?? '')
  let output = ''
  for (const [row, line] of frame.entries()) {
    if (line === renderedLines[row]) continue
    output += `\x1b[${row + 1};1H${line}\x1b[K`
  }
  renderedLines = frame

  if (output) process.stdout.write(output)
}

async function refresh(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    agents = await loadAgents()
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error))
  } finally {
    refreshing = false
    render()
  }
}

function cycleFilter(direction: 1 | -1): void {
  const filters: Filter[] = ['all', 'active', 'unseen']
  const index = filters.indexOf(filter)
  setFilter(filters[(index + direction + filters.length) % filters.length])
}

function handleMouse(button: number, column: number, row: number, released: boolean): void {
  if (button === 64) {
    moveSelection(-1)
    return
  }
  if (button === 65) {
    moveSelection(1)
    return
  }
  if (released || (button & 32) !== 0 || (button & 3) !== 0) return
  const target = clickTargets.find(
    item =>
      row >= item.rowStart &&
      row <= item.rowEnd &&
      column >= item.columnStart &&
      column <= item.columnEnd,
  )
  target?.action()
}

function handleKey(key: string): void {
  if (key === '\x1b' || key === 'q' || key === '\x03') {
    close()
    return
  }
  if (key === '\r' || key === '\n') {
    const agent = filteredAgents()[selected]
    if (agent) focusAgent(agent)
    return
  }
  if (key === '\x1b[A' || key === 'k') {
    moveSelection(-1)
    return
  }
  if (key === '\x1b[B' || key === 'j') {
    moveSelection(1)
    return
  }
  if (key === 'x') {
    void closeSelectedPane()
    render()
    return
  }
  if (key === 'X') {
    void closeFinishedPanes()
    render()
    return
  }
  if (key === '\t') {
    cycleFilter(1)
    return
  }
  if (key === '\x1b[Z') {
    cycleFilter(-1)
    return
  }
  render()
}

function handleInput(chunk: Buffer): void {
  const input = chunk.toString('utf8')
  const mousePattern = new RegExp(`${terminalEscape}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, 'g')
  for (const match of input.matchAll(mousePattern)) {
    handleMouse(Number(match[1]), Number(match[2]), Number(match[3]), match[4] === 'm')
  }
  const keys = input.replace(mousePattern, '')
  let index = 0
  while (index < keys.length) {
    const rest = keys.slice(index)
    const sequence = ['\x1b[A', '\x1b[B', '\x1b[Z'].find(candidate => rest.startsWith(candidate))
    if (sequence) {
      handleKey(sequence)
      index += sequence.length
      continue
    }
    if (rest[0] === terminalEscape && rest.length > 1) {
      // Unknown escape sequence; skip the escape byte and keep parsing.
      index += 1
      continue
    }
    handleKey(rest[0])
    index += 1
  }
}

process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on('data', handleInput)
process.on('SIGINT', close)
process.on('SIGTERM', close)
process.on('uncaughtException', error => {
  cleanup()
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exit(1)
})

process.stdout.write(
  [terminalEscape, '[?25l', terminalEscape, '[?1000h', terminalEscape, '[?1006h'].join(''),
)
const refreshTimer = setInterval(() => void refresh(), 1000)
render()
void refresh()
