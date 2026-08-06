import type { AssistantMessage } from '@earendil-works/pi-ai'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent'

export default function (pi: ExtensionAPI) {
  pi.registerCommand('branch-stats', {
    description: 'Show usage statistics for the current branch or a tree node',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const requestedId = args.trim()
      const nodeId = requestedId || ctx.sessionManager.getLeafId()

      if (requestedId && !ctx.sessionManager.getEntry(requestedId)) {
        ctx.ui.notify(`Tree node not found: ${requestedId}`, 'error')
        return
      }

      const entries = nodeId ? ctx.sessionManager.getBranch(nodeId) : []
      const stats = calculateStats(entries)
      const promptTokens = stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite

      ctx.ui.notify(
        [
          `Branch through ${nodeId ?? '(empty session)'}`,
          `Messages: ${stats.totalMessages} (${stats.userMessages} user, ${stats.assistantMessages} assistant)`,
          `Tools: ${stats.toolCalls} calls, ${stats.toolResults} results`,
          `Tokens: ${promptTokens.toLocaleString()} input, ${stats.tokens.output.toLocaleString()} output`,
          `Cache: ${stats.tokens.cacheRead.toLocaleString()} read, ${stats.tokens.cacheWrite.toLocaleString()} written`,
          `Cost: $${stats.cost.toFixed(3)}`,
        ].join('\n'),
        'info',
      )
    },
  })
}

type BranchStats = {
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  totalMessages: number
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  cost: number
}

function calculateStats(entries: readonly SessionEntry[]): BranchStats {
  const stats: BranchStats = {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    cost: 0,
  }

  for (const entry of entries) {
    if (entry.type !== 'message') continue

    stats.totalMessages++

    if (entry.message.role === 'user') {
      stats.userMessages++
      continue
    }

    if (entry.message.role === 'toolResult') {
      stats.toolResults++
      continue
    }

    if (entry.message.role !== 'assistant') continue

    stats.assistantMessages++
    const message = entry.message as AssistantMessage
    stats.toolCalls += message.content.filter(content => content.type === 'toolCall').length
    stats.tokens.input += message.usage.input
    stats.tokens.output += message.usage.output
    stats.tokens.cacheRead += message.usage.cacheRead
    stats.tokens.cacheWrite += message.usage.cacheWrite
    stats.cost += message.usage.cost.total
  }

  return stats
}
