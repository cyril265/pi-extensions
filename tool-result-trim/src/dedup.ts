type Token = {
  text: string
  isNumber: boolean
}

type Slot = { type: 'fixed'; text: string } | { type: 'number-var' }

type Pattern = {
  prefix: Slot[]
  suffix: Slot[]
  hasMiddle: boolean
}

export type DedupResult = {
  lines: string[]
  sources: Array<number | undefined>
  dedupedLines: number
}

const MIN_MATCH_CHARS = 15
const MIN_MATCH_RATIO = 0.5
const MAX_LENGTH_RATIO = 1.5

export function dedup(lines: readonly string[], minRun: number): DedupResult {
  if (lines.length < minRun) {
    return { lines: [...lines], sources: lines.map((_, index) => index), dedupedLines: 0 }
  }

  const tokens = lines.map(tokenize)
  const result: string[] = []
  const sources: Array<number | undefined> = []
  let dedupedLines = 0
  let index = 0

  while (index < lines.length) {
    const pattern =
      index + 1 < lines.length
        ? extractPattern(
            tokens[index] ?? [],
            tokens[index + 1] ?? [],
            lineLength(lines, index),
            lineLength(lines, index + 1),
          )
        : null

    if (!pattern) {
      result.push(lines[index] ?? '')
      sources.push(index)
      index += 1
      continue
    }

    let runEnd = index + 2
    while (runEnd < lines.length && matchesPattern(tokens[runEnd] ?? [], pattern)) runEnd += 1

    const runLength = runEnd - index
    if (runLength < minRun) {
      for (let line = index; line < runEnd; line += 1) {
        result.push(lines[line] ?? '')
        sources.push(line)
      }
      index = runEnd
      continue
    }

    const collapsed = runLength - 1
    result.push(lines[index] ?? '', `[× ${collapsed} similar: ${formatPattern(pattern)}]`)
    sources.push(index, undefined)
    dedupedLines += collapsed
    index = runEnd
  }

  return { lines: result, sources, dedupedLines }
}

function lineLength(lines: readonly string[], index: number): number {
  return lines[index]?.length ?? 0
}

function tokenize(line: string): Token[] {
  const result: Token[] = []
  for (const match of line.matchAll(/[a-zA-Z_]+|\d+|\s+|./g)) {
    result.push({ text: match[0], isNumber: /^\d+$/.test(match[0]) })
  }
  return result
}

function extractPattern(
  first: Token[],
  second: Token[],
  firstLength: number,
  secondLength: number,
): Pattern | null {
  const maxLength = Math.max(firstLength, secondLength)
  const minLength = Math.min(firstLength, secondLength)
  if (maxLength === 0) return null
  if (minLength > 0 && maxLength / minLength > MAX_LENGTH_RATIO) return null

  const prefix: Slot[] = []
  while (prefix.length < first.length && prefix.length < second.length) {
    const slot = matchSlot(first[prefix.length], second[prefix.length])
    if (!slot) break
    prefix.push(slot)
  }

  const suffix: Slot[] = []
  while (
    suffix.length < first.length - prefix.length &&
    suffix.length < second.length - prefix.length
  ) {
    const slot = matchSlot(
      first[first.length - 1 - suffix.length],
      second[second.length - 1 - suffix.length],
    )
    if (!slot) break
    suffix.push(slot)
  }

  const hasMiddle =
    first.length - prefix.length - suffix.length > 0 ||
    second.length - prefix.length - suffix.length > 0
  const fixedChars = [...prefix, ...suffix].reduce(
    (sum, slot) => sum + (slot.type === 'fixed' ? slot.text.length : 0),
    0,
  )
  if (fixedChars < MIN_MATCH_CHARS) return null
  if (fixedChars / maxLength < MIN_MATCH_RATIO) return null

  return { prefix, suffix, hasMiddle }
}

function matchSlot(first: Token | undefined, second: Token | undefined): Slot | undefined {
  if (!(first && second)) return undefined
  if (first.text === second.text) return { type: 'fixed', text: first.text }
  if (first.isNumber && second.isNumber) return { type: 'number-var' }
  return undefined
}

function matchesPattern(tokens: Token[], pattern: Pattern): boolean {
  const fixedLength = pattern.prefix.length + pattern.suffix.length
  if (pattern.hasMiddle ? tokens.length < fixedLength : tokens.length !== fixedLength) return false
  return (
    pattern.prefix.every((slot, index) => slotMatches(slot, tokens[index])) &&
    pattern.suffix.every((slot, index) => slotMatches(slot, tokens[tokens.length - 1 - index]))
  )
}

function slotMatches(slot: Slot, token: Token | undefined): boolean {
  if (!token) return false
  return slot.type === 'fixed' ? slot.text === token.text : token.isNumber
}

function formatPattern(pattern: Pattern): string {
  const parts = pattern.prefix.map(slotText)
  if (pattern.hasMiddle) parts.push('*')
  for (let index = pattern.suffix.length - 1; index >= 0; index -= 1) {
    const slot = pattern.suffix[index]
    if (slot) parts.push(slotText(slot))
  }
  return parts
    .join('')
    .replace(/\*{2,}/g, '*')
    .trim()
}

function slotText(slot: Slot): string {
  return slot.type === 'fixed' ? slot.text : '*'
}
