import * as os from 'node:os'
import * as path from 'node:path'
import type { Theme } from '@earendil-works/pi-coding-agent'
import type {
  AgentDisplayInfo,
  SubagentResultDetails,
  SubagentStatus,
  UsageStats,
} from './types.ts'
import { formatPiSessionCommand } from './sessions.ts'
import { formatCompactUsageStats, sumUsageStats } from './usage.ts'

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

function truncateLine(text: string, max = 80): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max)
}

function getCwdLabel(cwd: string): string {
  const name = path.basename(cwd)
  return name || cwd
}

export function formatResultText(text: string, theme: Theme): string {
  return text
    .split('\n')
    .map(line => (/^(?:Total: )?\d+ turn/.test(line) ? theme.fg('toolOutput', line) : line))
    .join('\n')
}

function wrapPreview(text: string, maxLineLength = 100, maxLines = 3): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  if (words.length === 0) return ['...']
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length <= maxLineLength) {
      current = next
      continue
    }
    if (current) lines.push(current)
    current = word
    if (lines.length === maxLines - 1) break
  }
  if (current && lines.length < maxLines) lines.push(current)
  const consumed = lines.join(' ').split(' ').filter(Boolean).length
  if (consumed < words.length && lines.length > 0)
    lines[lines.length - 1] = `${lines[lines.length - 1]}...`
  return lines
}

function shortenPathForDisplay(filePath: string): string {
  const home = os.homedir()
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath
}

export function getToolDisplayName(toolName: string): string {
  switch (toolName) {
    case 'bash':
      return 'Ran'
    case 'read':
      return 'Read'
    case 'write':
      return 'Wrote'
    case 'edit':
      return 'Edited'
    case 'web_search':
    case 'code_search':
      return 'Searched'
    case 'fetch_content':
      return 'Fetched'
    default:
      return toolName.replace(/_/g, ' ').replace(/^./, char => char.toUpperCase())
  }
}

export function formatToolTarget(
  toolName: string,
  args: Record<string, unknown>,
  theme: Theme,
): string {
  switch (toolName) {
    case 'bash': {
      const command = typeof args.command === 'string' ? args.command : '...'
      return theme.fg('toolOutput', truncateLine(command, 120))
    }
    case 'read':
    case 'write':
    case 'edit': {
      const rawPath =
        typeof args.path === 'string'
          ? args.path
          : typeof args.file_path === 'string'
            ? args.file_path
            : '...'
      let text = theme.fg('toolOutput', shortenPathForDisplay(rawPath))
      if (toolName === 'read') {
        const offset = typeof args.offset === 'number' ? args.offset : undefined
        const limit = typeof args.limit === 'number' ? args.limit : undefined
        if (offset !== undefined || limit !== undefined) {
          const startLine = offset ?? 1
          const endLine = limit === undefined ? '' : startLine + limit - 1
          text += theme.fg('warning', `:${startLine}${endLine ? `-${endLine}` : ''}`)
        }
      }
      return text
    }
    case 'web_search':
    case 'code_search': {
      const query =
        typeof args.query === 'string'
          ? args.query
          : Array.isArray(args.queries) && typeof args.queries[0] === 'string'
            ? args.queries[0]
            : '...'
      return theme.fg('toolOutput', truncateLine(query, 120))
    }
    case 'fetch_content': {
      const url =
        typeof args.url === 'string'
          ? args.url
          : Array.isArray(args.urls) && typeof args.urls[0] === 'string'
            ? args.urls[0]
            : '...'
      return theme.fg('toolOutput', truncateLine(url, 120))
    }
    default:
      return theme.fg('dim', truncateLine(JSON.stringify(args), 120))
  }
}

export function formatElapsed(startedAt: number, now = Date.now()): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours) return `${hours}h${minutes}m${seconds}s`
  if (minutes) return `${minutes}m${seconds}s`
  return `${seconds}s`
}

function renderStatusIcon(status: SubagentStatus, theme: Theme): string {
  switch (status) {
    case 'done':
      return theme.fg('success', '✓')
    case 'failed':
      return theme.fg('error', '✗')
    case 'interrupted':
      return theme.fg('warning', '■')
    case 'running':
      return theme.fg('warning', '●')
    case 'queued':
      return theme.fg('muted', '○')
  }
}

function renderAgentIdentity(agent: AgentDisplayInfo, theme: Theme): string {
  const model = agent.suppliedModel ?? agent.effectiveModel?.split('/').at(-1)
  const modelLabel = model
    ? `${theme.fg('muted', ' · ')}${theme.fg('accent', model)}`
    : ''
  return `${theme.fg('text', agent.name)}${modelLabel}`
}

function renderStatusSummary(agents: AgentDisplayInfo[], theme: Theme): string {
  const doneCount = agents.filter(agent => agent.status === 'done').length
  const failedCount = agents.filter(agent => agent.status === 'failed').length
  const interruptedCount = agents.filter(agent => agent.status === 'interrupted').length
  const runningCount = agents.length - doneCount - failedCount - interruptedCount

  if (doneCount === agents.length) return theme.fg('success', `${doneCount}/${agents.length} done`)

  const parts: string[] = []
  if (doneCount) parts.push(theme.fg('success', `${doneCount} done`))
  if (runningCount) parts.push(theme.fg('warning', `${runningCount} running`))
  if (failedCount) parts.push(theme.fg('error', `${failedCount} failed`))
  if (interruptedCount) parts.push(theme.fg('warning', `${interruptedCount} interrupted`))
  return parts.join(theme.fg('muted', ' · '))
}

export function renderDispatchResult(
  jobId: string,
  agents: Array<{ name: string; sessionKey: string }>,
  theme: Theme,
): string {
  const count = `${agents.length} agent${agents.length === 1 ? '' : 's'}`
  return [
    `${theme.fg('success', 'dispatched')}${theme.fg('dim', ' · job ')}${theme.fg('accent', jobId)}${theme.fg('dim', ` · ${count}`)}`,
    ...agents.map(agent => theme.fg('dim', `${agent.name} → ${agent.sessionKey}`)),
    theme.fg('dim', `collect with collectSubagents({ jobId: "${jobId}" })`),
  ].join('\n')
}

export function renderSubagentWidget(
  details: SubagentResultDetails,
  theme: Theme,
  title: string,
  jobId: string,
  startedAt: number,
  now = Date.now(),
): string {
  const lines = [
    [
      theme.fg('toolTitle', theme.bold(title)),
      `${theme.fg('dim', 'job')} ${theme.fg('accent', jobId)}`,
      renderStatusSummary(details.agents, theme),
      theme.fg('muted', formatElapsed(startedAt, now)),
    ].join(' · '),
  ]
  for (const agent of details.agents) {
    const status = agent.status || 'queued'
    const tool = agent.tools?.at(-1)
    const toolText = tool
      ? ` · ${theme.fg('muted', getToolDisplayName(tool.name))} ${formatToolTarget(tool.name, tool.args, theme)}`
      : ''
    lines.push(`${renderStatusIcon(status, theme)} ${renderAgentIdentity(agent, theme)}${toolText}`)
  }
  return lines.join('\n')
}

export function renderAgentsOverview(
  agents: AgentDisplayInfo[],
  theme: Theme,
  showRuntime = false,
  title = 'runSubAgents',
): string {
  let header = `${theme.fg('toolTitle', theme.bold(title))}${theme.fg('muted', ` · ${agents.length} agent${agents.length === 1 ? '' : 's'}`)}`
  if (showRuntime) {
    header += `${theme.fg('muted', ' · ')}${renderStatusSummary(agents, theme)}`
  }

  const lines = [header]
  agents.forEach((agent, index) => {
    const status = agent.status || 'queued'
    const icon = showRuntime
      ? status === 'done'
        ? `${theme.fg('success', '✓')} `
        : status === 'failed'
          ? `${theme.fg('error', '✗')} `
          : status === 'interrupted'
            ? `${theme.fg('warning', '■')} `
            : status === 'running'
              ? `${theme.fg('warning', '●')} `
              : `${theme.fg('muted', '○')} `
      : ''
    const session = agent.sessionKey ? `session:${agent.sessionKey}` : 'new session'
    const context = agent.forkParent ? ' · parent fork' : ''
    const meta = showRuntime ? `${status} · ${session}${context}` : `${session}${context}`
    lines.push(
      '',
      `${theme.fg('dim', `${index + 1}.`)} ${icon}${renderAgentIdentity(agent, theme)}${theme.fg('dim', ` · ${agent.thinking} · ${meta}`)}`,
    )
    if (agent.cwd)
      lines.push(`   ${theme.fg('dim', 'cwd')} ${theme.fg('text', getCwdLabel(agent.cwd))}`)
    if (agent.prompt) {
      lines.push(`   ${theme.fg('dim', 'task')}`)
      for (const line of wrapPreview(agent.prompt, 110, 3)) {
        lines.push(`     ${theme.fg('toolOutput', line)}`)
      }
    }
  })
  return lines.join('\n')
}

export function renderLiveCompact(
  agents: AgentDisplayInfo[],
  theme: Theme,
  title = 'runSubAgents',
): string {
  let text = `${theme.fg('toolTitle', theme.bold(title))}${theme.fg('muted', ' · ')}${renderStatusSummary(agents, theme)}`
  text += `\n${agents
    .map(agent => {
      const status = agent.status || 'queued'
      const prefix =
        status === 'done'
          ? theme.fg('success', '✓')
          : status === 'failed'
            ? theme.fg('error', '✗')
            : status === 'interrupted'
              ? theme.fg('warning', '■')
              : status === 'running'
                ? theme.fg('warning', '●')
                : theme.fg('muted', '○')
      const usage = agent.usage
        ? `${theme.fg('muted', ' · ')}${theme.fg('dim', formatCompactUsageStats(agent.usage))}`
        : ''
      const continuation =
        agent.sessionId &&
        agent.sessionPath &&
        (status === 'done' || status === 'failed' || status === 'interrupted')
          ? `\n  ${theme.fg('dim', `session ${agent.sessionId}`)}\n  ${theme.fg('dim', formatPiSessionCommand(agent.sessionPath))}`
          : ''
      return `${prefix} ${renderAgentIdentity(agent, theme)}${usage}${continuation}`
    })
    .join('\n')}`
  const agentsWithUsage = agents.filter(
    (agent): agent is AgentDisplayInfo & { usage: UsageStats } => !!agent.usage,
  )
  if (agentsWithUsage.length > 1) {
    text += `\n${theme.fg('dim', `total · ${formatCompactUsageStats(sumUsageStats(agentsWithUsage.map(agent => agent.usage)))}`)}`
  }
  return text
}
