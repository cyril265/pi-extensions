import * as os from 'node:os'
import * as path from 'node:path'
import type { Theme } from '@earendil-works/pi-coding-agent'
import type {
  AgentDisplayInfo,
  SubagentResultDetails,
  ToolDisplayItem,
  UsageStats,
} from './types.ts'
import { formatUsageStats, sumUsageStats } from './usage.ts'

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

function getAgentsWithUsage(
  agents: AgentDisplayInfo[],
): Array<AgentDisplayInfo & { usage: UsageStats }> {
  return agents.filter((agent): agent is AgentDisplayInfo & { usage: UsageStats } => !!agent.usage)
}

function formatAgentStatsLines(agents: AgentDisplayInfo[], theme: Theme): string[] {
  const agentsWithUsage = getAgentsWithUsage(agents)
  if (agentsWithUsage.length === 0) return []

  if (agentsWithUsage.length === 1) {
    return [theme.fg('toolOutput', formatUsageStats(agentsWithUsage[0].usage))]
  }

  const lines: string[] = []
  for (const agent of agentsWithUsage) {
    lines.push(
      `${theme.fg('toolTitle', agent.name)} ${theme.fg('toolOutput', formatUsageStats(agent.usage))}`,
    )
  }
  lines.push(
    theme.fg(
      'toolOutput',
      `total ${formatUsageStats(sumUsageStats(agentsWithUsage.map(agent => agent.usage)))}`,
    ),
  )
  return lines
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

export function renderAgentsOverview(
  agents: AgentDisplayInfo[],
  theme: Theme,
  showRuntime = false,
  title = 'runSubAgents',
): string {
  const doneCount = agents.filter(agent => agent.status === 'done').length
  const runningCount = agents.filter(agent => agent.status === 'running').length
  const failedCount = agents.filter(agent => agent.status === 'failed').length
  const interruptedCount = agents.filter(agent => agent.status === 'interrupted').length
  let header = `${theme.fg('toolTitle', theme.bold(title))} ${theme.fg('accent', `${agents.length} agent${agents.length === 1 ? '' : 's'}`)}`
  if (showRuntime) {
    if (doneCount > 0) header += ` ${theme.fg('success', `${doneCount} done`)}`
    if (runningCount > 0) header += ` ${theme.fg('warning', `${runningCount} running`)}`
    if (failedCount > 0) header += ` ${theme.fg('error', `${failedCount} failed`)}`
    if (interruptedCount > 0) header += ` ${theme.fg('warning', `${interruptedCount} interrupted`)}`
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
    const displayModel = agent.effectiveModel ?? agent.suppliedModel
    lines.push(
      '',
      `${theme.fg('muted', `${index + 1}.`)} ${icon}${theme.fg('toolTitle', theme.bold(agent.name))} ${theme.fg('warning', `[${agent.thinking}]`)}${displayModel ? ` ${theme.fg('dim', `[${displayModel}]`)}` : ''} ${theme.fg('muted', meta)}`,
    )
    if (agent.cwd)
      lines.push(`   ${theme.fg('muted', 'cwd')} ${theme.fg('accent', getCwdLabel(agent.cwd))}`)
    if (agent.prompt) {
      lines.push(`   ${theme.fg('muted', 'task')}`)
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
  const doneCount = agents.filter(agent => agent.status === 'done').length
  const runningCount = agents.filter(agent => agent.status === 'running').length
  const failedCount = agents.filter(agent => agent.status === 'failed').length
  const interruptedCount = agents.filter(agent => agent.status === 'interrupted').length
  let text = `${theme.fg('toolTitle', theme.bold(title))} ${theme.fg('accent', `${agents.length} agent${agents.length === 1 ? '' : 's'}`)}`
  if (doneCount) text += ` ${theme.fg('success', `${doneCount} done`)}`
  if (runningCount) text += ` ${theme.fg('warning', `${runningCount} running`)}`
  if (failedCount) text += ` ${theme.fg('error', `${failedCount} failed`)}`
  if (interruptedCount) text += ` ${theme.fg('warning', `${interruptedCount} interrupted`)}`
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
      return `${prefix} ${theme.fg('toolTitle', agent.name)}`
    })
    .join(' ')}`
  const statsLines = formatAgentStatsLines(agents, theme)
  if (statsLines.length) text += `\n${statsLines.join('\n')}`
  return text
}

export function renderSubagentDetails(
  details: SubagentResultDetails,
  expanded: boolean,
  theme: Theme,
  title = 'runSubAgents',
): string {
  if (!details.liveEvents?.length) return renderLiveCompact(details.agents, theme, title)

  const eventLimit = expanded ? undefined : 30
  const events = eventLimit ? details.liveEvents.slice(-eventLimit) : details.liveEvents
  const lines = [renderLiveCompact(details.agents, theme, title), '']
  if (eventLimit && details.liveEvents.length > eventLimit) {
    lines.push(
      theme.fg('muted', `... ${details.liveEvents.length - eventLimit} earlier tool calls`),
    )
  }

  let previousAgent = ''
  let toolGroup: { agent: string; name: string; tools: ToolDisplayItem[] } | undefined
  const flushToolGroup = () => {
    if (!toolGroup) return
    const displayName = getToolDisplayName(toolGroup.name)
    if (toolGroup.tools.length === 1) {
      const tool = toolGroup.tools[0]
      lines.push(
        `  ${theme.fg('muted', '└')} ${theme.fg('muted', displayName)} ${formatToolTarget(tool.name, tool.args, theme)}`,
      )
    } else {
      lines.push(`  ${theme.fg('muted', '└')} ${theme.fg('muted', displayName)}`)
      for (const tool of toolGroup.tools) {
        lines.push(`    ${theme.fg('muted', '-')} ${formatToolTarget(tool.name, tool.args, theme)}`)
      }
    }
    toolGroup = undefined
  }

  for (const event of events) {
    if (event.agent !== previousAgent) {
      flushToolGroup()
      if (previousAgent) lines.push('')
      lines.push(theme.fg('toolTitle', theme.bold(event.agent)))
      previousAgent = event.agent
    }
    if (toolGroup && toolGroup.agent === event.agent && toolGroup.name === event.tool.name) {
      toolGroup.tools.push(event.tool)
    } else {
      flushToolGroup()
      toolGroup = {
        agent: event.agent,
        name: event.tool.name,
        tools: [event.tool],
      }
    }
  }
  flushToolGroup()
  return lines.join('\n')
}
