import { dedup } from './dedup.ts'

export const DEFAULT_MAX_LINE_WIDTH = 180
export const DEFAULT_TRIMMED_WIDTH = 150
export const DEFAULT_HEAD_RATIO = 0.8
export const DEFAULT_MAX_TOTAL_TOKENS = 2000
export const DEFAULT_MIN_TOKENS_TO_TRIM = 200
export const DEFAULT_MIN_DEDUP_LINES = 4

const CHARS_PER_TOKEN = 4
const LINE_TRIM_MARKER = ' [...] '

export type TrimOptions = {
  maxLineWidth: number
  trimmedWidth: number
  headRatio: number
  maxTotalTokens: number
  minTokensToTrim: number
  minDedupLines: number
}

export type TrimResult = {
  text: string
  columnsTrimmed: boolean
  rowsTrimmed: boolean
  dedupedLines: number
  omittedLines: number
}

type Line = {
  text: string
  trimmed: boolean
}

type RowTrim = {
  lines: Line[]
  omittedLines: number
}

export function trimOutput(output: string, options: TrimOptions): TrimResult {
  if (output.length < options.minTokensToTrim * CHARS_PER_TOKEN) {
    return {
      text: output,
      columnsTrimmed: false,
      rowsTrimmed: false,
      dedupedLines: 0,
      omittedLines: 0,
    }
  }

  const maxChars = options.maxTotalTokens * CHARS_PER_TOKEN
  const lines = output.split('\n').map(line => trimLine(line, options))
  let rows = trimRows(lines, maxChars)
  let dedupedLines = 0

  if (rows.omittedLines > 0) {
    const deduped = dedup(
      lines.map(line => line.text),
      options.minDedupLines,
    )
    if (deduped.dedupedLines > 0) {
      dedupedLines = deduped.dedupedLines
      rows = trimRows(
        deduped.lines.map((text, index) => {
          const source = deduped.sources[index]
          return { text, trimmed: source !== undefined && lines[source]?.trimmed === true }
        }),
        maxChars,
      )
    }
  }

  return {
    text: rows.lines.map(line => line.text).join('\n'),
    columnsTrimmed: rows.lines.some(line => line.trimmed),
    rowsTrimmed: rows.omittedLines > 0,
    dedupedLines,
    omittedLines: rows.omittedLines,
  }
}

export function wasTrimmed(result: TrimResult): boolean {
  return result.columnsTrimmed || result.rowsTrimmed || result.dedupedLines > 0
}

export function describeTrim(result: TrimResult): string {
  const parts: string[] = []
  if (result.dedupedLines > 0) parts.push(`${result.dedupedLines} repetitive lines collapsed`)
  if (result.rowsTrimmed) parts.push(`${result.omittedLines} lines omitted`)
  if (result.columnsTrimmed) parts.push('long lines shortened with [...]')
  return parts.join(', ')
}

function trimLine(text: string, options: TrimOptions): Line {
  if (text.length <= options.maxLineWidth) return { text, trimmed: false }

  const headLength = Math.round(options.trimmedWidth * options.headRatio)
  const tailLength = Math.round(options.trimmedWidth * (1 - options.headRatio))
  if (headLength + LINE_TRIM_MARKER.length + tailLength >= text.length) {
    return { text, trimmed: false }
  }

  const head = text.slice(0, codePointBoundary(text, headLength))
  const tail = text.slice(codePointBoundary(text, text.length - tailLength))
  return { text: `${head}${LINE_TRIM_MARKER}${tail}`, trimmed: true }
}

function codePointBoundary(text: string, index: number): number {
  const code = text.charCodeAt(index)
  return index > 0 && code >= 0xdc_00 && code <= 0xdf_ff ? index - 1 : index
}

function trimRows(lines: Line[], maxChars: number): RowTrim {
  const totalChars = lines.reduce((sum, line) => sum + line.text.length, 0) + lines.length - 1
  if (totalChars <= maxChars) return { lines, omittedLines: 0 }

  const budget = Math.floor(maxChars / 2)
  let headEnd = 0
  let headChars = 0
  while (headEnd < lines.length) {
    const cost = (lines[headEnd]?.text.length ?? 0) + (headEnd > 0 ? 1 : 0)
    if (headChars + cost > budget) break
    headChars += cost
    headEnd += 1
  }

  let tailStart = lines.length
  let tailChars = 0
  while (tailStart > headEnd) {
    const cost = (lines[tailStart - 1]?.text.length ?? 0) + 1
    if (tailChars + cost > budget) break
    tailChars += cost
    tailStart -= 1
  }

  headEnd = Math.max(headEnd, 1)
  tailStart = Math.min(tailStart, lines.length - 1)
  if (tailStart <= headEnd) return { lines, omittedLines: 0 }

  const omittedLines = tailStart - headEnd
  return {
    lines: [
      ...lines.slice(0, headEnd),
      { text: `[... ${omittedLines} lines omitted ...]`, trimmed: false },
      ...lines.slice(tailStart),
    ],
    omittedLines,
  }
}
