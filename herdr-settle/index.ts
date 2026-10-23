import { existsSync } from 'node:fs'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  appendShelf,
  branchMergeRequest,
  closeIdleSubagents,
  currentPane,
  errorMessage,
  INACTIVE_MS,
  inspectTab,
  type LogFields,
  lastReopenedAt,
  latestTimestamp,
  logFile,
  logged,
  type MergeRequest,
  readShelf,
  type SettleReason,
  settleTab,
} from './settle.ts'

const FIRST_CHECK_MS = 10_000
const FIRST_CHECK_JITTER_MS = 20_000
const CHECK_INTERVAL_MS = 30 * 60 * 1000
const CHECK_JITTER_MS = 5 * 60 * 1000

const enabled =
  process.env.HERDR_ENV === '1' &&
  !!process.env.HERDR_PANE_ID &&
  process.env.PI_SIMPLE_SUBAGENT !== '1'

interface Decision {
  reason: SettleReason
  mr?: MergeRequest
}

interface MessageEntry {
  type: string
  timestamp?: string
  message?: { role?: string }
}

function activitySnapshot(ctx: ExtensionContext): string {
  const manager = ctx.sessionManager
  return `${manager.getEntries().length}:${manager.getLeafId() ?? ''}`
}

async function decide(ctx: ExtensionContext): Promise<{
  decision: Decision | null
  mergeRequest: LogFields['mergeRequest']
  lookupError?: string
}> {
  const manager = ctx.sessionManager
  const file = manager.getSessionFile()
  const reopenedAt = file ? lastReopenedAt(file, readShelf()) : null
  const created = manager.getHeader()?.timestamp
  let lastMessage: string | null = null
  let lastUserMessage: string | null = null
  for (const entry of manager.getEntries() as MessageEntry[]) {
    if (entry.type !== 'message' || !entry.timestamp) continue
    lastMessage = latestTimestamp([lastMessage, entry.timestamp])
    if (entry.message?.role === 'user') {
      lastUserMessage = latestTimestamp([lastUserMessage, entry.timestamp])
    }
  }
  const activityAt = latestTimestamp([created, lastMessage, reopenedAt])
  const userAnchor = latestTimestamp([created, lastUserMessage, reopenedAt])

  let lookupError: string | undefined
  const mergeRequest = await branchMergeRequest(ctx.cwd).catch(error => {
    lookupError = errorMessage(error)
    return null
  })
  const terminal = mergeRequest && !mergeRequest.open ? mergeRequest.terminal : null
  if (terminal && userAnchor && Date.parse(terminal.at) >= Date.parse(userAnchor)) {
    const reason = terminal.state === 'merged' ? 'mr-merged' : 'mr-closed'
    return { decision: { reason, mr: terminal }, mergeRequest, lookupError }
  }
  if (activityAt && Date.now() - Date.parse(activityAt) > INACTIVE_MS) {
    return { decision: { reason: 'inactive' }, mergeRequest, lookupError }
  }
  return { decision: null, mergeRequest, lookupError }
}

export default function (pi: ExtensionAPI) {
  if (!enabled) return

  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastSkipped = ''
  const warned = new Set<string>()

  const warnOnce = (ctx: ExtensionContext, kind: string, message: string) => {
    if (warned.has(kind) || !ctx.hasUI) return
    warned.add(kind)
    ctx.ui.notify(`herdr-settle: ${message}\nLog: ${logFile()}`, 'warning')
  }

  const ready = (ctx: ExtensionContext) =>
    ctx.isIdle() && !ctx.hasPendingMessages() && !ctx.ui.getEditorText().trim()

  const check = async (ctx: ExtensionContext, current: number, entry: LogFields): Promise<void> => {
    if (!ready(ctx)) {
      entry.outcome = 'busy'
      return
    }
    const snapshot = activitySnapshot(ctx)
    const { decision, mergeRequest, lookupError } = await decide(ctx)
    entry.mergeRequest = mergeRequest
    if (lookupError) entry.lookupError = lookupError
    if (current !== generation) {
      entry.outcome = 'stale'
      return
    }
    if (lookupError) warnOnce(ctx, 'lookup', `GitLab lookup failed: ${lookupError}`)
    if (!decision) {
      entry.outcome = 'kept'
      return
    }
    entry.reason = decision.reason

    const pane = await currentPane()
    entry.tabId = pane.tab_id
    const inspection = await inspectTab(pane.tab_id, {
      strict: true,
      inactivity: decision.reason === 'inactive',
      selfPaneId: pane.pane_id,
    })
    if (current !== generation) {
      entry.outcome = 'stale'
      return
    }
    if (!ready(ctx) || activitySnapshot(ctx) !== snapshot) {
      entry.outcome = 'changed'
      return
    }

    const file = ctx.sessionManager.getSessionFile()
    if (inspection.blockers.length > 0) {
      entry.outcome = 'skipped'
      entry.blockers = inspection.blockers
      const key = [pane.tab_id, decision.reason, ...inspection.blockers].join('\n')
      if (key === lastSkipped) return
      lastSkipped = key
      appendShelf({
        type: 'skipped',
        at: new Date().toISOString(),
        tabId: pane.tab_id,
        session: file ?? null,
        reason: decision.reason,
        blockers: inspection.blockers,
      })
      return
    }

    const own = file && existsSync(file) ? [{ file, cwd: ctx.cwd }] : []
    await settleTab({
      tab: inspection.tab,
      cwd: ctx.cwd,
      sessions: [...own, ...inspection.sessions],
      reason: decision.reason,
      mr: decision.mr,
    })
  }

  const schedule = (ctx: ExtensionContext, current: number, delay: number) => {
    timer = setTimeout(async () => {
      if (current !== generation) return
      const fields: LogFields = {
        op: 'check',
        session: ctx.sessionManager.getSessionFile() ?? null,
        cwd: ctx.cwd,
      }
      await logged(fields, async entry => {
        try {
          const closed = await closeIdleSubagents()
          if (closed.length > 0) entry.closedSubagents = closed
        } catch (error) {
          entry.subagentError = errorMessage(error)
          if (current === generation) {
            warnOnce(ctx, 'subagents', `closing idle subagent panes failed: ${entry.subagentError}`)
          }
        }
        if (current !== generation) {
          entry.outcome = 'stale'
          return
        }
        try {
          await check(ctx, current, entry)
        } catch (error) {
          entry.outcome = 'failed'
          entry.error = errorMessage(error)
          if (current === generation) warnOnce(ctx, 'check', `check failed: ${entry.error}`)
        }
      }).catch(() => {})
      if (current === generation) {
        schedule(ctx, current, CHECK_INTERVAL_MS + Math.random() * CHECK_JITTER_MS)
      }
    }, delay)
    timer.unref?.()
  }

  pi.on('session_start', (_event, ctx) => {
    generation++
    clearTimeout(timer)
    lastSkipped = ''
    if (ctx.mode !== 'tui') return
    schedule(ctx, generation, FIRST_CHECK_MS + Math.random() * FIRST_CHECK_JITTER_MS)
  })

  pi.on('session_shutdown', () => {
    generation++
    clearTimeout(timer)
  })
}
