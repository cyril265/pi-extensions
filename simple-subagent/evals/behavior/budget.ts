import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type CampaignLimits = { requests: number; tokens: number; seconds: number }

// O_EXCL tickets provide a cross-process request ceiling without stale locks.
export function reserveRequest(directory: string, limit: number): boolean {
  mkdirSync(directory, { recursive: true })
  for (let index = 0; index < limit; index++) {
    try { closeSync(openSync(join(directory, `${index}.ticket`), 'wx')); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  return false
}

export function usageTokens(usage: Record<string, any> | undefined): number {
  return ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((sum, key) => sum + (typeof usage?.[key] === 'number' ? Math.max(0, usage[key]) : 0), 0)
}

export function recordTokens(directory: string, tokens: number): void {
  const target = join(directory, 'usage')
  mkdirSync(target, { recursive: true })
  const file = join(target, randomUUID())
  writeFileSync(`${file}.tmp`, String(tokens))
  renameSync(`${file}.tmp`, `${file}.tokens`)
}

export function readBudget(directory: string): { requests: number; tokens: number } {
  const names = (path: string) => {
    try { return readdirSync(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  return {
    requests: names(join(directory, 'requests')).filter(name => name.endsWith('.ticket')).length,
    tokens: names(join(directory, 'usage')).filter(name => name.endsWith('.tokens')).reduce((sum, name) => sum + Number(readFileSync(join(directory, 'usage', name), 'utf8')), 0),
  }
}

export function budgetReason(directory: string, limits: CampaignLimits, startedAt: number, now = Date.now()): string | undefined {
  const used = readBudget(directory)
  if (used.requests >= limits.requests) return 'campaign request limit'
  if (used.tokens >= limits.tokens) return 'campaign token limit'
  if (now - startedAt >= limits.seconds * 1000) return 'campaign time limit'
}
