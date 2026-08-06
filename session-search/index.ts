import { createReadStream, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { FileFinder, type GrepMatch } from '@ff-labs/fff-node'
import { Type } from 'typebox'

type SessionHeader = {
  type?: string
  id?: string
  timestamp?: string
  cwd?: string
}

type SessionEntry = {
  type?: string
  id?: string
  timestamp?: string
  message?: {
    role?: string
    content?: unknown
    toolName?: string
    command?: string
    output?: string
    summary?: string
  }
  summary?: string
  content?: unknown
  customType?: string
  targetId?: string
  label?: string
  provider?: string
  modelId?: string
  thinkingLevel?: string
}

type SearchArgs = {
  query: string
  caseSensitive: boolean
}

type ToolSearchArgs = SearchArgs & {
  maxResults: number
}

type HydratedMatch = {
  match: GrepMatch
  absolutePath: string
  rawLine: string
  entry: SessionEntry | null
  header: SessionHeader | null
  role: string
  text: string
  snippet: string
}

type FinderState = {
  basePath: string
  finder: FileFinder
}

const SCAN_TIMEOUT_MS = 30_000
const MAX_SESSION_FILE_SIZE = 1024 * 1024 * 1024

let finderState: FinderState | null = null
let finderPromise: Promise<FileFinder> | null = null

function expandHomePath(value: string): string {
  if (value === '~') {
    return homedir()
  }
  if (value.startsWith('~/')) {
    return join(homedir(), value.slice(2))
  }
  return value
}

function resolvePath(value: string, cwd: string): string {
  const expanded = expandHomePath(value)
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
}

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR
    ? resolvePath(process.env.PI_CODING_AGENT_DIR, process.cwd())
    : join(homedir(), '.pi', 'agent')
}

function configuredSessionDir(ctx: ExtensionCommandContext): string {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) {
    return resolvePath(process.env.PI_CODING_AGENT_SESSION_DIR, ctx.cwd)
  }

  try {
    const settings = JSON.parse(readFileSync(join(getAgentDir(), 'settings.json'), 'utf8')) as {
      sessionDir?: unknown
    }
    if (typeof settings.sessionDir === 'string' && settings.sessionDir.trim()) {
      return resolvePath(settings.sessionDir, ctx.cwd)
    }
  } catch {
    // Missing or invalid settings do not change pi's documented default session dir.
  }

  return join(getAgentDir(), 'sessions')
}

function resolveSessionsDir(ctx: ExtensionCommandContext): string {
  if (ctx.sessionManager.isPersisted()) {
    return resolvePath(ctx.sessionManager.getSessionDir(), ctx.cwd)
  }

  return configuredSessionDir(ctx)
}

async function ensureFinder(basePath: string): Promise<FileFinder> {
  if (finderState?.basePath === basePath && !finderState.finder.isDestroyed) {
    return finderState.finder
  }

  if (finderPromise) {
    return finderPromise
  }

  finderPromise = (async () => {
    if (finderState && !finderState.finder.isDestroyed) {
      finderState.finder.destroy()
      finderState = null
    }

    const created = FileFinder.create({
      basePath,
      disableWatch: true,
      disableMmapCache: true,
      disableContentIndexing: true,
    })

    if (!created.ok) {
      throw new Error(created.error)
    }

    const finder = created.value
    const scan = await finder.waitForScan(SCAN_TIMEOUT_MS)
    if (!scan.ok) {
      finder.destroy()
      throw new Error(scan.error)
    }
    if (!scan.value) {
      finder.destroy()
      throw new Error(`Timed out scanning sessions after ${SCAN_TIMEOUT_MS}ms`)
    }

    finderState = { basePath, finder }
    return finder
  })().finally(() => {
    finderPromise = null
  })

  return finderPromise
}

async function rescan(finder: FileFinder): Promise<void> {
  const started = finder.scanFiles()
  if (!started.ok) {
    throw new Error(started.error)
  }

  const scan = await finder.waitForScan(SCAN_TIMEOUT_MS)
  if (!scan.ok) {
    throw new Error(scan.error)
  }
  if (!scan.value) {
    throw new Error(`Timed out rescanning sessions after ${SCAN_TIMEOUT_MS}ms`)
  }
}

function parseJsonLine<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T
  } catch {
    return null
  }
}

async function readSelectedLines(
  filePath: string,
  lineNumbers: number[],
): Promise<Map<number, string>> {
  const needed = new Set(lineNumbers.filter(line => line > 0))
  const lines = new Map<number, string>()
  if (needed.size === 0) {
    return lines
  }

  const maxLine = Math.max(...needed)
  const reader = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  let current = 0
  try {
    for await (const line of reader) {
      current += 1
      if (needed.has(current)) {
        lines.set(current, line)
        if (lines.size === needed.size) {
          break
        }
      }
      if (current >= maxLine) {
        break
      }
    }
  } finally {
    reader.close()
  }

  return lines
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue
    }

    const value = block as Record<string, unknown>
    if (value.type === 'text' && typeof value.text === 'string') {
      parts.push(value.text)
    } else if (value.type === 'thinking' && typeof value.thinking === 'string') {
      parts.push(`[thinking] ${value.thinking}`)
    } else if (value.type === 'toolCall' && typeof value.name === 'string') {
      parts.push(`[tool:${value.name}] ${JSON.stringify(value.arguments ?? {})}`)
    } else if (value.type === 'image') {
      parts.push(`[image:${String(value.mimeType ?? 'unknown')}]`)
    }
  }

  return parts.join('\n')
}

function entryRole(entry: SessionEntry | null): string {
  if (!entry) {
    return 'json'
  }

  if (entry.type === 'message') {
    const role = entry.message?.role ?? 'message'
    return entry.message?.toolName ? `${role}:${entry.message.toolName}` : role
  }

  if (entry.type === 'custom' && entry.customType) {
    return `custom:${entry.customType}`
  }

  if (entry.type === 'custom_message' && entry.customType) {
    return `custom_message:${entry.customType}`
  }

  return entry.type ?? 'entry'
}

function entryText(entry: SessionEntry | null, rawLine: string): string {
  if (!entry) {
    return rawLine
  }

  if (entry.type === 'message' && entry.message) {
    const message = entry.message
    const contentText = contentToText(message.content)
    if (contentText) {
      return contentText
    }

    if (message.role === 'bashExecution') {
      return [message.command, message.output].filter(Boolean).join('\n')
    }

    if (typeof message.summary === 'string') {
      return message.summary
    }
  }

  if (typeof entry.summary === 'string') {
    return entry.summary
  }

  const customContent = contentToText(entry.content)
  if (customContent) {
    return customContent
  }

  if (entry.type === 'model_change') {
    return [entry.provider, entry.modelId].filter(Boolean).join('/')
  }

  if (entry.type === 'thinking_level_change') {
    return entry.thinkingLevel ?? rawLine
  }

  if (entry.type === 'label') {
    return `${entry.label ?? '<cleared>'} → ${entry.targetId ?? 'unknown'}`
  }

  return rawLine
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`
}

function makeSnippet(text: string, query: string, caseSensitive: boolean, maxLength = 150): string {
  const normalizedText = caseSensitive ? text : text.toLowerCase()
  const normalizedQuery = caseSensitive ? query : query.toLowerCase()
  const index = normalizedText.indexOf(normalizedQuery)

  if (index < 0) {
    return truncate(oneLine(text), maxLength)
  }

  const start = Math.max(0, index - 45)
  const end = Math.min(text.length, index + query.length + 90)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return truncate(oneLine(`${prefix}${text.slice(start, end)}${suffix}`), maxLength)
}

function sessionLabel(header: SessionHeader | null, relativePath: string): string {
  if (header?.cwd) {
    return basename(header.cwd) || header.cwd
  }

  const sessionDir = relativePath.split('/')[0] ?? relativePath
  return truncate(sessionDir, 40)
}

function formatTimestamp(value: string | undefined): string {
  if (!value) {
    return 'unknown time'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toISOString().slice(0, 16).replace('T', ' ')
}

function formatResult(match: HydratedMatch, index: number): string {
  const project = sessionLabel(match.header, match.match.relativePath)
  const timestamp = formatTimestamp(match.entry?.timestamp ?? match.header?.timestamp)
  return truncate(
    `${index + 1}. ${timestamp} · ${project} · ${match.role} · line ${match.match.lineNumber} · ${match.snippet}`,
    240,
  )
}

async function hydrateMatches(
  matches: GrepMatch[],
  sessionsDir: string,
  args: SearchArgs,
): Promise<HydratedMatch[]> {
  const lineRequests = new Map<string, Set<number>>()

  for (const match of matches) {
    const absolutePath = join(sessionsDir, match.relativePath)
    let requested = lineRequests.get(absolutePath)
    if (!requested) {
      requested = new Set<number>([1])
      lineRequests.set(absolutePath, requested)
    }
    requested.add(match.lineNumber)
  }

  const fileLines = new Map<string, Map<number, string>>()
  await Promise.all(
    [...lineRequests.entries()].map(async ([filePath, lines]) => {
      try {
        fileLines.set(filePath, await readSelectedLines(filePath, [...lines]))
      } catch {
        fileLines.set(filePath, new Map())
      }
    }),
  )

  return matches.map(match => {
    const absolutePath = join(sessionsDir, match.relativePath)
    const lines = fileLines.get(absolutePath) ?? new Map<number, string>()
    const rawLine = lines.get(match.lineNumber) ?? match.lineContent
    const header = parseJsonLine<SessionHeader>(lines.get(1) ?? '')
    const entry = parseJsonLine<SessionEntry>(rawLine)
    const text = entryText(entry, rawLine)

    return {
      match,
      absolutePath,
      rawLine,
      entry,
      header: header?.type === 'session' ? header : null,
      role: entryRole(entry),
      text,
      snippet: makeSnippet(text || rawLine, args.query, args.caseSensitive),
    }
  })
}

async function searchSessionsForTool(
  args: ToolSearchArgs,
  ctx: ExtensionCommandContext,
): Promise<string> {
  const sessionsDir = resolveSessionsDir(ctx)
  const finder = await ensureFinder(sessionsDir)
  await rescan(finder)

  const grep = finder.grep(args.caseSensitive ? args.query : args.query.toLowerCase(), {
    mode: 'plain',
    smartCase: !args.caseSensitive,
    cursor: null,
    pageSize: args.maxResults,
    maxFileSize: MAX_SESSION_FILE_SIZE,
  })

  if (!grep.ok) {
    throw new Error(grep.error)
  }

  const hydrated = await hydrateMatches(grep.value.items, sessionsDir, args)
  if (hydrated.length === 0) {
    return `No session matches for: ${args.query}`
  }

  return hydrated
    .map(
      (match, index) =>
        `${formatResult(match, index)}\n${match.absolutePath}:${match.match.lineNumber}`,
    )
    .join('\n\n')
}

export default function sessionSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'sessions-search',
    label: 'Sessions',
    description: 'Search pi sessions. use only if explicitely requested by user.',
    parameters: Type.Object({
      query: Type.String(),
      caseSensitive: Type.Optional(Type.Boolean()),
      maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = await searchSessionsForTool(
        {
          query: params.query,
          caseSensitive: params.caseSensitive ?? false,
          maxResults: params.maxResults ?? 10,
        },
        ctx,
      )
      return { content: [{ type: 'text', text }] }
    },
  })

  pi.on('session_shutdown', async () => {
    if (finderState && !finderState.finder.isDestroyed) {
      finderState.finder.destroy()
    }
    finderState = null
  })
}
