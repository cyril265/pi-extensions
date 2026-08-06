import type { Message, Usage } from '@earendil-works/pi-ai'
import type { UsageStats } from './types.ts'

export function createUsageStats(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  }
}

function addUsageStats(stats: UsageStats, usage: Usage): void {
  stats.input += usage.input
  stats.output += usage.output
  stats.cacheRead += usage.cacheRead
  stats.cacheWrite += usage.cacheWrite
  stats.cost += usage.cost.total
}

export function addAssistantUsage(stats: UsageStats, message: Message): void {
  if (message.role !== 'assistant') return
  stats.turns += 1
  addUsageStats(stats, message.usage)
}

export function sumUsageStats(usages: UsageStats[]): UsageStats {
  const total = createUsageStats()
  for (const usage of usages) {
    total.input += usage.input
    total.output += usage.output
    total.cacheRead += usage.cacheRead
    total.cacheWrite += usage.cacheWrite
    total.cost += usage.cost
    total.turns += usage.turns
  }
  return total
}

function getUsageTokenTotal(usage: UsageStats): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}

function formatTokenCount(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

function formatCost(cost: number): string {
  if (cost > 0 && cost < 0.0001) return `$${cost.toFixed(6)}`
  return `$${cost.toFixed(4)}`
}

export function formatUsageStats(usage: UsageStats): string {
  const tokenParts = [
    `input ${formatTokenCount(usage.input)}`,
    `output ${formatTokenCount(usage.output)}`,
  ]
  if (usage.cacheRead) tokenParts.push(`cache read ${formatTokenCount(usage.cacheRead)}`)
  if (usage.cacheWrite) tokenParts.push(`cache write ${formatTokenCount(usage.cacheWrite)}`)

  const turns = `${usage.turns} turn${usage.turns === 1 ? '' : 's'}`
  const tokens = `${formatTokenCount(getUsageTokenTotal(usage))} tokens (${tokenParts.join(', ')})`
  return `${turns}, ${tokens}, cost ${formatCost(usage.cost)}`
}
