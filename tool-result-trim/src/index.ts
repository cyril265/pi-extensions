import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import registerBashTrim, {
  DEFAULT_HEAD_RATIO,
  DEFAULT_MAX_LINE_WIDTH,
  DEFAULT_MAX_TOTAL_TOKENS,
  DEFAULT_MIN_TOKENS_TO_TRIM,
  DEFAULT_TRIMMED_WIDTH,
  type TrimOptions,
  type TrimResult,
  trimOutput,
} from 'pi-bash-trim'

type TextContentBlock = {
  type: 'text'
  text: string
}

type ToolResultTrimConfig = {
  trimOptions: TrimOptions
  includeTools?: string[]
  excludeTools: string[]
}

type ToolResultTextPlan = {
  blockIndex: number
  trimResult: TrimResult
  suffix: string
}

const CONFIG_FILE_NAME = 'pi-tool-result-trim.json'
const BASH_TOOL_NAME = 'bash'
const READ_TOOL_NAME = 'read'
const ALWAYS_EXCLUDED_TOOL_NAMES = [BASH_TOOL_NAME, READ_TOOL_NAME]
const DEFAULT_MIN_DEDUP_LINES = 4
const DEFAULT_CONFIG: ToolResultTrimConfig = {
  trimOptions: {
    maxLineWidth: DEFAULT_MAX_LINE_WIDTH,
    trimmedWidth: DEFAULT_TRIMMED_WIDTH,
    headRatio: DEFAULT_HEAD_RATIO,
    maxTotalTokens: DEFAULT_MAX_TOTAL_TOKENS,
    minTokensToTrim: DEFAULT_MIN_TOKENS_TO_TRIM,
    minDedupLines: DEFAULT_MIN_DEDUP_LINES,
  },
  excludeTools: ALWAYS_EXCLUDED_TOOL_NAMES,
}

let tempCounter = 0

export default function (pi: ExtensionAPI) {
  registerBashTrimExtension(pi)

  const config = loadConfig()

  pi.on('tool_result', async event => {
    if (!shouldTrimTool(config, event.toolName)) return

    const textBlocks = event.content.filter(isTextContentBlock)
    const existingFullTextPath =
      textBlocks.length === 1 ? extractFullOutputPath(event.details) : undefined
    const existingFullText = existingFullTextPath
      ? await readExistingFullOutput(existingFullTextPath)
      : undefined
    const plans: ToolResultTextPlan[] = []

    for (let blockIndex = 0; blockIndex < event.content.length; blockIndex += 1) {
      const block = event.content[blockIndex]
      if (!isTextContentBlock(block)) continue
      if (block.text.trim().length === 0 || block.text === '(no output)') continue

      const suffix = extractExitCodeSuffix(block.text)
      const sourceText = existingFullText ?? removeSuffix(block.text, suffix)
      const trimResult = trimOutput(sourceText, config.trimOptions)
      if (!wasTrimmed(trimResult)) continue

      plans.push({ blockIndex, trimResult, suffix })
    }

    if (plans.length === 0) return

    const fullTextPath =
      existingFullText !== undefined && existingFullTextPath
        ? existingFullTextPath
        : await writeFullText(
            event.toolName,
            buildFullTextFile(event.toolName, event.toolCallId, event.content),
          )

    const content = event.content.map((block, blockIndex) => {
      const plan = plans.find(item => item.blockIndex === blockIndex)
      if (!(plan && isTextContentBlock(block))) return block

      return {
        ...block,
        text: `${formatHeader(plan.trimResult, fullTextPath)}\n${plan.trimResult.text}${plan.suffix}`,
      }
    })

    return { content }
  })
}

function registerBashTrimExtension(pi: ExtensionAPI): void {
  const register = registerBashTrim as unknown as (pi: ExtensionAPI) => void
  register(pi)
}

function shouldTrimTool(config: ToolResultTrimConfig, toolName: string): boolean {
  if (config.includeTools && !config.includeTools.includes(toolName)) return false
  return !config.excludeTools.includes(toolName)
}

function wasTrimmed(result: TrimResult): boolean {
  return result.columnsTrimmed || result.rowsTrimmed || result.dedupedLines > 0
}

function formatHeader(result: TrimResult, fullTextPath: string): string {
  const parts: string[] = []
  if (result.dedupedLines > 0) parts.push(`${result.dedupedLines} repetitive lines collapsed`)
  if (result.rowsTrimmed) parts.push(`${result.omittedLines} lines omitted`)
  if (result.columnsTrimmed) parts.push('long lines shortened with [...]')

  return `[Tool result trimmed: ${parts.join(', ')}. Full text: ${fullTextPath}]`
}

function extractExitCodeSuffix(text: string): string {
  const match = text.match(/\n\nCommand exited with code \d+$/)
  return match?.[0] ?? ''
}

function removeSuffix(text: string, suffix: string): string {
  if (!suffix) return text
  return text.slice(0, text.length - suffix.length)
}

function isTextContentBlock(block: unknown): block is TextContentBlock {
  return isRecord(block) && block.type === 'text' && typeof block.text === 'string'
}

function buildFullTextFile(
  toolName: string,
  toolCallId: string,
  content: readonly unknown[],
): string {
  const textBlocks = content.filter(isTextContentBlock)
  if (textBlocks.length === 1) {
    const block = textBlocks[0]
    return block ? block.text : ''
  }

  const sections = [`Tool result: ${toolName}`, `Tool call ID: ${toolCallId}`]
  for (let index = 0; index < textBlocks.length; index += 1) {
    const block = textBlocks[index]
    if (!block) continue
    sections.push(`--- text block ${index + 1} ---\n${block.text}`)
  }
  return `${sections.join('\n\n')}\n`
}

async function readExistingFullOutput(fullOutputPath: string): Promise<string | undefined> {
  try {
    return await readFile(fullOutputPath, 'utf-8')
  } catch {
    return undefined
  }
}

function extractFullOutputPath(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined
  return typeof details.fullOutputPath === 'string' ? details.fullOutputPath : undefined
}

async function writeFullText(toolName: string, text: string): Promise<string> {
  const path = join(
    tmpdir(),
    `pi-tool-result-trim-${process.pid}-${++tempCounter}-${safeFileSegment(toolName)}.txt`,
  )
  await writeFile(path, text, 'utf-8')
  return path
}

function loadConfig(): ToolResultTrimConfig {
  const path = configPath()
  let raw: unknown

  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return DEFAULT_CONFIG
    throw new Error(`pi-tool-result-trim: failed to read config at ${path}: ${errorMessage(error)}`)
  }

  if (!isRecord(raw)) {
    throw new Error(`pi-tool-result-trim: invalid config at ${path}: expected an object`)
  }

  return {
    trimOptions: {
      maxLineWidth: readPositiveInteger(
        raw,
        'maxLineWidth',
        DEFAULT_CONFIG.trimOptions.maxLineWidth,
        path,
      ),
      trimmedWidth: readPositiveInteger(
        raw,
        'trimmedWidth',
        DEFAULT_CONFIG.trimOptions.trimmedWidth,
        path,
      ),
      headRatio: readRatio(raw, 'headRatio', DEFAULT_CONFIG.trimOptions.headRatio, path),
      maxTotalTokens: readPositiveInteger(
        raw,
        'maxTotalTokens',
        DEFAULT_CONFIG.trimOptions.maxTotalTokens,
        path,
      ),
      minTokensToTrim: readNonNegativeInteger(
        raw,
        'minTokensToTrim',
        DEFAULT_CONFIG.trimOptions.minTokensToTrim,
        path,
      ),
      minDedupLines: readPositiveInteger(
        raw,
        'minDedupLines',
        DEFAULT_CONFIG.trimOptions.minDedupLines,
        path,
      ),
    },
    includeTools: readOptionalStringArray(raw, 'includeTools', path),
    excludeTools: withAlwaysExcludedTools(
      readStringArray(raw, 'excludeTools', DEFAULT_CONFIG.excludeTools, path),
    ),
  }
}

function withAlwaysExcludedTools(excludeTools: string[]): string[] {
  const missingToolNames = ALWAYS_EXCLUDED_TOOL_NAMES.filter(
    toolName => !excludeTools.includes(toolName),
  )
  return [...excludeTools, ...missingToolNames]
}

function configPath(): string {
  return join(agentDir(), 'extensions', CONFIG_FILE_NAME)
}

function agentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR
  return envDir ? expandHome(envDir) : join(homedir(), '.pi', 'agent')
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function readPositiveInteger(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  path: string,
): number {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  throw invalidConfig(path, key, 'expected a positive integer')
}

function readNonNegativeInteger(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  path: string,
): number {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  throw invalidConfig(path, key, 'expected a non-negative integer')
}

function readRatio(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  path: string,
): number {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value === 'number' && value >= 0 && value <= 1) return value
  throw invalidConfig(path, key, 'expected a number between 0 and 1')
}

function readOptionalStringArray(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): string[] | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  return parseStringArray(value, path, key)
}

function readStringArray(
  raw: Record<string, unknown>,
  key: string,
  fallback: string[],
  path: string,
): string[] {
  const value = raw[key]
  if (value === undefined) return fallback
  return parseStringArray(value, path, key)
}

function parseStringArray(value: unknown, path: string, key: string): string[] {
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value
  throw invalidConfig(path, key, 'expected an array of strings')
}

function invalidConfig(path: string, key: string, reason: string): Error {
  return new Error(`pi-tool-result-trim: invalid config at ${path}: ${key} ${reason}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeFileSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe || 'tool'
}
