import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const INACTIVE_DAYS = 7
export const INACTIVE_MS = INACTIVE_DAYS * 24 * 60 * 60 * 1000
export const SUBAGENT_IDLE_MS = 14 * 60 * 60 * 1000
const DUPLICATE_SETTLE_MS = 10 * 60 * 1000
const LOG_MAX_BYTES = 10 * 1024 * 1024
const LOG_TEXT_MAX = 2000
const LOG_LOCK_STALE_MS = 60_000
const GLAB_TIMEOUT_MS = 30_000
const GLAB_LOCK_STALE_MS = 2 * GLAB_TIMEOUT_MS
const GLAB_LOCK_WAIT_MS = 5 * 60_000
const GLAB_RETRY_DELAY_MS = 2000

export type SettleReason = 'inactive' | 'mr-merged' | 'mr-closed' | 'manual'

export interface ShelfSession {
  file: string
  cwd: string
}

export interface MergeRequest {
  url: string
  state: 'merged' | 'closed'
  at: string
}

export interface SettledTab {
  id: string
  at: string
  reason: SettleReason
  agentDir: string
  tabId: string
  label: string
  workspaceId: string
  workspaceLabel?: string
  cwd: string
  sessions: ShelfSession[]
  mr?: MergeRequest
}

export type ShelfEvent =
  | ({ type: 'settled' } & SettledTab)
  | { type: 'reopened'; id: string; at: string; files: string[] }
  | { type: 'removed'; id: string; at: string }
  | {
      type: 'skipped'
      at: string
      tabId: string
      session: string | null
      reason: SettleReason
      blockers: string[]
    }

export interface PaneInfo {
  pane_id: string
  tab_id: string
  workspace_id: string
  agent?: string
  agent_status?: string
  agent_session?: { kind?: string; value?: string }
  cwd?: string
  focused?: boolean
  tokens?: Record<string, string>
}

export interface TabInfo {
  tab_id: string
  label: string
  focused: boolean
  workspace_id: string
}

interface ProcessInfo {
  foreground_process_group_id?: number
  shell_pid?: number
  foreground_processes?: Array<{ name?: string; argv0?: string }>
}

export interface TabInspection {
  tab: TabInfo
  cwd: string
  sessions: ShelfSession[]
  blockers: string[]
}

export function defaultAgentDir(): string {
  return path.join(os.homedir(), '.pi', 'agent')
}

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || defaultAgentDir()
}

export function shelfFile(dir = agentDir()): string {
  return path.join(dir, 'herdr-settle', 'shelf.jsonl')
}

export function appendShelf(event: ShelfEvent, dir = agentDir()): void {
  const file = shelfFile(dir)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 })
}

export interface CommandRecord {
  argv: string[]
  t: number
  ms: number
  code: number
  signal?: string
  output?: string
}

export type LogOutcome =
  | 'busy'
  | 'stale'
  | 'changed'
  | 'kept'
  | 'skipped'
  | 'settled'
  | 'reopened'
  | 'failed'
  | 'interrupted'

export interface LogFields {
  op: 'check' | 'settle-action' | 'reopen'
  outcome?: LogOutcome
  session?: string | null
  cwd?: string
  tabId?: string
  reason?: SettleReason
  mergeRequest?: { open: boolean; terminal: MergeRequest | null } | null
  lookupError?: string
  closedSubagents?: string[]
  subagentError?: string
  blockers?: string[]
  shelfId?: string
  error?: string
}

export type LogEntry = { at: string; ms: number; pid: number } & LogFields & {
    commands: CommandRecord[]
  }

interface Trace {
  started: number
  entry: LogFields
  commands: CommandRecord[]
  dir: string
  flushed: boolean
}

const traces = new AsyncLocalStorage<Trace>()

export function logFile(dir = agentDir()): string {
  return path.join(dir, 'herdr-settle', 'log.jsonl')
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function scrub(text: string): string {
  const redacted = text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
  if (redacted.length <= LOG_TEXT_MAX) return redacted
  return `${redacted.slice(0, LOG_TEXT_MAX)}…[+${redacted.length - LOG_TEXT_MAX} chars]`
}

function rotateLog(file: string): void {
  const lock = `${file}.rotate.lock`
  try {
    if (statSync(file).size < LOG_MAX_BYTES) return
    mkdirSync(lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOG_LOCK_STALE_MS) rmdirSync(lock)
    } catch {}
    return
  }
  try {
    if (statSync(file).size >= LOG_MAX_BYTES) {
      renameSync(file, path.join(path.dirname(file), 'log.old.jsonl'))
    }
  } catch {}
  try {
    rmdirSync(lock)
  } catch {}
}

function writeLog(trace: Trace): void {
  const entry: LogEntry = {
    at: new Date(trace.started).toISOString(),
    ms: Date.now() - trace.started,
    pid: process.pid,
    ...trace.entry,
    commands: [...trace.commands].sort((a, b) => a.t - b.t),
  }
  const line = JSON.stringify(entry, (_key, value) =>
    typeof value === 'string' ? scrub(value) : value,
  )
  const file = logFile(trace.dir)
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    rotateLog(file)
    appendFileSync(file, `${line}\n`, { mode: 0o600 })
  } catch {}
}

export async function logged(
  fields: LogFields,
  body: (entry: LogFields) => Promise<void>,
  dir = agentDir(),
): Promise<void> {
  const trace: Trace = {
    started: Date.now(),
    entry: { ...fields },
    commands: [],
    dir,
    flushed: false,
  }
  const onExit = () => {
    if (trace.flushed) return
    trace.entry.outcome = 'interrupted'
    writeLog(trace)
  }
  process.once('exit', onExit)
  try {
    await traces.run(trace, () => body(trace.entry))
  } catch (error) {
    trace.entry.outcome = 'failed'
    trace.entry.error = errorMessage(error)
    throw error
  } finally {
    process.off('exit', onExit)
    if (!trace.flushed || trace.entry.outcome === 'failed') writeLog(trace)
  }
}

function flushLog(fields: Partial<LogFields>): void {
  const trace = traces.getStore()
  if (!trace) return
  Object.assign(trace.entry, fields)
  writeLog(trace)
  trace.flushed = true
}

export function readShelf(dir = agentDir()): ShelfEvent[] {
  let text: string
  try {
    text = readFileSync(shelfFile(dir), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const events: ShelfEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as ShelfEvent)
    } catch {}
  }
  return events
}

export function settledTabs(events: ShelfEvent[] = readShelf()): SettledTab[] {
  const shelved = new Map<string, SettledTab>()
  const settledAt = new Map<string, number>()
  for (const event of events) {
    if (event.type === 'settled') {
      const previous = settledAt.get(event.tabId)
      settledAt.set(event.tabId, Date.parse(event.at))
      if (previous !== undefined && Date.parse(event.at) - previous < DUPLICATE_SETTLE_MS) continue
      const { type: _type, ...tab } = event
      shelved.set(event.id, tab)
    } else if (event.type === 'removed') {
      shelved.delete(event.id)
    } else if (event.type === 'reopened') {
      const tab = shelved.get(event.id)
      if (!tab) continue
      const remaining = tab.sessions.filter(session => !event.files.includes(session.file))
      if (remaining.length === 0) shelved.delete(event.id)
      else shelved.set(event.id, { ...tab, sessions: remaining })
    }
  }
  return [...shelved.values()].reverse()
}

export function lastReopenedAt(file: string, events: ShelfEvent[] = readShelf()): string | null {
  let latest: string | null = null
  for (const event of events) {
    if (event.type !== 'reopened' || !event.files.includes(file)) continue
    if (latest === null || Date.parse(event.at) > Date.parse(latest)) latest = event.at
  }
  return latest
}

export function latestTimestamp(values: Array<string | null | undefined>): string | null {
  let latest: string | null = null
  for (const value of values) {
    if (!value || Number.isNaN(Date.parse(value))) continue
    if (latest === null || Date.parse(value) > Date.parse(latest)) latest = value
  }
  return latest
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export function run(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
): Promise<RunResult> {
  const trace = traces.getStore()
  const started = Date.now()
  return new Promise(resolve => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout ?? 20_000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        const errorText = stderr || (error?.message ?? '')
        if (trace) {
          const output = code === 0 ? '' : errorText.trim() || (stdout ?? '').trim()
          trace.commands.push({
            argv: [command, ...args],
            t: started - trace.started,
            ms: Date.now() - started,
            code,
            ...(error?.signal ? { signal: error.signal } : {}),
            ...(output ? { output } : {}),
          })
        }
        resolve({ code, stdout: stdout ?? '', stderr: errorText })
      },
    )
  })
}

function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || 'herdr'
}

export async function herdr<T>(args: string[], timeout = 15_000): Promise<T> {
  const result = await run(herdrBin(), args, { timeout })
  const output = result.stdout.trim() || result.stderr.trim()
  let parsed: { result?: T; error?: { code?: string; message?: string } }
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error(output || `herdr ${args.slice(0, 2).join(' ')} exited ${result.code}`)
  }
  if (parsed.error) {
    throw Object.assign(
      new Error(parsed.error.message || parsed.error.code || 'herdr rejected the request'),
      { herdrCode: parsed.error.code },
    )
  }
  if (parsed.result === undefined)
    throw new Error(`herdr ${args.slice(0, 2).join(' ')} returned no result`)
  return parsed.result
}

function herdrCode(error: unknown): string | undefined {
  return (error as { herdrCode?: string } | undefined)?.herdrCode
}

export async function tabExists(tabId: string): Promise<boolean> {
  try {
    await herdr(['tab', 'get', tabId])
    return true
  } catch (error) {
    if (herdrCode(error) === 'tab_not_found') return false
    throw error
  }
}

export async function currentPane(): Promise<PaneInfo> {
  return (await herdr<{ pane: PaneInfo }>(['pane', 'current', '--current'])).pane
}

function busy(status: string | undefined): boolean {
  return status === 'working' || status === 'blocked'
}

function describeAge(ms: number): string {
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m`
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function sessionFile(pane: PaneInfo): string | null {
  const session = pane.agent_session
  return session?.kind === 'path' && session.value ? session.value : null
}

async function runningCommand(paneId: string): Promise<string | null> {
  let info: ProcessInfo
  try {
    info = (await herdr<{ process_info: ProcessInfo }>(['pane', 'process-info', '--pane', paneId]))
      .process_info
  } catch {
    return 'unknown process'
  }
  if (info.shell_pid !== undefined && info.foreground_process_group_id === info.shell_pid) {
    return null
  }
  const foreground = info.foreground_processes?.[0]
  return foreground?.argv0 || foreground?.name || 'a command'
}

export async function closeIdleSubagents(now = Date.now()): Promise<string[]> {
  const { workspaces } = await herdr<{ workspaces: Array<{ workspace_id: string }> }>([
    'workspace',
    'list',
  ])
  const closed: string[] = []
  for (const workspace of workspaces) {
    const { panes } = await herdr<{ panes: PaneInfo[] }>([
      'pane',
      'list',
      '--workspace',
      workspace.workspace_id,
    ])
    for (const pane of panes) {
      if (!pane.tokens?.simple_subagent || pane.focused || busy(pane.agent_status)) continue
      const file = sessionFile(pane)
      if (!file) continue
      let modified: number
      try {
        modified = statSync(file).mtimeMs
      } catch {
        continue
      }
      if (now - modified < SUBAGENT_IDLE_MS) continue
      try {
        await herdr(['pane', 'close', pane.pane_id])
        closed.push(pane.pane_id)
      } catch (error) {
        if (herdrCode(error) !== 'pane_not_found') throw error
      }
    }
  }
  return closed
}

/**
 * strict: the automatic path. It also refuses the focused tab, non-pi agents, pi panes
 * without a known session, running commands, busy subagents anywhere in the workspace,
 * and (for inactivity) other pi sessions that were active recently.
 */
export async function inspectTab(
  tabId: string,
  options: { strict: boolean; inactivity?: boolean; selfPaneId?: string; now?: number },
): Promise<TabInspection> {
  const now = options.now ?? Date.now()
  const { tab } = await herdr<{ tab: TabInfo }>(['tab', 'get', tabId])
  const { panes } = await herdr<{ panes: PaneInfo[] }>([
    'pane',
    'list',
    '--workspace',
    tab.workspace_id,
  ])
  const blockers: string[] = []
  const sessions: ShelfSession[] = []
  if (options.strict && tab.focused) blockers.push('tab is focused')

  const tabPanes = panes.filter(pane => pane.tab_id === tabId)
  if (options.strict) {
    for (const pane of panes) {
      if (pane.tab_id !== tabId && pane.tokens?.simple_subagent && busy(pane.agent_status)) {
        blockers.push(`subagent ${pane.tokens.simple_subagent} is ${pane.agent_status}`)
      }
    }
  }

  for (const pane of tabPanes) {
    const self = pane.pane_id === options.selfPaneId
    if (pane.agent) {
      if (busy(pane.agent_status)) {
        blockers.push(`${pane.agent} in ${pane.pane_id} is ${pane.agent_status}`)
        continue
      }
      if (pane.agent !== 'pi') {
        if (options.strict) blockers.push(`${pane.agent} is open in ${pane.pane_id}`)
        continue
      }
      const file = sessionFile(pane)
      if (!file) {
        if (options.strict && !self) blockers.push(`pi in ${pane.pane_id} has no session file`)
        continue
      }
      sessions.push({ file, cwd: pane.cwd || '' })
      if (options.strict && options.inactivity && !self) {
        let modified: number
        try {
          modified = statSync(file).mtimeMs
        } catch {
          blockers.push(`pi session in ${pane.pane_id} is unreadable`)
          continue
        }
        if (now - modified < INACTIVE_MS) {
          blockers.push(`pi in ${pane.pane_id} was active ${describeAge(now - modified)} ago`)
        }
      }
      continue
    }
    if (!options.strict) continue
    const command = await runningCommand(pane.pane_id)
    if (command) blockers.push(`${command} is running in ${pane.pane_id}`)
  }

  const cwd = sessions[0]?.cwd || tabPanes[0]?.cwd || ''
  return { tab, cwd, sessions, blockers }
}

export function uniqueSessions(sessions: ShelfSession[]): ShelfSession[] {
  const seen = new Set<string>()
  return sessions.filter(session => {
    if (seen.has(session.file)) return false
    seen.add(session.file)
    return true
  })
}

export async function settleTab(input: {
  tab: TabInfo
  cwd: string
  sessions: ShelfSession[]
  reason: SettleReason
  mr?: MergeRequest
}): Promise<SettledTab> {
  const record: SettledTab = {
    id: randomUUID(),
    at: new Date().toISOString(),
    reason: input.reason,
    agentDir: agentDir(),
    tabId: input.tab.tab_id,
    label: input.tab.label,
    workspaceId: input.tab.workspace_id,
    workspaceLabel: await herdr<{ workspace: { label: string } }>([
      'workspace',
      'get',
      input.tab.workspace_id,
    ]).then(
      result => result.workspace.label,
      () => undefined,
    ),
    cwd: input.cwd,
    sessions: uniqueSessions(input.sessions),
    ...(input.mr ? { mr: input.mr } : {}),
  }
  appendShelf({ type: 'settled', ...record })
  flushLog({ outcome: 'settled', reason: input.reason, shelfId: record.id, tabId: record.tabId })
  try {
    await herdr(['tab', 'close', input.tab.tab_id])
  } catch (error) {
    if (!(await tabExists(input.tab.tab_id).catch(() => true))) return record
    appendShelf({ type: 'removed', id: record.id, at: new Date().toISOString() })
    throw error
  }
  return record
}

function isDirectory(candidate: string | undefined): candidate is string {
  if (!candidate) return false
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

interface WorkspaceInfo {
  workspace_id: string
  label: string
}

async function reopenTarget(
  record: SettledTab,
  cwd: string,
  env: string[],
): Promise<{ tabId: string; paneId: string }> {
  const { workspaces } = await herdr<{ workspaces: WorkspaceInfo[] }>(['workspace', 'list'])
  const label = record.workspaceLabel || path.basename(record.cwd)
  const original = workspaces.find(
    workspace =>
      workspace.workspace_id === record.workspaceId &&
      (!record.workspaceLabel || workspace.label === record.workspaceLabel),
  )
  const existing = original ?? workspaces.find(workspace => workspace.label === label)
  if (existing) {
    const created = await herdr<{ tab: { tab_id: string }; root_pane: { pane_id: string } }>([
      'tab',
      'create',
      '--workspace',
      existing.workspace_id,
      '--cwd',
      cwd,
      '--label',
      record.label,
      '--focus',
      ...env,
    ])
    return { tabId: created.tab.tab_id, paneId: created.root_pane.pane_id }
  }
  const created = await herdr<{ tab: { tab_id: string }; root_pane: { pane_id: string } }>([
    'workspace',
    'create',
    '--cwd',
    cwd,
    '--label',
    label,
    '--focus',
    ...env,
  ])
  await herdr(['tab', 'rename', created.tab.tab_id, record.label]).catch(() => {})
  return { tabId: created.tab.tab_id, paneId: created.root_pane.pane_id }
}

export async function reopenTab(record: SettledTab): Promise<string> {
  const missing = record.sessions.filter(session => !existsSync(session.file))
  if (missing.length > 0) {
    throw new Error(`Session file missing: ${missing.map(session => session.file).join(', ')}`)
  }
  const launches: Array<ShelfSession | null> = record.sessions.length > 0 ? record.sessions : [null]
  const directories = launches.map(session => session?.cwd || record.cwd)
  const gone = directories.filter(directory => !isDirectory(directory))
  if (gone.length > 0) throw new Error(`Directory missing: ${[...new Set(gone)].join(', ')}`)

  const env = ['--env', `PI_CODING_AGENT_DIR=${record.agentDir}`]
  const target = await reopenTarget(record, directories[0], env)

  const restored: string[] = []
  const finish = () =>
    appendShelf({ type: 'reopened', id: record.id, at: new Date().toISOString(), files: restored })
  let pane = target.paneId
  try {
    for (const [index, session] of launches.entries()) {
      if (index > 0) {
        const split = await herdr<{ pane: { pane_id: string } }>([
          'pane',
          'split',
          pane,
          '--direction',
          'right',
          '--cwd',
          directories[index],
          '--no-focus',
          ...env,
        ])
        pane = split.pane.pane_id
      }
      await herdr(
        [
          'agent',
          'start',
          `settle-${randomUUID().slice(0, 8)}`,
          '--kind',
          'pi',
          '--pane',
          pane,
          '--timeout',
          '60000',
          ...(session ? ['--', '--session', session.file] : []),
        ],
        70_000,
      )
      if (session) restored.push(session.file)
      await herdr(['agent', 'rename', pane, '--clear']).catch(() => {})
    }
  } catch (error) {
    if (restored.length > 0) finish()
    else await herdr(['tab', 'close', target.tabId]).catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Reopened ${restored.length} of ${record.sessions.length} sessions; the rest stay on the shelf: ${message}`,
    )
  }
  finish()
  return target.tabId
}

interface GitLabMergeRequest {
  state?: string
  merged_at?: string | null
  closed_at?: string | null
  web_url?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function withGlabLock<T>(body: () => Promise<T>): Promise<T> {
  const lock = path.join(traces.getStore()?.dir ?? agentDir(), 'herdr-settle', 'glab.lock')
  mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + GLAB_LOCK_WAIT_MS
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > GLAB_LOCK_STALE_MS) rmdirSync(lock)
    } catch {}
    if (Date.now() > deadline) throw new Error('timed out waiting for another glab call to finish')
    await sleep(50 + Math.random() * 150)
  }
  try {
    return await body()
  } finally {
    try {
      rmdirSync(lock)
    } catch {}
  }
}

async function glabJson<T>(cwd: string, args: string[]): Promise<T> {
  const call = () =>
    withGlabLock(() => run('glab', [...args, '-F', 'json'], { cwd, timeout: GLAB_TIMEOUT_MS }))
  let result = await call()
  if (result.code !== 0 && /invalid_grant/.test(result.stderr)) {
    await sleep(GLAB_RETRY_DELAY_MS)
    result = await call()
  }
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || `glab ${args.slice(0, 2).join(' ')} exited ${result.code}`,
    )
  }
  return JSON.parse(result.stdout || 'null') as T
}

export async function branchMergeRequest(
  cwd: string,
): Promise<{ open: boolean; terminal: MergeRequest | null } | null> {
  const git = (...args: string[]) => run('git', args, { cwd, timeout: 10_000 })
  const head = await git('symbolic-ref', '--quiet', '--short', 'HEAD')
  const branch = head.stdout.trim()
  if (head.code !== 0 || !branch || branch === 'main' || branch === 'master') return null
  const remote = (await git('config', '--get', `branch.${branch}.remote`)).stdout.trim() || 'origin'
  const url = (await git('remote', 'get-url', remote)).stdout.trim()
  if (!url || /github\.com/i.test(url)) return null

  const remoteHead = await git('symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`)
  const defaultBranch =
    remoteHead.code === 0
      ? remoteHead.stdout.trim().slice(remote.length + 1)
      : (await glabJson<{ default_branch?: string }>(cwd, ['repo', 'view', '-R', url]))
          ?.default_branch
  if (branch === defaultBranch) return null

  const query = ['mr', 'list', '-R', url, '--source-branch', branch]
  const opened = await glabJson<GitLabMergeRequest[]>(cwd, [...query, '--per-page', '1'])
  if ((opened ?? []).length > 0) return { open: true, terminal: null }

  const requests = await glabJson<GitLabMergeRequest[]>(cwd, [
    ...query,
    '--all',
    '--per-page',
    '100',
  ])
  let terminal: MergeRequest | null = null
  for (const request of requests ?? []) {
    const state = request.state === 'merged' || request.state === 'closed' ? request.state : null
    const at =
      state === 'merged' ? request.merged_at : state === 'closed' ? request.closed_at : null
    if (!(state && at) || Number.isNaN(Date.parse(at))) continue
    if (terminal === null || Date.parse(at) > Date.parse(terminal.at)) {
      terminal = { url: request.web_url || '', state, at }
    }
  }
  return { open: false, terminal }
}
