import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { truncateToWidth } from '@earendil-works/pi-tui'

class FooterStatuses {
  sandboxActive = false
  others: string[] = []
}

type QuotaUsageWindow = {
  label: string
  usedPercent: number
  resetAt?: number
}

type CodexUsageState = {
  providerName?: string
  loading: boolean
  fetchedAt?: number
  error?: string
  windows: QuotaUsageWindow[]
}

type AnthropicUsageState = {
  providerName?: string
  loading: boolean
  fetchedAt?: number
  error?: string
  windows: QuotaUsageWindow[]
}

type QuotaRefreshOptions = {
  force?: boolean
  allowStaleCache?: boolean
  skipFetch?: boolean
}

type FooterModelState = {
  provider?: string
  id?: string
  name?: string
  reasoning?: boolean
}

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

class FooterRuntimeState {
  requestRender?: () => void
  currentModel: FooterModelState = {}
  currentDirectory = '?'
  contextPercent: number | null = null
  contextTokens: number | null = null
  contextWindow: number | null = null
  sessionTotalCost = 0
  estimatedCodexCacheWriteSurcharge = 0
  thinkingLevel: ThinkingLevel = 'off'
  codexUsage: CodexUsageState = { loading: false, windows: [] }
  codexUsageCache = new Map<string, CodexUsageState>()
  codexUsageRequestId = 0
  codexUsageAbort?: AbortController
  anthropicUsage: AnthropicUsageState = { loading: false, windows: [] }
  anthropicUsageCache = new Map<string, AnthropicUsageState>()
  anthropicUsageRequestId = 0
  anthropicUsageAbort?: AbortController
  quotaRefreshTimer?: NodeJS.Timeout
  lastQuotaRefreshAt?: number
  idleStartedAt?: number
  idleTimer?: NodeJS.Timeout
}

const runtimeState = new FooterRuntimeState()
const CODEX_PROVIDER = /^openai-codex(?:-\d+)?$/
const ANTHROPIC_PROVIDER = /^anthropic(?:-\d+)?$/
const CODEX_SUBSCRIPTION_PROVIDER = /^openai-codex-\d+$/
const GPT_5_6_CACHE_WRITE_SURCHARGE_PER_MILLION: Record<string, number> = {
  'gpt-5.6-luna': 0.25,
  'gpt-5.6-terra': 0.625,
  'gpt-5.6-sol': 1.25,
}
const GPT_5_6_LONG_CONTEXT_THRESHOLD = 272_000
const HIDDEN_STATUS_KEYS = new Set(['codebase-memory'])
const SUB_USAGE_STATUS_KEYS = new Set(['sub-bar', 'sub-status:usage'])
const CODEX_USAGE_TIMEOUT_MS = 10_000
const QUOTA_REFRESH_INTERVAL_MS = 180_000
const QUOTA_MIN_REFRESH_INTERVAL_MS = 120_000
const QUOTA_REFRESH_TICK_MS = Math.min(QUOTA_REFRESH_INTERVAL_MS, 10_000)
const ANTHROPIC_USAGE_TIMEOUT_MS = 10_000
const IDLE_SECONDS_PHASE_MS = 5 * 60_000
const IDLE_SECONDS_TICK_MS = 1_000
const IDLE_MINUTES_TICK_MS = 60_000
const DEFAULT_CODEX_USAGE_BASE_URL = 'https://chatgpt.com/backend-api'
const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth'

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

function sanitizeStatusText(text: string): string {
  return stripAnsi(text)
    .replace(/[\r\n\t]/g, ' ')
    .replace(/(?:\s*[•·]\s*)?\d+\s+pool\(s\)/gi, '')
    .replace(/\s*[•·]\s*$/g, '')
    .replace(/:\s*/g, ': ')
    .replace(/ +/g, ' ')
    .trim()
}

function shouldHideStatusEntry(key: string, providerName: string | undefined): boolean {
  if (HIDDEN_STATUS_KEYS.has(key)) return true
  if (
    !(providerName && (CODEX_PROVIDER.test(providerName) || ANTHROPIC_PROVIDER.test(providerName)))
  ) {
    return false
  }
  return SUB_USAGE_STATUS_KEYS.has(key) || key.startsWith('sub-status:')
}

function getFooterStatuses(
  entries: Array<[string, string]>,
  providerName: string | undefined,
): FooterStatuses {
  const result = new FooterStatuses()

  for (const [key, rawText] of entries) {
    if (shouldHideStatusEntry(key, providerName)) continue

    const status = sanitizeStatusText(rawText)
    if (key === 'sandbox') {
      result.sandboxActive = Boolean(status)
      continue
    }
    if (!status) continue

    if (key === 'preset' || key.toLowerCase().includes('mcp')) continue
    if (/^(preset|mcp)\s*:/i.test(status)) continue

    result.others.push(status)
  }

  return result
}

function getCurrentDirectoryName(cwd: string): string {
  if (cwd === '/') return '/'
  const name = basename(cwd)
  return name || cwd
}

function getThinkingColor(
  level: string,
):
  | 'thinkingOff'
  | 'thinkingMinimal'
  | 'thinkingLow'
  | 'thinkingMedium'
  | 'thinkingHigh'
  | 'thinkingXhigh'
  | 'thinkingMax' {
  switch (level) {
    case 'minimal':
      return 'thinkingMinimal'
    case 'low':
      return 'thinkingLow'
    case 'medium':
      return 'thinkingMedium'
    case 'high':
      return 'thinkingHigh'
    case 'xhigh':
      return 'thinkingXhigh'
    case 'max':
      return 'thinkingMax'
    default:
      return 'thinkingOff'
  }
}

function orange(text: string): string {
  return `\x1b[38;5;208m${text}\x1b[39m`
}

function formatTokensK(tokens: number | null): string {
  if (tokens === null) return '?k'
  return `${Math.round(tokens / 1000)}k`
}

function styleContextUsage(
  theme: Theme,
  percent: number | null,
  tokens: number | null,
  contextWindow: number | null,
): string {
  const label = `${percent === null ? '?' : `${Math.round(percent)}%`} ${formatTokensK(tokens)}/${formatTokensK(contextWindow)}`

  if (percent === null) return theme.fg('dim', label)
  if (percent >= 90) return theme.fg('error', theme.bold(label))
  if (percent >= 75) return orange(`\x1b[1m${label}\x1b[22m`)
  if (percent >= 60) return theme.fg('warning', theme.bold(label))
  return theme.fg('success', theme.bold(label))
}

function joinSegments(theme: Theme, segments: string[]): string {
  return segments.filter(Boolean).join(theme.fg('dim', ' • '))
}

function getTotalAssistantCost(ctx: ExtensionContext): number {
  let totalCost = 0

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue
    totalCost += entry.message.usage.cost.total
  }

  return totalCost
}

function getEstimatedCodexCacheWriteSurcharge(ctx: ExtensionContext): number {
  let surcharge = 0

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue
    if (!CODEX_SUBSCRIPTION_PROVIDER.test(entry.message.provider)) continue
    if (entry.message.usage.cacheWrite !== 0) continue

    const surchargeRate = GPT_5_6_CACHE_WRITE_SURCHARGE_PER_MILLION[entry.message.model]
    if (surchargeRate === undefined) continue
    const promptTokens = entry.message.usage.input + entry.message.usage.cacheRead
    const multiplier = promptTokens > GPT_5_6_LONG_CONTEXT_THRESHOLD ? 2 : 1
    surcharge += (surchargeRate * multiplier * entry.message.usage.input) / 1_000_000
  }

  return surcharge
}

function buildSessionTotalCostSegment(theme: Theme): string {
  if (runtimeState.sessionTotalCost <= 0) return ''

  return theme.bold(`$${runtimeState.sessionTotalCost.toFixed(3)}`)
}

function formatIdleDuration(elapsedMs: number): string {
  const elapsedSeconds = Math.floor(elapsedMs / 1_000)
  if (elapsedMs < IDLE_SECONDS_PHASE_MS) {
    const minutes = Math.floor(elapsedSeconds / 60)
    const seconds = elapsedSeconds % 60
    return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`

  const hours = Math.floor(elapsedMinutes / 60)
  const minutes = elapsedMinutes % 60
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`
}

function scheduleIdleTick(): void {
  if (runtimeState.idleStartedAt === undefined) return

  const elapsedMs = Date.now() - runtimeState.idleStartedAt
  const delay = elapsedMs < IDLE_SECONDS_PHASE_MS ? IDLE_SECONDS_TICK_MS : IDLE_MINUTES_TICK_MS
  runtimeState.idleTimer = setTimeout(() => {
    runtimeState.idleTimer = undefined
    if (runtimeState.idleStartedAt === undefined) return

    runtimeState.requestRender?.()
    scheduleIdleTick()
  }, delay)
  runtimeState.idleTimer.unref()
}

function stopIdleTimer(): void {
  if (runtimeState.idleTimer) {
    clearTimeout(runtimeState.idleTimer)
    runtimeState.idleTimer = undefined
  }
  if (runtimeState.idleStartedAt === undefined) return

  runtimeState.idleStartedAt = undefined
  runtimeState.requestRender?.()
}

function startIdleTimer(): void {
  stopIdleTimer()
  runtimeState.idleStartedAt = Date.now()
  runtimeState.requestRender?.()
  scheduleIdleTick()
}

function buildIdleTimerSegment(theme: Theme): string {
  if (runtimeState.idleStartedAt === undefined) return ''

  const elapsedMs = Math.max(0, Date.now() - runtimeState.idleStartedAt)
  return theme.fg('dim', `⏾ ${formatIdleDuration(elapsedMs)}`)
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function getQuotaCachePath(providerName: string): string {
  return join(homedir(), '.pi', 'agent', 'cache', 'pi-hud-footer', `${providerName}.json`)
}

function readQuotaUsageCache(providerName: string): AnthropicUsageState | undefined {
  try {
    const raw = getRecord(JSON.parse(readFileSync(getQuotaCachePath(providerName), 'utf8')))
    if (typeof raw?.fetchedAt !== 'number' || !Array.isArray(raw.windows)) return undefined

    const windows: QuotaUsageWindow[] = []
    for (const value of raw.windows) {
      const window = getRecord(value)
      if (typeof window?.label !== 'string' || typeof window.usedPercent !== 'number') {
        return undefined
      }
      windows.push({
        label: window.label,
        usedPercent: window.usedPercent,
        resetAt: typeof window.resetAt === 'number' ? window.resetAt : undefined,
      })
    }

    return {
      providerName,
      loading: false,
      fetchedAt: raw.fetchedAt,
      windows,
    }
  } catch {
    return undefined
  }
}

function writeQuotaUsageCache(providerName: string, state: AnthropicUsageState): void {
  const path = getQuotaCachePath(providerName)
  const temporaryPath = `${path}.${process.pid}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    temporaryPath,
    JSON.stringify({
      version: 1,
      fetchedAt: state.fetchedAt,
      windows: state.windows,
    }),
    'utf8',
  )
  renameSync(temporaryPath, path)
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length < 2) return {}

  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return {}
  }
}

function getCodexAccountId(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken)
  const auth = getRecord(payload[OPENAI_AUTH_CLAIM])
  return typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : undefined
}

function getCodexUsageWindowLabel(windowSeconds: unknown, fallbackWindowSeconds: number): string {
  const seconds =
    typeof windowSeconds === 'number' && windowSeconds > 0 ? windowSeconds : fallbackWindowSeconds
  const hours = Math.round(seconds / (60 * 60))
  if (hours >= 6 * 24) return 'Week'
  if (hours >= 24) return 'Day'
  return `${hours}h`
}

function normalizeCodexUsageWindow(
  window: unknown,
  prefix: string | undefined,
  fallbackWindowSeconds: number,
): QuotaUsageWindow | undefined {
  const raw = getRecord(window)
  if (!raw) return undefined

  const windowLabel = getCodexUsageWindowLabel(raw.limit_window_seconds, fallbackWindowSeconds)

  return {
    label: prefix ? `${prefix} ${windowLabel}` : windowLabel,
    usedPercent: typeof raw.used_percent === 'number' ? raw.used_percent : 0,
    resetAt: typeof raw.reset_at === 'number' ? raw.reset_at : undefined,
  }
}

function appendCodexUsageWindows(
  windows: QuotaUsageWindow[],
  rateLimit: unknown,
  prefix?: string,
): void {
  const raw = getRecord(rateLimit)
  if (!raw) return

  const primary = normalizeCodexUsageWindow(raw.primary_window, prefix, 3 * 60 * 60)
  const secondary = normalizeCodexUsageWindow(raw.secondary_window, prefix, 24 * 60 * 60)
  if (primary) windows.push(primary)
  if (secondary) windows.push(secondary)
}

function parseCodexUsageSnapshot(data: unknown): Pick<CodexUsageState, 'windows'> {
  const raw = getRecord(data)
  const windows: QuotaUsageWindow[] = []
  appendCodexUsageWindows(windows, raw?.rate_limit)

  if (Array.isArray(raw?.additional_rate_limits)) {
    for (const entry of raw.additional_rate_limits) {
      const additional = getRecord(entry)
      if (!additional) continue
      const limitName =
        typeof additional.limit_name === 'string' && additional.limit_name.trim()
          ? additional.limit_name.trim()
          : typeof additional.metered_feature === 'string' && additional.metered_feature.trim()
            ? additional.metered_feature.trim()
            : 'Additional'
      appendCodexUsageWindows(windows, additional.rate_limit, limitName)
    }
  }

  return { windows }
}

function getResponseHeader(headers: Record<string, string>, name: string): string | undefined {
  const value = headers[name]
  return value?.trim() || undefined
}

function parseResponseHeaderNumber(
  headers: Record<string, string>,
  name: string,
): number | undefined {
  const raw = getResponseHeader(headers, name)?.replace(/%$/, '')
  if (!raw) return undefined

  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function parseAbsoluteResetHeader(value: string | undefined): number | undefined {
  if (!value) return undefined

  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric >= 1_000_000_000_000 ? numeric / 1000 : numeric)
  }

  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? undefined : Math.floor(timestamp / 1000)
}

function parseCodexResetHeader(
  headers: Record<string, string>,
  windowName: 'primary' | 'secondary',
): number | undefined {
  const prefix = `x-codex-${windowName}`
  const relativeSeconds =
    parseResponseHeaderNumber(headers, `${prefix}-reset-after-seconds`) ??
    parseResponseHeaderNumber(headers, `${prefix}-resets-in-seconds`)
  if (relativeSeconds !== undefined && relativeSeconds >= 0) {
    return Math.floor(Date.now() / 1000 + relativeSeconds)
  }

  return parseAbsoluteResetHeader(
    getResponseHeader(headers, `${prefix}-resets-at`) ??
      getResponseHeader(headers, `${prefix}-reset-at`),
  )
}

function parseCodexResponseHeaders(headers: Record<string, string>): QuotaUsageWindow[] {
  const windows: QuotaUsageWindow[] = []

  for (const [windowName, fallbackSeconds] of [
    ['primary', 5 * 60 * 60],
    ['secondary', 7 * 24 * 60 * 60],
  ] as const) {
    const usedPercent = parseResponseHeaderNumber(
      headers,
      `x-codex-${windowName}-used-percent`,
    )
    if (usedPercent === undefined) continue

    const windowMinutes = parseResponseHeaderNumber(
      headers,
      `x-codex-${windowName}-window-minutes`,
    )
    windows.push({
      label: getCodexUsageWindowLabel(
        windowMinutes !== undefined ? windowMinutes * 60 : undefined,
        fallbackSeconds,
      ),
      usedPercent,
      resetAt: parseCodexResetHeader(headers, windowName),
    })
  }

  return windows
}

function parseAnthropicResponseHeaders(headers: Record<string, string>): QuotaUsageWindow[] {
  const windows: QuotaUsageWindow[] = []

  for (const [windowName, label] of [
    ['5h', '5h'],
    ['7d', 'Week'],
  ] as const) {
    const prefix = `anthropic-ratelimit-unified-${windowName}`
    const utilization = parseResponseHeaderNumber(headers, `${prefix}-utilization`)
    if (utilization === undefined) continue

    windows.push({
      label,
      usedPercent: utilization * 100,
      resetAt: parseAbsoluteResetHeader(getResponseHeader(headers, `${prefix}-reset`)),
    })
  }

  return windows
}

function parseAnthropicResetAt(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? undefined : Math.floor(timestamp / 1000)
}

function parseAnthropicUsageSnapshot(data: unknown): QuotaUsageWindow[] {
  const raw = getRecord(data)
  const fiveHour = getRecord(raw?.five_hour)
  const sevenDay = getRecord(raw?.seven_day)
  const windows: QuotaUsageWindow[] = []

  if (typeof fiveHour?.utilization === 'number') {
    windows.push({
      label: '5h',
      usedPercent: fiveHour.utilization,
      resetAt: parseAnthropicResetAt(fiveHour.resets_at),
    })
  }
  if (typeof sevenDay?.utilization === 'number') {
    windows.push({
      label: 'Week',
      usedPercent: sevenDay.utilization,
      resetAt: parseAnthropicResetAt(sevenDay.resets_at),
    })
  }

  return windows
}

function formatResetShort(resetAt: number | undefined, windowLabel: string): string | undefined {
  if (!resetAt) return undefined

  const diffMs = resetAt * 1000 - Date.now()
  if (diffMs <= 0) return 'now'
  if (/\bWeek$/i.test(windowLabel)) {
    return `${(diffMs / (24 * 60 * 60 * 1000)).toFixed(1)}d`
  }
  if (/\b\d+h$/i.test(windowLabel)) {
    return `${(diffMs / (60 * 60 * 1000)).toFixed(1)}h`
  }

  const totalMinutes = Math.floor(diffMs / 60_000)
  const days = Math.floor(totalMinutes / (60 * 24))
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
  const minutes = totalMinutes % 60

  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`
  return `${minutes}m`
}

async function readResponseError(response: Response): Promise<string> {
  const raw = await response.text()
  if (response.status === 401) {
    return 'Unauthorized - log in again'
  }
  if (!raw) {
    return `HTTP ${response.status}`
  }
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string }; message?: string }
    const message = parsed.error?.message || parsed.message
    if (message) return `HTTP ${response.status}: ${message}`
  } catch {
    // Ignore JSON parse failures and fall back to raw body.
  }
  return `HTTP ${response.status}: ${raw}`
}

function syncRuntimeState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  runtimeState.currentModel = {
    provider: ctx.model?.provider,
    id: ctx.model?.id,
    name: ctx.model?.name,
    reasoning: ctx.model?.reasoning,
  }
  runtimeState.currentDirectory = getCurrentDirectoryName(ctx.sessionManager.getCwd())
  const contextUsage = ctx.getContextUsage()
  runtimeState.contextPercent = contextUsage?.percent ?? null
  runtimeState.contextTokens = contextUsage?.tokens ?? null
  runtimeState.contextWindow = contextUsage?.contextWindow ?? null
  runtimeState.estimatedCodexCacheWriteSurcharge = getEstimatedCodexCacheWriteSurcharge(ctx)
  runtimeState.sessionTotalCost =
    getTotalAssistantCost(ctx) + runtimeState.estimatedCodexCacheWriteSurcharge
  runtimeState.thinkingLevel = ctx.model?.reasoning ? pi.getThinkingLevel() : 'off'
}

function clearRuntimeState(): void {
  runtimeState.currentModel = {}
  runtimeState.currentDirectory = '?'
  runtimeState.contextPercent = null
  runtimeState.contextTokens = null
  runtimeState.contextWindow = null
  runtimeState.sessionTotalCost = 0
  runtimeState.estimatedCodexCacheWriteSurcharge = 0
  runtimeState.thinkingLevel = 'off'
}

function getActiveCodexProvider(): string | undefined {
  const providerName = runtimeState.currentModel.provider
  if (!(providerName && CODEX_PROVIDER.test(providerName))) return undefined
  return providerName
}

function getActiveAnthropicProvider(): string | undefined {
  const providerName = runtimeState.currentModel.provider
  if (!(providerName && ANTHROPIC_PROVIDER.test(providerName))) return undefined
  return providerName
}

function cloneCodexUsage(state: CodexUsageState): CodexUsageState {
  return {
    providerName: state.providerName,
    loading: state.loading,
    fetchedAt: state.fetchedAt,
    error: state.error,
    windows: state.windows.map(window => ({ ...window })),
  }
}

function clearCodexUsage(): void {
  runtimeState.codexUsageAbort?.abort()
  runtimeState.codexUsageAbort = undefined
  if (
    runtimeState.codexUsage.providerName ||
    runtimeState.codexUsage.loading ||
    runtimeState.codexUsage.error ||
    runtimeState.codexUsage.windows.length > 0
  ) {
    runtimeState.codexUsage = { loading: false, windows: [] }
    runtimeState.requestRender?.()
  }
}

function cloneAnthropicUsage(state: AnthropicUsageState): AnthropicUsageState {
  return {
    providerName: state.providerName,
    loading: state.loading,
    fetchedAt: state.fetchedAt,
    error: state.error,
    windows: state.windows.map(window => ({ ...window })),
  }
}

function mergeQuotaWindows(
  currentWindows: QuotaUsageWindow[],
  updatedWindows: QuotaUsageWindow[],
): QuotaUsageWindow[] {
  const updatedLabels = new Set(updatedWindows.map(window => window.label))
  return [
    ...updatedWindows,
    ...currentWindows.filter(window => !updatedLabels.has(window.label)),
  ]
}

function updateCodexUsageFromResponseHeaders(
  providerName: string,
  headers: Record<string, string>,
): void {
  const windows = parseCodexResponseHeaders(headers)
  if (windows.length === 0) return

  runtimeState.codexUsageAbort?.abort()
  runtimeState.codexUsageAbort = undefined
  runtimeState.codexUsageRequestId++
  const current =
    runtimeState.codexUsage.providerName === providerName
      ? runtimeState.codexUsage
      : runtimeState.codexUsageCache.get(providerName)
  const nextState: CodexUsageState = {
    providerName,
    loading: false,
    fetchedAt: Date.now(),
    windows: mergeQuotaWindows(current?.windows ?? [], windows),
  }
  runtimeState.codexUsage = cloneCodexUsage(nextState)
  runtimeState.codexUsageCache.set(providerName, cloneCodexUsage(nextState))
  writeQuotaUsageCache(providerName, nextState)
  runtimeState.requestRender?.()
}

function updateAnthropicUsageFromResponseHeaders(
  providerName: string,
  headers: Record<string, string>,
): void {
  const windows = parseAnthropicResponseHeaders(headers)
  if (windows.length === 0) return

  runtimeState.anthropicUsageAbort?.abort()
  runtimeState.anthropicUsageAbort = undefined
  runtimeState.anthropicUsageRequestId++
  const current =
    runtimeState.anthropicUsage.providerName === providerName
      ? runtimeState.anthropicUsage
      : runtimeState.anthropicUsageCache.get(providerName)
  const nextState: AnthropicUsageState = {
    providerName,
    loading: false,
    fetchedAt: Date.now(),
    windows: mergeQuotaWindows(current?.windows ?? [], windows),
  }
  runtimeState.anthropicUsage = cloneAnthropicUsage(nextState)
  runtimeState.anthropicUsageCache.set(providerName, cloneAnthropicUsage(nextState))
  writeQuotaUsageCache(providerName, nextState)
  runtimeState.requestRender?.()
}

function clearAnthropicUsage(): void {
  runtimeState.anthropicUsageAbort?.abort()
  runtimeState.anthropicUsageAbort = undefined
  if (
    runtimeState.anthropicUsage.providerName ||
    runtimeState.anthropicUsage.loading ||
    runtimeState.anthropicUsage.error ||
    runtimeState.anthropicUsage.windows.length > 0
  ) {
    runtimeState.anthropicUsage = { loading: false, windows: [] }
    runtimeState.requestRender?.()
  }
}

async function refreshCodexUsage(
  ctx: ExtensionContext,
  options: QuotaRefreshOptions = {},
): Promise<void> {
  const providerName = getActiveCodexProvider()
  if (!providerName) {
    clearCodexUsage()
    return
  }

  let cached = runtimeState.codexUsageCache.get(providerName)
  if (!cached) {
    const persisted = readQuotaUsageCache(providerName)
    if (persisted) {
      cached = cloneCodexUsage(persisted)
      runtimeState.codexUsageCache.set(providerName, cached)
    }
  }

  const cacheAge = cached?.fetchedAt ? Date.now() - cached.fetchedAt : undefined
  if (
    cached &&
    (options.allowStaleCache || (cacheAge !== undefined && cacheAge < QUOTA_REFRESH_INTERVAL_MS))
  ) {
    runtimeState.codexUsage = cloneCodexUsage({ ...cached, loading: false })
    runtimeState.requestRender?.()
  }
  if (options.skipFetch) {
    if (!cached) {
      runtimeState.codexUsage = { providerName, loading: false, windows: [] }
      runtimeState.requestRender?.()
    }
    return
  }
  if (cacheAge !== undefined && cacheAge < QUOTA_MIN_REFRESH_INTERVAL_MS) {
    return
  }
  if (!options.force && cacheAge !== undefined && cacheAge < QUOTA_REFRESH_INTERVAL_MS) {
    return
  }

  if (
    !options.force &&
    runtimeState.codexUsage.loading &&
    runtimeState.codexUsage.providerName === providerName
  ) {
    return
  }

  runtimeState.codexUsageAbort?.abort()
  const controller = new AbortController()
  const requestId = ++runtimeState.codexUsageRequestId
  runtimeState.codexUsageAbort = controller
  runtimeState.codexUsage = cached
    ? cloneCodexUsage({ ...cached, loading: true })
    : { providerName, loading: true, windows: [] }
  runtimeState.requestRender?.()

  try {
    const accessToken = await ctx.modelRegistry.getApiKeyForProvider(providerName)
    if (!accessToken) {
      throw new Error('No authentication configured')
    }

    const accountId = getCodexAccountId(accessToken)
    const baseUrl = (process.env.CHATGPT_BASE_URL || DEFAULT_CODEX_USAGE_BASE_URL).replace(
      /\/+$/,
      '',
    )
    const headers = new Headers()
    headers.set('Authorization', `Bearer ${accessToken}`)
    headers.set('Accept', 'application/json')
    headers.set('User-Agent', 'pi-hud-footer')
    if (accountId) {
      headers.set('chatgpt-account-id', accountId)
    }

    const response = await fetch(`${baseUrl}/wham/usage`, {
      method: 'GET',
      headers,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(CODEX_USAGE_TIMEOUT_MS)]),
    })
    if (!response.ok) {
      throw new Error(await readResponseError(response))
    }

    const parsed = parseCodexUsageSnapshot(await response.json())
    if (parsed.windows.length === 0) {
      throw new Error('Usage response contains no rate-limit windows')
    }
    const nextState: CodexUsageState = {
      providerName,
      loading: false,
      fetchedAt: Date.now(),
      windows: parsed.windows,
    }

    if (controller.signal.aborted || requestId !== runtimeState.codexUsageRequestId) return
    if (getActiveCodexProvider() !== providerName) return

    runtimeState.codexUsage = cloneCodexUsage(nextState)
    runtimeState.codexUsageCache.set(providerName, cloneCodexUsage(nextState))
    writeQuotaUsageCache(providerName, nextState)
    runtimeState.requestRender?.()
  } catch (error) {
    if (controller.signal.aborted || requestId !== runtimeState.codexUsageRequestId) return

    const message =
      error instanceof Error && error.cause instanceof Error
        ? `${error.message}: ${error.cause.message}`
        : error instanceof Error
          ? error.message
          : String(error)
    runtimeState.codexUsage = cached
      ? cloneCodexUsage({ ...cached, loading: false, error: message })
      : {
          providerName,
          loading: false,
          fetchedAt: Date.now(),
          error: message,
          windows: [],
        }
    runtimeState.requestRender?.()
  } finally {
    if (runtimeState.codexUsageAbort === controller) {
      runtimeState.codexUsageAbort = undefined
    }
  }
}

async function refreshAnthropicUsage(
  ctx: ExtensionContext,
  options: QuotaRefreshOptions = {},
): Promise<void> {
  const providerName = getActiveAnthropicProvider()
  if (!providerName) {
    clearAnthropicUsage()
    return
  }

  let cached = runtimeState.anthropicUsageCache.get(providerName)
  if (!cached) {
    const persisted = readQuotaUsageCache(providerName)
    if (persisted) {
      cached = cloneAnthropicUsage(persisted)
      runtimeState.anthropicUsageCache.set(providerName, cached)
    }
  }

  const cacheAge = cached?.fetchedAt ? Date.now() - cached.fetchedAt : undefined
  if (
    cached &&
    (options.allowStaleCache || (cacheAge !== undefined && cacheAge < QUOTA_REFRESH_INTERVAL_MS))
  ) {
    runtimeState.anthropicUsage = cloneAnthropicUsage({ ...cached, loading: false })
    runtimeState.requestRender?.()
  }
  if (options.skipFetch) {
    if (!cached) {
      runtimeState.anthropicUsage = { providerName, loading: false, windows: [] }
      runtimeState.requestRender?.()
    }
    return
  }
  if (cacheAge !== undefined && cacheAge < QUOTA_MIN_REFRESH_INTERVAL_MS) {
    return
  }
  if (!options.force && cacheAge !== undefined && cacheAge < QUOTA_REFRESH_INTERVAL_MS) {
    return
  }

  if (
    !options.force &&
    runtimeState.anthropicUsage.loading &&
    runtimeState.anthropicUsage.providerName === providerName
  ) {
    return
  }

  runtimeState.anthropicUsageAbort?.abort()
  const controller = new AbortController()
  const requestId = ++runtimeState.anthropicUsageRequestId
  runtimeState.anthropicUsageAbort = controller
  runtimeState.anthropicUsage = cached
    ? cloneAnthropicUsage({ ...cached, loading: true })
    : { providerName, loading: true, windows: [] }
  runtimeState.requestRender?.()

  try {
    const accessToken = await ctx.modelRegistry.getApiKeyForProvider(providerName)
    if (!accessToken) {
      throw new Error('No authentication configured')
    }

    const headers = new Headers()
    headers.set('Authorization', `Bearer ${accessToken}`)
    headers.set('Accept', 'application/json')
    headers.set('anthropic-beta', 'oauth-2025-04-20')
    headers.set('User-Agent', 'pi-hud-footer')

    const response = await fetch(ANTHROPIC_USAGE_URL, {
      method: 'GET',
      headers,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(ANTHROPIC_USAGE_TIMEOUT_MS)]),
    })
    if (!response.ok) {
      throw new Error(await readResponseError(response))
    }

    const windows = parseAnthropicUsageSnapshot(await response.json())
    if (windows.length === 0) {
      throw new Error('Usage response contains no rate-limit windows')
    }
    const nextState: AnthropicUsageState = {
      providerName,
      loading: false,
      fetchedAt: Date.now(),
      windows,
    }

    if (controller.signal.aborted || requestId !== runtimeState.anthropicUsageRequestId) return
    if (getActiveAnthropicProvider() !== providerName) return

    runtimeState.anthropicUsage = cloneAnthropicUsage(nextState)
    runtimeState.anthropicUsageCache.set(providerName, cloneAnthropicUsage(nextState))
    writeQuotaUsageCache(providerName, nextState)
    runtimeState.requestRender?.()
  } catch (error) {
    if (controller.signal.aborted || requestId !== runtimeState.anthropicUsageRequestId) return

    const message =
      error instanceof Error && error.cause instanceof Error
        ? `${error.message}: ${error.cause.message}`
        : error instanceof Error
          ? error.message
          : String(error)
    runtimeState.anthropicUsage = cached
      ? cloneAnthropicUsage({ ...cached, loading: false, error: message })
      : {
          providerName,
          loading: false,
          fetchedAt: Date.now(),
          error: message,
          windows: [],
        }
    runtimeState.requestRender?.()
  } finally {
    if (runtimeState.anthropicUsageAbort === controller) {
      runtimeState.anthropicUsageAbort = undefined
    }
  }
}

function formatQuotaWindow(theme: Theme, window: QuotaUsageWindow): string {
  const usedPercent = Math.max(0, Math.min(100, Math.round(window.usedPercent)))
  const remainingPercent = 100 - usedPercent
  const color = remainingPercent < 25 ? 'error' : remainingPercent < 50 ? 'warning' : 'muted'
  const reset = formatResetShort(window.resetAt, window.label)
  const label = theme.fg(color, theme.bold(window.label))
  const percentage = theme.fg(color, `${usedPercent}%`)

  return [label, reset ? theme.fg(color, reset) : '', percentage].filter(Boolean).join(' ')
}

function normalizeTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

function getVisibleCodexUsageWindows(windows: QuotaUsageWindow[]): QuotaUsageWindow[] {
  const modelTokens = normalizeTokens(runtimeState.currentModel.id ?? '')
  const isSparkModel = modelTokens.includes('codex') && modelTokens.includes('spark')

  return windows
    .filter(window => {
      const windowTokens = normalizeTokens(window.label)
      const isSparkWindow = windowTokens.includes('codex') && windowTokens.includes('spark')
      return isSparkModel === isSparkWindow
    })
    .map(window => {
      if (!isSparkModel) return window
      const suffix = window.label.trim().split(/\s+/).at(-1)
      return suffix && (/^\d+h$/i.test(suffix) || /^(day|week)$/i.test(suffix))
        ? { ...window, label: suffix }
        : window
    })
}

function buildCodexQuotaSegment(theme: Theme): string {
  const providerName = getActiveCodexProvider()
  if (!providerName) return ''

  const usage = runtimeState.codexUsage
  if (usage.providerName !== providerName || usage.loading) {
    return theme.fg('dim', 'quota…')
  }

  const windows = getVisibleCodexUsageWindows(usage.windows)
  if (windows.length === 0) {
    return theme.fg('warning', 'quota?')
  }

  const formatted = windows
    .map(window => formatQuotaWindow(theme, window))
    .join(theme.fg('dim', ' │ '))
  return usage.error ? `${theme.fg('warning', '⚠')} ${formatted}` : formatted
}

function buildAnthropicQuotaSegment(theme: Theme): string {
  const providerName = getActiveAnthropicProvider()
  if (!providerName) return ''

  const usage = runtimeState.anthropicUsage
  if (usage.providerName !== providerName || usage.loading) {
    return theme.fg('dim', 'quota…')
  }
  if (usage.windows.length === 0) {
    return theme.fg('warning', 'quota?')
  }

  const formatted = usage.windows
    .map(window => formatQuotaWindow(theme, window))
    .join(theme.fg('dim', ' │ '))
  return usage.error ? `${theme.fg('warning', '⚠')} ${formatted}` : formatted
}

async function refreshQuotaUsage(
  ctx: ExtensionContext,
  options: QuotaRefreshOptions = {},
): Promise<void> {
  try {
    await Promise.all([refreshCodexUsage(ctx, options), refreshAnthropicUsage(ctx, options)])
  } finally {
    if (!options.skipFetch) {
      runtimeState.lastQuotaRefreshAt = Date.now()
    }
  }
}

function startQuotaRefreshTimer(ctx: ExtensionContext): void {
  if (runtimeState.quotaRefreshTimer) {
    clearInterval(runtimeState.quotaRefreshTimer)
  }
  runtimeState.quotaRefreshTimer = setInterval(() => {
    const elapsed = runtimeState.lastQuotaRefreshAt
      ? Date.now() - runtimeState.lastQuotaRefreshAt
      : QUOTA_REFRESH_INTERVAL_MS + 1
    if (elapsed >= QUOTA_REFRESH_INTERVAL_MS) {
      void refreshQuotaUsage(ctx)
    }
  }, QUOTA_REFRESH_TICK_MS)
  runtimeState.quotaRefreshTimer.unref()
}

function buildFooterLine(theme: Theme, branch: string | null, statuses: FooterStatuses): string {
  const provider = truncateToWidth(runtimeState.currentModel.provider ?? 'no provider', 18, '…')
  const model = truncateToWidth(
    runtimeState.currentModel.name ?? runtimeState.currentModel.id ?? 'no model',
    28,
    '…',
  )
  const sessionTotalCostSegment = buildSessionTotalCostSegment(theme)
  const quotaSegment = buildCodexQuotaSegment(theme) || buildAnthropicQuotaSegment(theme)
  const idleTimerSegment = buildIdleTimerSegment(theme)

  const segments = [
    `${theme.fg('dim', '⌂ ')}${theme.fg('accent', theme.bold(runtimeState.currentDirectory))}`,
    branch ? `${theme.fg('dim', '⎇ ')}${theme.fg('dim', truncateToWidth(branch, 24, '…'))}` : '',
    styleContextUsage(
      theme,
      runtimeState.contextPercent,
      runtimeState.contextTokens,
      runtimeState.contextWindow,
    ),
    theme.fg('dim', provider),
    theme.bold(model),
    theme.fg(getThinkingColor(runtimeState.thinkingLevel), theme.bold(runtimeState.thinkingLevel)),
    quotaSegment,
    statuses.sandboxActive ? theme.fg('accent', '🔒') : '',
    ...statuses.others,
    sessionTotalCostSegment,
    idleTimerSegment,
  ]

  return joinSegments(theme, segments)
}

function buildFooter(pi: ExtensionAPI, ctx: ExtensionContext): void {
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender())
    const requestRender = () => tui.requestRender()
    runtimeState.requestRender = requestRender

    return {
      dispose() {
        unsubscribeBranch()
        if (runtimeState.requestRender === requestRender) {
          runtimeState.requestRender = undefined
        }
      },
      invalidate() {},
      render(width: number): string[] {
        syncRuntimeState(pi, ctx)
        const branch = footerData.getGitBranch()
        const providerName = runtimeState.currentModel.provider
        const statuses = getFooterStatuses(
          Array.from(footerData.getExtensionStatuses().entries()).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
          providerName,
        )

        return [
          truncateToWidth(buildFooterLine(theme, branch, statuses), width, theme.fg('dim', '…')),
        ]
      },
    }
  })
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    stopIdleTimer()
    syncRuntimeState(pi, ctx)
    if (!ctx.hasUI) return
    buildFooter(pi, ctx)
    void refreshQuotaUsage(ctx, { allowStaleCache: true, skipFetch: true })
    startQuotaRefreshTimer(ctx)
  })

  pi.on('model_select', async (_event, ctx) => {
    syncRuntimeState(pi, ctx)
    if (!ctx.hasUI) return
    buildFooter(pi, ctx)
    void refreshQuotaUsage(ctx, { force: true, allowStaleCache: true })
  })

  pi.on('before_agent_start', () => {
    stopIdleTimer()
  })

  pi.on('agent_start', () => {
    stopIdleTimer()
  })

  pi.on('after_provider_response', (event, ctx) => {
    if (!ctx.hasUI) return

    const providerName = ctx.model?.provider
    if (providerName && CODEX_PROVIDER.test(providerName)) {
      updateCodexUsageFromResponseHeaders(providerName, event.headers)
    } else if (providerName && ANTHROPIC_PROVIDER.test(providerName)) {
      updateAnthropicUsageFromResponseHeaders(providerName, event.headers)
    }
  })

  pi.on('agent_settled', (_event, ctx) => {
    if (!ctx.hasUI) return
    startIdleTimer()
  })

  pi.on('turn_end', async (_event, ctx) => {
    syncRuntimeState(pi, ctx)
    if (!ctx.hasUI) return
    await refreshQuotaUsage(ctx, { force: true })
    runtimeState.requestRender?.()
  })

  pi.on('session_tree', async (_event, ctx) => {
    syncRuntimeState(pi, ctx)
    if (!ctx.hasUI) return
    await refreshQuotaUsage(ctx)
    runtimeState.requestRender?.()
  })

  pi.on('session_compact', async (_event, ctx) => {
    syncRuntimeState(pi, ctx)
    if (!ctx.hasUI) return
    runtimeState.requestRender?.()
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    stopIdleTimer()
    if (ctx.hasUI) {
      ctx.ui.setFooter(undefined)
    }
    if (runtimeState.quotaRefreshTimer) {
      clearInterval(runtimeState.quotaRefreshTimer)
      runtimeState.quotaRefreshTimer = undefined
    }
    runtimeState.lastQuotaRefreshAt = undefined
    clearCodexUsage()
    clearAnthropicUsage()
    clearRuntimeState()
    runtimeState.requestRender = undefined
  })
}
