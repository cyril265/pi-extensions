/**
 * Unified Edit Extension — replaces the built-in `edit` tool.
 *
 * The tool accepts one structured patch payload. Diff rendering uses pi's exported
 * generateDiffString/generateUnifiedPatch; the fuzzy edit matcher core is
 * inlined from pi's internal edit-diff implementation because it is not part of
 * pi's public API.
 */

import { constants } from 'node:fs'
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type ExtensionAPI,
  generateDiffString,
  generateUnifiedPatch,
  renderDiff,
  type Theme,
  withFileMutationQueue,
} from '@earendil-works/pi-coding-agent'
import {
  Box,
  type Component,
  Container,
  getCapabilities,
  hyperlink,
  Spacer,
  Text,
} from '@earendil-works/pi-tui'

const TOOL_DESCRIPTION = `Edit files with one complete patch payload.

Patch format:
*** Begin Patch
*** Update File: path/to/file
*** Move to: path/to/new-location
@@ optional context line
 unchanged context row
-deleted row
+inserted row
*** Add File: path/to/new-file
+every added file row starts with +
*** Delete File: path/to/old-file
*** End Patch

Patch update hunks use @@ separators and require every hunk row to start with a space (context), +, or -. Use complete current source lines copied from read output; never use shortened or truncated search-output lines as patch context. Multiple file operations and multiple update hunks are allowed. An update may include *** Move to: immediately after its file header. *** End of File can constrain an update hunk to the end of the file. The payload must start with *** Begin Patch and end with *** End Patch.`

const TOOL_PROMPT_SNIPPET = 'Edit files using one complete *** Begin Patch / *** End Patch payload.'

const TOOL_PROMPT_GUIDELINES = [
  'Use complete patch payloads for edit.',
  'For edit patch mode, wrap the entire payload in *** Begin Patch and *** End Patch; use *** Update File:, *** Add File:, or *** Delete File: headers, optionally put *** Move to: immediately after an update header, and prefix update hunk rows with a space, +, or -.',
  'Before using edit, read the target region and copy complete current source lines into patch hunks; never use shortened or truncated search-output lines as context.',
]

// Increment when edit planning or mutation behavior changes. Older session results have no marker.
export const UNIFIED_EDIT_VERSION = 5

const unifiedEditSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: {
      type: 'string',
      description: TOOL_DESCRIPTION,
    },
  },
} as const

type UnifiedEditParams = { text: string }
type ToolContent = Array<{ type: 'text'; text: string }>

interface Edit {
  oldText: string
  newText: string
}

interface EditDetailsLike {
  diff: string
  patch: string
  firstChangedLine?: number
}

interface UnifiedEditDetails extends EditDetailsLike {
  files: Array<{
    path: string
    sourcePath?: string
    kind: PlannedFileChange['kind']
    details: EditDetailsLike
  }>
}

type PlannedFileChange = {
  kind: 'update' | 'write' | 'add' | 'delete' | 'move'
  path: string
  absolutePath: string
  oldText: string
  newText: string
  destinationPath?: string
  destinationAbsolutePath?: string
  destinationOldText?: string | null
}

type ParsedPlan = {
  changes: PlannedFileChange[]
}

type PatchOperation =
  | { kind: 'add'; path: string; contents: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; movePath?: string; chunks: UpdateChunk[] }

type UpdateChunk = {
  changeContext?: string
  oldLines: string[]
  newLines: string[]
  rows: UpdateRow[]
  hasChange: boolean
  isEndOfFile: boolean
}

type UpdateRow = { marker: ' ' | '-' | '+'; text: string }

type FileSnapshot = {
  path: string
  absolutePath: string
  original: string | null
  current: string | null
  origin?: FileOrigin
  originMoveOrder?: number
}

type FileOrigin = {
  path: string
  absolutePath: string
  oldText: string
  snapshot: FileSnapshot
}

type RenderContext<State> = {
  state: State
  cwd: string
  invalidate: () => void
  argsComplete: boolean
  isError: boolean
  args?: unknown
  lastComponent?: Component
}

type Preview = { diff: string; files: string[]; firstChangedLine?: number } | { error: string }

type UnifiedEditCallRenderComponent = Box & {
  preview?: Preview
  previewArgsKey?: string
  previewBuiltFromCompleteArgs?: boolean
  latestPreviewArgsKey?: string
  previewPending?: boolean
  previewPendingArgsKey?: string
  previewSuppressedArgsKey?: string
  settled?: boolean
  settledError?: boolean
}

type UnifiedRenderState = {
  planKey?: string
  preview?: Preview
  pending?: boolean
  callComponent?: UnifiedEditCallRenderComponent
}

function prepareUnifiedArguments(args: unknown): UnifiedEditParams {
  if (typeof args === 'string') return { text: args }
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    for (const key of ['text', 'patch', 'input', 'content']) {
      const value = (args as Record<string, unknown>)[key]
      if (typeof value === 'string') return { text: value }
    }
  }
  return args as UnifiedEditParams
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Operation aborted')
}

// ============================================================================
// Inlined pi edit-diff matcher core, extended with whole-line matching
// ============================================================================

function detectLineEnding(content: string): '\r\n' | '\n' {
  const crlfIdx = content.indexOf('\r\n')
  const lfIdx = content.indexOf('\n')
  if (lfIdx === -1 || crlfIdx === -1) return '\n'
  return crlfIdx < lfIdx ? '\r\n' : '\n'
}

function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function restoreLineEndings(text: string, ending: '\r\n' | '\n'): string {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}

function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize('NFKC')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? []
}

interface LineSpan {
  start: number
  end: number
}

interface MatchedEdit {
  editIndex: number
  matchIndex: number
  matchLength: number
  newText: string
}

type TextReplacement = Pick<MatchedEdit, 'matchIndex' | 'matchLength' | 'newText'>

function getLineSpans(content: string): LineSpan[] {
  let offset = 0
  return splitLinesWithEndings(content).map(line => {
    const span = { start: offset, end: offset + line.length }
    offset = span.end
    return span
  })
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
  const replacementStart = replacement.matchIndex
  const replacementEnd = replacement.matchIndex + replacement.matchLength

  let startLine = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (replacementStart >= line.start && replacementStart < line.end) {
      startLine = i
      break
    }
  }
  if (startLine === -1) {
    throw new Error('Replacement range is outside the base content.')
  }

  let endLine = startLine
  while (endLine < lines.length && lines[endLine].end < replacementEnd) {
    endLine++
  }
  if (endLine >= lines.length) {
    throw new Error('Replacement range is outside the base content.')
  }

  return { startLine, endLine: endLine + 1 }
}

function applyTextReplacements(
  content: string,
  replacements: TextReplacement[],
  offset = 0,
): string {
  let result = content
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i]
    const matchIndex = replacement.matchIndex - offset
    result =
      result.substring(0, matchIndex) +
      replacement.newText +
      result.substring(matchIndex + replacement.matchLength)
  }
  return result
}

function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: TextReplacement[],
): string {
  const originalLines = splitLinesWithEndings(originalContent)
  const baseLines = getLineSpans(baseContent)
  if (originalLines.length !== baseLines.length) {
    throw new Error(
      'Cannot preserve unchanged lines because the base content has a different line count.',
    )
  }

  const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = []
  const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)
  for (const replacement of sortedReplacements) {
    const range = getReplacementLineRange(baseLines, replacement)
    const current = groups[groups.length - 1]
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine)
      current.replacements.push(replacement)
      continue
    }
    groups.push({ ...range, replacements: [replacement] })
  }

  let originalLineIndex = 0
  let result = ''
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join('')

    const groupStartOffset = baseLines[group.startLine].start
    const groupEndOffset = baseLines[group.endLine - 1].end
    result += applyTextReplacements(
      baseContent.slice(groupStartOffset, groupEndOffset),
      group.replacements,
      groupStartOffset,
    )
    originalLineIndex = group.endLine
  }
  result += originalLines.slice(originalLineIndex).join('')

  return result
}

interface FuzzyMatchResult {
  found: boolean
  index: number
  matchLength: number
  usedFuzzyMatch: boolean
  contentForReplacement: string
}

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith('\uFEFF')
    ? { bom: '\uFEFF', text: content.slice(1) }
    : { bom: '', text: content }
}

function findMatchIndex(content: string, needle: string): number {
  if (needle.length === 0) return -1
  return content.indexOf(needle)
}

function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const exactIndex = findMatchIndex(content, oldText)
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    }
  }

  const fuzzyContent = normalizeForFuzzyMatch(content)
  const fuzzyOldText = normalizeForFuzzyMatch(oldText)
  const fuzzyIndex = findMatchIndex(fuzzyContent, fuzzyOldText)
  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    }
  }

  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent,
  }
}

function countNeedleOccurrences(content: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let index = content.indexOf(needle)
  while (index !== -1) {
    count++
    index = content.indexOf(needle, index + needle.length)
  }
  return count
}

function countOccurrences(content: string, oldText: string): number {
  const fuzzyOldText = normalizeForFuzzyMatch(oldText)
  if (fuzzyOldText.length === 0) {
    // Trailing-whitespace normalization can collapse a whitespace-only
    // oldText to the empty string.  Searching/counting an empty needle with
    // String#indexOf never reaches -1 once the offset passes content.length,
    // so use a literal count instead.
    return countNeedleOccurrences(content, oldText)
  }
  return countNeedleOccurrences(normalizeForFuzzyMatch(content), fuzzyOldText)
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
  const what = totalEdits === 1 ? 'the exact text' : `edits[${editIndex}]`
  const noun = totalEdits === 1 ? 'old text' : 'oldText'
  return new Error(
    `Could not find ${what} in ${path}. The ${noun} must match exactly including all whitespace and newlines.`,
  )
}

function getDuplicateError(
  path: string,
  editIndex: number,
  totalEdits: number,
  occurrences: number,
): Error {
  const what = totalEdits === 1 ? 'the text' : `edits[${editIndex}]`
  const noun = totalEdits === 1 ? 'The text' : 'Each oldText'
  return new Error(
    `Found ${occurrences} occurrences of ${what} in ${path}. ${noun} must be unique. Please provide more context to make it unique.`,
  )
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) return new Error(`oldText must not be empty in ${path}.`)
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`)
}

function getNoChangeError(path: string, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
    )
  }
  return new Error(`No changes made to ${path}. The replacements produced identical content.`)
}

function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: Edit[],
  path: string,
): { baseContent: string; newContent: string } {
  const normalizedEdits = edits.map(edit => ({
    oldText: normalizeToLf(edit.oldText),
    newText: normalizeToLf(edit.newText),
  }))

  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length)
    }
  }

  const initialMatches = normalizedEdits.map(edit => fuzzyFindText(normalizedContent, edit.oldText))
  const usedFuzzyMatch = initialMatches.some(match => match.usedFuzzyMatch)
  const replacementBaseContent = usedFuzzyMatch
    ? normalizeForFuzzyMatch(normalizedContent)
    : normalizedContent

  const matchedEdits: MatchedEdit[] = []
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i]
    const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText)
    if (!matchResult.found) {
      throw getNotFoundError(path, i, normalizedEdits.length)
    }

    const occurrences = countOccurrences(replacementBaseContent, edit.oldText)
    if (occurrences > 1) {
      throw getDuplicateError(path, i, normalizedEdits.length, occurrences)
    }

    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText,
    })
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex)
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1]
    const current = matchedEdits[i]
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      )
    }
  }

  const baseContent = normalizedContent
  const newContent = usedFuzzyMatch
    ? applyReplacementsPreservingUnchangedLines(
        normalizedContent,
        replacementBaseContent,
        matchedEdits,
      )
    : applyTextReplacements(replacementBaseContent, matchedEdits)

  if (baseContent === newContent) {
    throw getNoChangeError(path, normalizedEdits.length)
  }

  return { baseContent, newContent }
}

// ============================================================================
// Path and file helpers
// ============================================================================

function normalizePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) throw new Error('File path cannot be empty.')
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
}

function resolveToCwd(cwd: string, path: string): string {
  const normalized = normalizePath(path)
  return isAbsolute(normalized) ? resolvePath(normalized) : resolvePath(cwd, normalized)
}

async function readExistingNormalized(path: string, absolutePath: string): Promise<string> {
  try {
    return normalizeToLf(stripBom(await readFile(absolutePath, 'utf-8')).text)
  } catch (err) {
    const errorCode = getErrorCode(err)
    const code = errorCode ? ` (${errorCode})` : ''
    throw new Error(`Could not read ${path}${code}.`)
  }
}

async function maybeReadNormalized(absolutePath: string): Promise<string | null> {
  try {
    return normalizeToLf(stripBom(await readFile(absolutePath, 'utf-8')).text)
  } catch (err) {
    if (getErrorCode(err) === 'ENOENT') return null
    throw err
  }
}

async function pathsReferenceSameFile(a: string, b: string): Promise<boolean> {
  if (a === b) return true
  try {
    const [aStat, bStat] = await Promise.all([stat(a), stat(b)])
    return aStat.dev === bStat.dev && aStat.ino === bStat.ino
  } catch (err) {
    if (getErrorCode(err) === 'ENOENT') return false
    throw err
  }
}

// ============================================================================
// Patch parsing/application planning
// ============================================================================

function createUpdatePlan(
  path: string,
  absolutePath: string,
  oldText: string,
  newText: string,
): PlannedFileChange | undefined {
  if (oldText === newText) return undefined
  return { kind: oldText.length === 0 ? 'write' : 'update', path, absolutePath, oldText, newText }
}

function createSnapshotStore(
  cwd: string,
  read: (path: string, absolutePath: string) => Promise<string | null>,
) {
  const snapshots = new Map<string, FileSnapshot>()
  const ordered: FileSnapshot[] = []

  return {
    async get(path: string): Promise<FileSnapshot> {
      const absolutePath = resolveToCwd(cwd, path)
      let snapshot = snapshots.get(absolutePath)
      if (!snapshot) {
        const original = await read(path, absolutePath)
        snapshot = { path, absolutePath, original, current: original }
        if (original !== null) {
          snapshot.origin = { path, absolutePath, oldText: original, snapshot }
        }
        snapshots.set(absolutePath, snapshot)
        ordered.push(snapshot)
      }
      return snapshot
    },
    getSnapshots(): FileSnapshot[] {
      return ordered
    },
    collectChanges(noChangesError?: string): PlannedFileChange[] {
      const changes: PlannedFileChange[] = []
      for (const { path, absolutePath, original, current } of ordered) {
        if (original === current) continue
        if (original === null && current !== null) {
          changes.push({ kind: 'add', path, absolutePath, oldText: '', newText: current })
        } else if (original !== null && current === null) {
          changes.push({ kind: 'delete', path, absolutePath, oldText: original, newText: '' })
        } else if (original !== null && current !== null) {
          const plan = createUpdatePlan(path, absolutePath, original, current)
          if (plan) changes.push(plan)
        }
      }
      if (changes.length === 0 && noChangesError) throw new Error(noChangesError)
      return changes
    },
  }
}

function isPatchPayload(text: string): boolean {
  const trimmed = normalizeToLf(text).trim()
  return trimmed.startsWith('*** Begin Patch') && trimmed.endsWith('*** End Patch')
}

function isPatchLikePayload(text: string): boolean {
  return normalizeToLf(text).trimStart().startsWith('*** Begin Patch')
}

function patchTextForPreview(text: string): string {
  const normalized = normalizeToLf(text).trimEnd()
  return normalized.endsWith('*** End Patch') ? normalized : `${normalized}\n*** End Patch`
}

function completePreviewText(text: string, argsComplete: boolean): string | undefined {
  if (argsComplete) return text
  const lastNewline = text.lastIndexOf('\n')
  return lastNewline === -1 ? undefined : text.slice(0, lastNewline + 1)
}

function parseUpdateChunk(
  lines: string[],
  startIndex: number,
  lastContentLine: number,
  allowMissingContext: boolean,
): { chunk: UpdateChunk; nextIndex: number } {
  let i = startIndex
  let changeContext: string | undefined
  const first = lines[i].trimEnd()

  if (first === '@@') i++
  else if (first.startsWith('@@ ')) {
    changeContext = first.slice(3)
    i++
  } else if (!allowMissingContext) {
    throw new Error(`Expected update hunk to start with @@ context marker, got: '${lines[i]}'`)
  }

  const oldLines: string[] = []
  const newLines: string[] = []
  const rows: UpdateRow[] = []
  let parsed = 0
  let hasAddition = false
  let hasDeletion = false
  let isEndOfFile = false

  while (i <= lastContentLine) {
    const raw = lines[i]
    const controlLine = raw.trimEnd()
    if (controlLine === '*** End of File') {
      if (parsed === 0) throw new Error('Update hunk does not contain any lines')
      isEndOfFile = true
      i++
      break
    }
    if (
      (parsed > 0 || changeContext !== undefined) &&
      (controlLine.startsWith('@@') || controlLine.startsWith('*** '))
    )
      break
    if (raw.length === 0) {
      oldLines.push('')
      newLines.push('')
      rows.push({ marker: ' ', text: '' })
      parsed++
      i++
      continue
    }

    const marker = raw[0]
    const body = raw.slice(1)
    if (marker === ' ') {
      oldLines.push(body)
      newLines.push(body)
      rows.push({ marker, text: body })
    } else if (marker === '-') {
      oldLines.push(body)
      rows.push({ marker, text: body })
      hasDeletion = true
    } else if (marker === '+') {
      newLines.push(body)
      rows.push({ marker, text: body })
      hasAddition = true
    } else if (parsed === 0)
      throw new Error(
        `Unexpected line found in update hunk: '${raw}'. Every line should start with ' ', '+', or '-'.`,
      )
    else break
    parsed++
    i++
  }

  if (parsed === 0 && changeContext === undefined)
    throw new Error('Update hunk does not contain any lines')
  return {
    chunk: {
      changeContext,
      oldLines,
      newLines,
      rows,
      hasChange: hasAddition || hasDeletion,
      isEndOfFile,
    },
    nextIndex: i,
  }
}

function parsePatch(patchText: string): PatchOperation[] {
  const lines = normalizeToLf(patchText).trim().split('\n')
  if (lines.length < 2) throw new Error('Patch is empty or invalid')
  if (lines[0].trim() !== '*** Begin Patch')
    throw new Error("The first line of the patch must be '*** Begin Patch'")
  if (lines[lines.length - 1].trim() !== '*** End Patch')
    throw new Error("The last line of the patch must be '*** End Patch'")

  const operations: PatchOperation[] = []
  let i = 1
  const lastContentLine = lines.length - 2
  while (i <= lastContentLine) {
    if (lines[i].trim() === '') {
      i++
      continue
    }
    const line = lines[i].trim()
    if (line.startsWith('*** Add File: ')) {
      const path = normalizePath(line.slice('*** Add File: '.length))
      i++
      const contentLines: string[] = []
      while (i <= lastContentLine) {
        const next = lines[i]
        if (next.trim().startsWith('*** ')) break
        if (!next.startsWith('+'))
          throw new Error(`Invalid add-file line '${next}'. Add file lines must start with '+'`)
        contentLines.push(next.slice(1))
        i++
      }
      operations.push({
        kind: 'add',
        path,
        contents: contentLines.length > 0 ? `${contentLines.join('\n')}\n` : '',
      })
      continue
    }
    if (line.startsWith('*** Delete File: ')) {
      operations.push({
        kind: 'delete',
        path: normalizePath(line.slice('*** Delete File: '.length)),
      })
      i++
      continue
    }
    if (line.startsWith('*** Update File: ')) {
      const path = normalizePath(line.slice('*** Update File: '.length))
      i++
      let movePath: string | undefined
      if (i <= lastContentLine && lines[i].trim().startsWith('*** Move to: ')) {
        movePath = normalizePath(lines[i].trim().slice('*** Move to: '.length))
        i++
      }
      const chunks: UpdateChunk[] = []
      while (i <= lastContentLine) {
        if (lines[i].trim() === '') {
          i++
          continue
        }
        if (lines[i].trimEnd().startsWith('*** ')) break
        const parsed = parseUpdateChunk(lines, i, lastContentLine, chunks.length === 0)
        chunks.push(parsed.chunk)
        i = parsed.nextIndex
      }
      if (!movePath) {
        if (chunks.length === 0) throw new Error(`Update file hunk for path '${path}' is empty`)
        if (!chunks.some(chunk => chunk.hasChange))
          throw new Error(
            `Update file operation for path '${path}' contains only context rows; add + or - rows or remove the operation.`,
          )
      }
      operations.push({ kind: 'update', path, movePath, chunks })
      continue
    }
    throw new Error(
      `'${line}' is not a valid hunk header. Valid headers: '*** Add File:', '*** Delete File:', '*** Update File:'`,
    )
  }
  return operations
}

type SequenceSearchOptions = {
  start: number
  eof?: boolean
  all?: boolean
  accept?: (index: number) => boolean
}

function findSequenceMatches(
  lines: string[],
  pattern: string[],
  options: SequenceSearchOptions,
): number[] {
  if (pattern.length === 0) return options.accept?.(options.start) === false ? [] : [options.start]
  if (pattern.length > lines.length) return []
  const eof = options.eof === true
  const searchStart =
    eof && lines.length >= pattern.length
      ? lines.length - pattern.length
      : Math.max(0, options.start)
  const searchEnd = lines.length - pattern.length
  const passes = [
    (a: string, b: string) => a === b,
    (a: string, b: string) => a.trimEnd() === b.trimEnd(),
    (a: string, b: string) => a.trim() === b.trim(),
    (a: string, b: string) => normalizeForFuzzyMatch(a).trim() === normalizeForFuzzyMatch(b).trim(),
  ]
  for (const equal of passes) {
    const matches: number[] = []
    for (let i = searchStart; i <= searchEnd; i++) {
      let ok = true
      for (let j = 0; j < pattern.length; j++) {
        if (!equal(lines[i + j], pattern[j])) {
          ok = false
          break
        }
      }
      if (!(ok && options.accept?.(i) !== false)) continue
      matches.push(i)
      if (!options.all) return matches
    }
    if (matches.length > 0) return matches
  }
  return []
}

function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  eof = false,
  accept?: (index: number) => boolean,
): number | undefined {
  return findSequenceMatches(lines, pattern, { start, eof, accept })[0]
}

type PendingReplacement = {
  start: number
  oldLength: number
  newLines: string[]
  order: number
}

function replacementsOverlap(a: PendingReplacement, b: PendingReplacement): boolean {
  if (a.oldLength === 0 && b.oldLength === 0) return false
  if (a.oldLength === 0) return b.start < a.start && a.start < b.start + b.oldLength
  if (b.oldLength === 0) return a.start < b.start && b.start < a.start + a.oldLength
  return a.start < b.start + b.oldLength && b.start < a.start + a.oldLength
}

function canPlaceReplacement(
  replacements: PendingReplacement[],
  start: number,
  oldLength: number,
): boolean {
  const candidate: PendingReplacement = { start, oldLength, newLines: [], order: -1 }
  return replacements.every(replacement => !replacementsOverlap(candidate, replacement))
}

function formatCandidateLines(indices: number[]): string {
  const shown = indices.slice(0, 8).map(index => index + 1)
  const suffix = indices.length > shown.length ? `, and ${indices.length - shown.length} more` : ''
  return `${shown.join(', ')}${suffix}`
}

function shortenDiagnosticLine(line: string): string {
  return line.length <= 240 ? line : `${line.slice(0, 237)}...`
}

function describeSequenceMismatch(lines: string[], pattern: string[]): string | undefined {
  if (pattern.length === 0) return undefined
  const equal = (a: string, b: string) =>
    normalizeForFuzzyMatch(a).trim() === normalizeForFuzzyMatch(b).trim()
  let bestStart = -1
  let bestLength = 0

  for (let i = 0; i < lines.length; i++) {
    let matched = 0
    while (
      matched < pattern.length &&
      i + matched < lines.length &&
      equal(lines[i + matched], pattern[matched])
    ) {
      matched++
    }
    if (matched <= bestLength) continue
    bestStart = i
    bestLength = matched
  }

  if (bestStart !== -1 && bestLength < pattern.length) {
    const expected = pattern[bestLength]
    const actual = lines[bestStart + bestLength]
    return [
      `Closest candidate starts at line ${bestStart + 1} and matches ${bestLength} of ${pattern.length} expected line(s).`,
      `First difference at line ${bestStart + bestLength + 1}:`,
      `expected: ${shortenDiagnosticLine(expected)}`,
      `actual:   ${actual === undefined ? '<end of file>' : shortenDiagnosticLine(actual)}`,
    ].join('\n')
  }

  for (let patternIndex = 0; patternIndex < pattern.length; patternIndex++) {
    const expected = normalizeForFuzzyMatch(pattern[patternIndex]).trim()
    if (expected.length < 8) continue
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const actual = normalizeForFuzzyMatch(lines[lineIndex]).trim()
      if (actual.length < 8 || actual === expected) continue
      if (!(actual.includes(expected) || expected.includes(actual))) continue
      return [
        `Expected hunk line ${patternIndex + 1} matches only part of source line ${lineIndex + 1}.`,
        `expected: ${shortenDiagnosticLine(pattern[patternIndex])}`,
        `actual:   ${shortenDiagnosticLine(lines[lineIndex])}`,
        'Patch update rows must contain complete source lines.',
      ].join('\n')
    }
  }

  return undefined
}

function addReplacement(
  replacements: PendingReplacement[],
  replacement: Omit<PendingReplacement, 'order'>,
  filePath: string,
  hunkNumber: number,
): void {
  const pending = { ...replacement, order: replacements.length }
  const conflict = replacements.find(existing => replacementsOverlap(pending, existing))
  if (conflict) {
    throw new Error(
      `Update hunk ${hunkNumber} in ${filePath} overlaps an earlier hunk at line ${conflict.start + 1}.`,
    )
  }
  replacements.push(pending)
}

function resolveChangeContext(
  originalLines: string[],
  context: string,
  start: number,
  filePath: string,
  hunkNumber: number,
): number {
  const forward = seekSequence(originalLines, [context], start)
  if (forward !== undefined) return forward

  const fallback = findSequenceMatches(originalLines, [context], { start: 0, all: true })
  if (fallback.length === 1) return fallback[0]
  if (fallback.length > 1) {
    throw new Error(
      `Update hunk ${hunkNumber} context '${context}' is ambiguous in ${filePath}; matching lines: ${formatCandidateLines(fallback)}.`,
    )
  }

  const diagnostic = describeSequenceMismatch(originalLines, [context])
  throw new Error(
    `Failed to find context '${context}' in ${filePath}${diagnostic ? `\n${diagnostic}` : ''}`,
  )
}

function resolveUpdatePattern(
  originalLines: string[],
  originalPattern: string[],
  originalNewLines: string[],
  originalNewLineSources: Array<number | undefined>,
  start: number,
  eof: boolean,
  replacements: PendingReplacement[],
  filePath: string,
  hunkNumber: number,
):
  | {
      start: number
      pattern: string[]
      newLines: string[]
      newLineSources: Array<number | undefined>
    }
  | undefined {
  const variants = [
    {
      pattern: originalPattern,
      newLines: originalNewLines,
      newLineSources: originalNewLineSources,
    },
  ]
  if (originalPattern[originalPattern.length - 1] === '') {
    const stripTrailingNewLine = originalNewLines[originalNewLines.length - 1] === ''
    variants.push({
      pattern: originalPattern.slice(0, -1),
      newLines: stripTrailingNewLine ? originalNewLines.slice(0, -1) : originalNewLines,
      newLineSources: stripTrailingNewLine
        ? originalNewLineSources.slice(0, -1)
        : originalNewLineSources,
    })
  }

  for (const variant of variants) {
    const found = seekSequence(originalLines, variant.pattern, start, eof, index =>
      canPlaceReplacement(replacements, index, variant.pattern.length),
    )
    if (found !== undefined) return { start: found, ...variant }
  }

  if (!eof) {
    for (const variant of variants) {
      const fallback = findSequenceMatches(originalLines, variant.pattern, {
        start: 0,
        all: true,
        accept: index => canPlaceReplacement(replacements, index, variant.pattern.length),
      })
      if (fallback.length === 1) return { start: fallback[0], ...variant }
      if (fallback.length > 1) {
        throw new Error(
          `Update hunk ${hunkNumber} is ambiguous in ${filePath}; matching starts: ${formatCandidateLines(fallback)}. Add more context.`,
        )
      }
    }
  }

  for (const variant of variants) {
    const overlapping = findSequenceMatches(originalLines, variant.pattern, {
      start: eof ? Math.max(0, originalLines.length - variant.pattern.length) : 0,
      eof,
      all: true,
    })
    if (overlapping.length > 0) {
      throw new Error(
        `Update hunk ${hunkNumber} in ${filePath} overlaps an earlier hunk near line ${overlapping[0] + 1}.`,
      )
    }
  }

  return undefined
}

function getNewLineSources(rows: UpdateRow[]): Array<number | undefined> {
  const sources: Array<number | undefined> = []
  let oldLineIndex = 0
  for (const row of rows) {
    if (row.marker === ' ') {
      sources.push(oldLineIndex)
      oldLineIndex++
    } else if (row.marker === '-') {
      oldLineIndex++
    } else {
      sources.push(undefined)
    }
  }
  return sources
}

function preserveMatchedContextLines(
  originalLines: string[],
  start: number,
  newLines: string[],
  newLineSources: Array<number | undefined>,
): string[] {
  return newLines.map((line, index) => {
    const source = newLineSources[index]
    return source === undefined ? line : originalLines[start + source]
  })
}

function deriveUpdatedContent(
  filePath: string,
  currentContent: string,
  chunks: UpdateChunk[],
): string {
  const originalLines = currentContent.split('\n')
  if (originalLines[originalLines.length - 1] === '') originalLines.pop()
  const replacements: PendingReplacement[] = []
  let lineIndex = 0
  let hasInsertionPoint = false

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex]
    const hunkNumber = chunkIndex + 1
    if (chunk.changeContext !== undefined) {
      const ctxIndex = resolveChangeContext(
        originalLines,
        chunk.changeContext,
        lineIndex,
        filePath,
        hunkNumber,
      )
      lineIndex = ctxIndex + 1
      hasInsertionPoint = true
    }
    if (!(chunk.hasChange || chunk.oldLines.length > 0)) continue
    if (chunk.oldLines.length === 0) {
      const insertionPoint =
        chunk.isEndOfFile || !hasInsertionPoint ? originalLines.length : lineIndex
      addReplacement(
        replacements,
        {
          start: insertionPoint,
          oldLength: 0,
          newLines: [...chunk.newLines],
        },
        filePath,
        hunkNumber,
      )
      continue
    }
    const resolved = resolveUpdatePattern(
      originalLines,
      chunk.oldLines,
      chunk.newLines,
      getNewLineSources(chunk.rows),
      lineIndex,
      chunk.isEndOfFile,
      chunk.hasChange ? replacements : [],
      filePath,
      hunkNumber,
    )
    if (!resolved) {
      const diagnostic = describeSequenceMismatch(originalLines, chunk.oldLines)
      const eofDiagnostic = chunk.isEndOfFile
        ? '\nThis hunk is marked *** End of File and therefore only matches at the file tail.'
        : ''
      throw new Error(
        `Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join('\n')}${eofDiagnostic}${diagnostic ? `\n\n${diagnostic}` : ''}`,
      )
    }
    lineIndex = resolved.start + resolved.pattern.length
    hasInsertionPoint = true
    if (!chunk.hasChange) continue
    addReplacement(
      replacements,
      {
        start: resolved.start,
        oldLength: resolved.pattern.length,
        newLines: preserveMatchedContextLines(
          originalLines,
          resolved.start,
          resolved.newLines,
          resolved.newLineSources,
        ),
      },
      filePath,
      hunkNumber,
    )
  }

  if (replacements.length === 0) return currentContent
  const newLines = [...originalLines]
  for (const replacement of replacements.sort((a, b) => {
    const byStart = b.start - a.start
    if (byStart !== 0) return byStart
    if (a.oldLength === 0 && b.oldLength !== 0) return 1
    if (a.oldLength !== 0 && b.oldLength === 0) return -1
    return b.order - a.order
  })) {
    newLines.splice(replacement.start, replacement.oldLength, ...replacement.newLines)
  }
  if (newLines[newLines.length - 1] !== '') newLines.push('')
  return newLines.join('\n')
}

async function buildPatchPlan(text: string, cwd: string): Promise<ParsedPlan> {
  const operations = parsePatch(text)
  const store = createSnapshotStore(cwd, (_path, absolutePath) => maybeReadNormalized(absolutePath))
  let moveOrder = 0

  for (const op of operations) {
    const snapshot = await store.get(op.path)
    if (op.kind === 'add') {
      const contents = normalizeToLf(op.contents)
      if (snapshot.current === null) snapshot.origin = undefined
      snapshot.current = contents === '' || contents.endsWith('\n') ? contents : `${contents}\n`
      continue
    }
    if (op.kind === 'delete') {
      if (snapshot.current === null)
        throw new Error(`Failed to delete ${op.path}: file does not exist.`)
      snapshot.current = null
      snapshot.origin = undefined
      continue
    }
    if (snapshot.current === null)
      throw new Error(`Failed to update ${op.path}: file does not exist.`)
    const updated =
      op.chunks.length === 0
        ? snapshot.current
        : deriveUpdatedContent(op.path, snapshot.current, op.chunks)
    if (!op.movePath) {
      snapshot.current = updated
      continue
    }

    const destination = await store.get(op.movePath)
    if (
      destination.absolutePath === snapshot.absolutePath ||
      (await canonicalMutationPath(destination.absolutePath)) ===
        (await canonicalMutationPath(snapshot.absolutePath)) ||
      (await pathsReferenceSameFile(destination.absolutePath, snapshot.absolutePath))
    ) {
      throw new Error(`Failed to move ${op.path}: source and destination are the same file.`)
    }
    snapshot.current = null
    const origin = snapshot.origin
    snapshot.origin = undefined
    destination.current = updated
    destination.origin = origin
    destination.originMoveOrder = moveOrder++
  }

  const snapshots = store.getSnapshots()
  const movedDestinations = snapshots
    .filter(
      (
        snapshot,
      ): snapshot is FileSnapshot & {
        current: string
        origin: FileOrigin
        originMoveOrder: number
      } =>
        snapshot.current !== null &&
        snapshot.origin !== undefined &&
        snapshot.originMoveOrder !== undefined &&
        snapshot.origin.absolutePath !== snapshot.absolutePath,
    )
    .sort((a, b) => a.originMoveOrder - b.originMoveOrder)
  const movedPaths = new Set<string>()
  const moveChanges: PlannedFileChange[] = []
  const plannedContents = new Map(
    snapshots.map(snapshot => [snapshot.absolutePath, snapshot.original] as const),
  )

  for (const destination of movedDestinations) {
    const origin = destination.origin
    movedPaths.add(origin.absolutePath)
    movedPaths.add(destination.absolutePath)
    moveChanges.push({
      kind: 'move',
      path: origin.path,
      absolutePath: origin.absolutePath,
      oldText: origin.oldText,
      newText: destination.current,
      destinationPath: destination.path,
      destinationAbsolutePath: destination.absolutePath,
      destinationOldText: plannedContents.get(destination.absolutePath) ?? null,
    })
    plannedContents.set(origin.absolutePath, null)
    plannedContents.set(destination.absolutePath, destination.current)

    const source = origin.snapshot
    const sourceIsAnotherDestination = movedDestinations.some(
      other => other.absolutePath === source.absolutePath,
    )
    if (source.current !== null && !sourceIsAnotherDestination) {
      moveChanges.push({
        kind: 'add',
        path: source.path,
        absolutePath: source.absolutePath,
        oldText: '',
        newText: source.current,
      })
      plannedContents.set(source.absolutePath, source.current)
    }
  }

  const changes = [
    ...moveChanges,
    ...store.collectChanges().filter(change => !movedPaths.has(change.absolutePath)),
  ]
  if (changes.length === 0) throw new Error('The patch produced no changes.')
  return { changes }
}

async function buildPreviewPlan(
  text: string,
  cwd: string,
  argsComplete: boolean,
): Promise<ParsedPlan> {
  if (!argsComplete && isPatchLikePayload(text) && !isPatchPayload(text)) {
    return buildPatchPlan(patchTextForPreview(text), cwd)
  }
  return buildPatchPlan(text, cwd)
}

// ============================================================================
// Preflight and real file mutation
// ============================================================================

async function checkCanCreatePath(absolutePath: string): Promise<void> {
  let dir = dirname(absolutePath)
  while (true) {
    try {
      await access(dir, constants.W_OK | constants.X_OK)
      return
    } catch (err) {
      if (getErrorCode(err) !== 'ENOENT') throw err
      const parent = dirname(dir)
      if (parent === dir) throw err
      dir = parent
    }
  }
}

async function preflightPlan(plan: ParsedPlan, signal?: AbortSignal): Promise<void> {
  for (const change of plan.changes) {
    throwIfAborted(signal)
    if (change.kind === 'add') {
      await checkCanCreatePath(change.absolutePath)
      continue
    }
    if (change.kind === 'update') {
      if (change.oldText !== change.newText) {
        applyEditsToNormalizedContent(
          change.oldText,
          [{ oldText: change.oldText, newText: change.newText }],
          change.path,
        )
      }
    }
    if (change.kind === 'move') {
      if (!change.destinationAbsolutePath || change.destinationOldText === undefined) {
        throw new Error(`Move plan for ${change.path} is incomplete.`)
      }
      if (change.oldText !== change.newText) {
        applyEditsToNormalizedContent(
          change.oldText,
          [{ oldText: change.oldText, newText: change.newText }],
          change.path,
        )
      }
      const sourceAccess =
        change.oldText === change.newText ? constants.R_OK : constants.R_OK | constants.W_OK
      await access(change.absolutePath, sourceAccess)
      await access(dirname(change.absolutePath), constants.W_OK | constants.X_OK)
      if (change.destinationOldText === null)
        await checkCanCreatePath(change.destinationAbsolutePath)
      else await access(dirname(change.destinationAbsolutePath), constants.W_OK | constants.X_OK)
      continue
    }
    await access(change.absolutePath, constants.R_OK | constants.W_OK)
  }
}

function detailsForChange(path: string, oldText: string, newText: string): EditDetailsLike {
  const { diff, firstChangedLine } = generateDiffString(oldText, newText)
  return { diff, patch: generateUnifiedPatch(path, oldText, newText), firstChangedLine }
}

function detailsForMoveChange(change: PlannedFileChange): EditDetailsLike {
  if (!change.destinationPath || change.destinationOldText === undefined) {
    throw new Error(`Move plan for ${change.path} is incomplete.`)
  }

  const source = detailsForChange(change.path, change.oldText, '')
  const destination = detailsForChange(
    change.destinationPath,
    change.destinationOldText ?? '',
    change.newText,
  )
  const diff = [
    { path: change.path, value: source.diff },
    { path: change.destinationPath, value: destination.diff },
  ]
    .filter(({ value }) => value !== '')
    .map(({ path, value }) => `File: ${path}\n${value}`)
    .join('\n\n')

  return {
    diff,
    patch: `${source.patch}\n${destination.patch}`,
    firstChangedLine: destination.firstChangedLine ?? source.firstChangedLine,
  }
}

async function readFileForMutation(
  absolutePath: string,
  accessMode = constants.R_OK | constants.W_OK,
): Promise<{ bom: string; ending: '\r\n' | '\n'; content: string }> {
  await access(absolutePath, accessMode)
  const { bom, text } = stripBom(await readFile(absolutePath, 'utf-8'))
  return { bom, ending: detectLineEnding(text), content: normalizeToLf(text) }
}

async function applyUpdateChange(
  change: PlannedFileChange,
  signal?: AbortSignal,
): Promise<EditDetailsLike> {
  return withFileMutationQueue(change.absolutePath, async () => {
    throwIfAborted(signal)
    const file = await readFileForMutation(change.absolutePath)
    throwIfAborted(signal)

    const { baseContent, newContent } = applyEditsToNormalizedContent(
      file.content,
      [{ oldText: change.oldText, newText: change.newText }],
      change.path,
    )

    await writeFile(
      change.absolutePath,
      file.bom + restoreLineEndings(newContent, file.ending),
      'utf-8',
    )
    throwIfAborted(signal)
    return detailsForChange(change.path, baseContent, newContent)
  })
}

async function applyWriteChange(
  change: PlannedFileChange,
  signal?: AbortSignal,
): Promise<EditDetailsLike> {
  return withFileMutationQueue(change.absolutePath, async () => {
    throwIfAborted(signal)
    const file = await readFileForMutation(change.absolutePath)
    if (file.content !== change.oldText) {
      throw new Error(`Could not edit ${change.path}: file changed since preflight.`)
    }
    await writeFile(
      change.absolutePath,
      file.bom + restoreLineEndings(change.newText, file.ending),
      'utf-8',
    )
    return detailsForChange(change.path, file.content, change.newText)
  })
}

async function applyAddChange(
  change: PlannedFileChange,
  signal?: AbortSignal,
): Promise<EditDetailsLike> {
  return withFileMutationQueue(change.absolutePath, async () => {
    throwIfAborted(signal)
    const existing = await maybeReadNormalized(change.absolutePath)
    if (existing !== null) throw new Error(`Could not add ${change.path}: file already exists.`)
    await mkdir(dirname(change.absolutePath), { recursive: true })
    await writeFile(change.absolutePath, change.newText, 'utf-8')
    return detailsForChange(change.path, '', change.newText)
  })
}

async function applyDeleteChange(
  change: PlannedFileChange,
  signal?: AbortSignal,
): Promise<EditDetailsLike> {
  return withFileMutationQueue(change.absolutePath, async () => {
    throwIfAborted(signal)
    await access(change.absolutePath, constants.R_OK | constants.W_OK)
    const current = await readExistingNormalized(change.path, change.absolutePath)
    if (current !== change.oldText)
      throw new Error(`Could not delete ${change.path}: file changed since preflight.`)
    await unlink(change.absolutePath)
    return detailsForChange(change.path, change.oldText, '')
  })
}

async function canonicalMutationPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (err) {
    if (getErrorCode(err) === 'ENOENT') return path
    throw err
  }
}

class MutationQueueRetry extends Error {
  readonly pendingQueue: Promise<unknown>

  constructor(pendingQueue: Promise<unknown>) {
    super('Retry mutation queue acquisition')
    this.pendingQueue = pendingQueue
  }
}

async function withNestedMutationQueue<T>(path: string, mutation: () => Promise<T>): Promise<T> {
  let entered = false
  let abandoned = false
  const queued = withFileMutationQueue(path, async () => {
    entered = true
    if (abandoned) return undefined
    return mutation()
  })

  const outcome = await new Promise<{ kind: 'value'; value: T | undefined } | { kind: 'retry' }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        if (entered) return
        abandoned = true
        resolve({ kind: 'retry' })
      }, 100)
      void queued.then(
        value => {
          clearTimeout(timer)
          resolve({ kind: 'value', value })
        },
        err => {
          clearTimeout(timer)
          reject(err)
        },
      )
    },
  )
  if (outcome.kind === 'retry') throw new MutationQueueRetry(queued)
  return outcome.value as T
}

async function withMutationQueues<T>(paths: string[], mutation: () => Promise<T>): Promise<T> {
  while (true) {
    const canonicalPaths = await Promise.all(paths.map(canonicalMutationPath))
    const queuePaths = Array.from(new Set(canonicalPaths)).sort()

    async function run(index: number, heldPaths: Set<string>): Promise<T> {
      if (index === queuePaths.length) return mutation()
      const queuePath = await canonicalMutationPath(queuePaths[index])
      if (heldPaths.has(queuePath)) return run(index + 1, heldPaths)
      const acquire = () => {
        const nextHeldPaths = new Set(heldPaths)
        nextHeldPaths.add(queuePath)
        return run(index + 1, nextHeldPaths)
      }
      return heldPaths.size === 0
        ? withFileMutationQueue(queuePath, acquire)
        : withNestedMutationQueue(queuePath, acquire)
    }

    try {
      return await run(0, new Set())
    } catch (err) {
      if (!(err instanceof MutationQueueRetry)) throw err
      await err.pendingQueue
    }
  }
}

async function applyMoveChange(
  change: PlannedFileChange,
  signal?: AbortSignal,
): Promise<EditDetailsLike> {
  const destinationPath = change.destinationPath
  const destinationAbsolutePath = change.destinationAbsolutePath
  const destinationOldText = change.destinationOldText
  if (!(destinationPath && destinationAbsolutePath) || destinationOldText === undefined) {
    throw new Error(`Move plan for ${change.path} is incomplete.`)
  }

  return withMutationQueues([change.absolutePath, destinationAbsolutePath], async () => {
    throwIfAborted(signal)
    const sourceAccess =
      change.oldText === change.newText ? constants.R_OK : constants.R_OK | constants.W_OK
    const source = await readFileForMutation(change.absolutePath, sourceAccess)
    if (source.content !== change.oldText) {
      throw new Error(`Could not move ${change.path}: source file changed since preflight.`)
    }
    const currentDestination = await maybeReadNormalized(destinationAbsolutePath)
    if (currentDestination !== destinationOldText) {
      throw new Error(
        `Could not move ${change.path}: destination ${destinationPath} changed since preflight.`,
      )
    }
    if (await pathsReferenceSameFile(change.absolutePath, destinationAbsolutePath)) {
      throw new Error(
        `Could not move ${change.path}: destination ${destinationPath} changed since preflight.`,
      )
    }

    await mkdir(dirname(destinationAbsolutePath), { recursive: true })
    await rename(change.absolutePath, destinationAbsolutePath)
    try {
      await access(change.absolutePath)
      throw new Error(`Could not move ${change.path}: the source path still exists after rename.`)
    } catch (err) {
      if (getErrorCode(err) !== 'ENOENT') throw err
    }
    if (change.oldText !== change.newText) {
      await writeFile(
        destinationAbsolutePath,
        source.bom + restoreLineEndings(change.newText, source.ending),
        'utf-8',
      )
    }
    throwIfAborted(signal)
    return detailsForMoveChange(change)
  })
}

async function applyPlan(plan: ParsedPlan, signal?: AbortSignal): Promise<UnifiedEditDetails> {
  const appliers = {
    update: applyUpdateChange,
    write: applyWriteChange,
    add: applyAddChange,
    delete: applyDeleteChange,
    move: applyMoveChange,
  } as const

  const files: UnifiedEditDetails['files'] = []
  for (const change of plan.changes) {
    throwIfAborted(signal)
    const details = await appliers[change.kind](change, signal)
    files.push({
      path: changePath(change),
      sourcePath: change.kind === 'move' ? change.path : undefined,
      kind: change.kind,
      details,
    })
  }
  return combineDetails(files)
}

function changePath(change: PlannedFileChange): string {
  if (change.kind !== 'move') return change.path
  if (!change.destinationPath) throw new Error(`Move plan for ${change.path} is incomplete.`)
  return change.destinationPath
}

function combineDetails(files: UnifiedEditDetails['files']): UnifiedEditDetails {
  const diff =
    files.length === 1
      ? files[0].details.diff
      : files.map(file => `File: ${file.path}\n${file.details.diff}`).join('\n\n')
  const patch = files.map(file => file.details.patch).join('\n')
  const firstChangedLine = files.find(file => file.details.firstChangedLine !== undefined)?.details
    .firstChangedLine
  return { diff, patch, firstChangedLine, files }
}

function formatSummary(details: UnifiedEditDetails): string {
  if (details.files.length === 1) {
    const file = details.files[0]
    if (file.kind === 'move') return `Moved ${file.sourcePath} to ${file.path}.`
    const verb = file.kind === 'add' ? 'Added' : file.kind === 'delete' ? 'Deleted' : 'Edited'
    return `${verb} ${file.path}.`
  }
  return `Applied unified edit to ${details.files.length} file(s).\n${details.files
    .map((file, index) =>
      file.kind === 'move'
        ? `${index + 1}. move ${file.sourcePath} -> ${file.path}`
        : `${index + 1}. ${file.kind} ${file.path}`,
    )
    .join('\n')}`
}

// ============================================================================
// Rendering
// ============================================================================

function previewForPlan(plan: ParsedPlan): Preview {
  const details = combineDetails(
    plan.changes.map(change => ({
      path: changePath(change),
      sourcePath: change.kind === 'move' ? change.path : undefined,
      kind: change.kind,
      details:
        change.kind === 'move'
          ? detailsForMoveChange(change)
          : detailsForChange(change.path, change.oldText, change.newText),
    })),
  )
  return {
    diff: details.diff,
    files: uniquePaths(plan.changes.map(change => changePath(change))),
    firstChangedLine: details.firstChangedLine,
  }
}

function str(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value == null) return ''
  return null
}

function shortenPath(path: unknown): string {
  if (typeof path !== 'string') return ''
  const home = homedir()
  if (path.startsWith(home)) return `~${path.slice(home.length)}`
  return path
}

function linkPath(styledText: string, rawPath: string, cwd: string): string {
  if (!getCapabilities().hyperlinks) return styledText
  return hyperlink(styledText, pathToFileURL(resolveToCwd(cwd, rawPath)).href)
}

function renderToolPath(
  rawPath: string | null,
  theme: Theme,
  cwd: string,
  options?: { emptyFallback?: string },
): string {
  if (rawPath === null) return theme.fg('error', '[invalid arg]')
  const value = rawPath || options?.emptyFallback
  if (!value) return theme.fg('toolOutput', '...')
  return linkPath(theme.fg('accent', shortenPath(value)), value, cwd)
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths))
}

function uniquePathsForCwd(paths: string[], cwd: string): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const path of paths) {
    let key = path
    try {
      key = resolveToCwd(cwd, path)
    } catch {
      // Keep the raw path as its own key if it is still being streamed.
    }
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(path)
  }
  return unique
}

function safeRenderablePath(path: string): string | undefined {
  try {
    return normalizePath(path)
  } catch {
    return undefined
  }
}

function extractPatchHeaderPaths(text: string): string[] {
  const paths: string[] = []
  const prefixes = ['*** Add File: ', '*** Delete File: ', '*** Update File: ']
  for (const raw of normalizeToLf(text).split('\n')) {
    const trimmed = raw.trim()
    for (const prefix of prefixes) {
      if (!trimmed.startsWith(prefix)) continue
      const path = safeRenderablePath(trimmed.slice(prefix.length))
      if (path) paths.push(path)
      break
    }
  }
  return uniquePaths(paths)
}

function getRenderablePaths(text: string | undefined): string[] | undefined {
  if (!text) return undefined
  const fallback = extractPatchHeaderPaths(text)
  try {
    const paths = parsePatch(isPatchPayload(text) ? text : patchTextForPreview(text)).map(
      op => op.path,
    )
    const unique = uniquePaths(paths)
    return unique.length > 0 ? unique : fallback.length > 0 ? fallback : undefined
  } catch {
    return fallback.length > 0 ? fallback : undefined
  }
}

function renderUnifiedPathLabel(paths: string[] | undefined, theme: Theme, cwd: string): string {
  const unique = paths ? uniquePathsForCwd(paths, cwd) : undefined
  if (!unique || unique.length === 0) return renderToolPath('', theme, cwd)
  if (unique.length === 1) return renderToolPath(str(unique[0]), theme, cwd)
  return theme.fg('accent', `${unique.length} files`)
}

function formatUnifiedEditCall(
  text: string | undefined,
  preview: Preview | undefined,
  theme: Theme,
  cwd: string,
): string {
  const title = theme.fg('toolTitle', theme.bold('edit'))
  const paths = preview && !('error' in preview) ? preview.files : getRenderablePaths(text)
  return `${title} ${renderUnifiedPathLabel(paths, theme, cwd)}`
}

function createUnifiedEditCallRenderComponent(): UnifiedEditCallRenderComponent {
  return Object.assign(new Box(1, 1, (text: string) => text), {
    preview: undefined as Preview | undefined,
    previewArgsKey: undefined as string | undefined,
    previewBuiltFromCompleteArgs: false,
    latestPreviewArgsKey: undefined as string | undefined,
    previewPending: false,
    previewPendingArgsKey: undefined as string | undefined,
    previewSuppressedArgsKey: undefined as string | undefined,
    settled: false,
    settledError: false,
  })
}

function getUnifiedEditCallRenderComponent(
  state: UnifiedRenderState,
  lastComponent: unknown,
): UnifiedEditCallRenderComponent {
  if (lastComponent instanceof Box) {
    const component = lastComponent as UnifiedEditCallRenderComponent
    state.callComponent = component
    return component
  }
  if (state.callComponent) return state.callComponent
  const component = createUnifiedEditCallRenderComponent()
  state.callComponent = component
  return component
}

function getUnifiedEditHeaderBg(
  preview: Preview | undefined,
  settledError: boolean | undefined,
  theme: Theme,
): (text: string) => string {
  if (preview) {
    if ('error' in preview) return (text: string) => theme.bg('toolErrorBg', text)
    return (text: string) => theme.bg('toolSuccessBg', text)
  }
  if (settledError) return (text: string) => theme.bg('toolErrorBg', text)
  return (text: string) => theme.bg('toolPendingBg', text)
}

function setUnifiedEditPreview(
  component: UnifiedEditCallRenderComponent,
  preview: Preview,
  argsKey: string | undefined,
  argsComplete = true,
): boolean {
  const current = component.preview
  const changed =
    current === undefined ||
    ('error' in current && 'error' in preview
      ? current.error !== preview.error
      : 'error' in current !== 'error' in preview) ||
    (!('error' in current || 'error' in preview) &&
      (current.diff !== preview.diff ||
        current.firstChangedLine !== preview.firstChangedLine ||
        current.files.join('\0') !== preview.files.join('\0')))
  component.preview = preview
  component.previewArgsKey = argsKey
  component.previewBuiltFromCompleteArgs = argsComplete
  component.previewPending = false
  component.previewPendingArgsKey = undefined
  component.previewSuppressedArgsKey = undefined
  return changed
}

function requestUnifiedEditPreview(
  component: UnifiedEditCallRenderComponent,
  text: string | undefined,
  argsKey: string | undefined,
  cwd: string,
  argsComplete: boolean,
  invalidate: () => void,
): void {
  const hasUsablePreview =
    component.previewArgsKey === argsKey &&
    component.preview &&
    (!argsComplete || component.previewBuiltFromCompleteArgs)
  if (!(text && argsKey) || hasUsablePreview || component.previewPending || component.settled)
    return
  if (!argsComplete && component.previewSuppressedArgsKey === argsKey) return

  component.previewPending = true
  component.previewPendingArgsKey = argsKey
  const requestKey = argsKey
  void buildPreviewPlan(text, cwd, argsComplete)
    .then((plan): Preview => previewForPlan(plan))
    .catch((err): Preview | undefined => {
      if (!argsComplete) return undefined
      return { error: err instanceof Error ? err.message : String(err) }
    })
    .then(preview => {
      component.previewPending = false
      component.previewPendingArgsKey = undefined
      if (component.settled) return
      if (component.latestPreviewArgsKey !== requestKey) {
        invalidate()
        return
      }
      if (preview) {
        setUnifiedEditPreview(component, preview, requestKey, argsComplete)
      } else {
        component.previewSuppressedArgsKey = requestKey
      }
      invalidate()
    })
}

function buildUnifiedEditCallComponent(
  component: UnifiedEditCallRenderComponent,
  text: string | undefined,
  theme: Theme,
  cwd: string,
): UnifiedEditCallRenderComponent {
  component.setBgFn(getUnifiedEditHeaderBg(component.preview, component.settledError, theme))
  component.clear()
  component.addChild(new Text(formatUnifiedEditCall(text, component.preview, theme, cwd), 0, 0))

  if (!component.preview) return component

  const body =
    'error' in component.preview
      ? theme.fg('error', component.preview.error)
      : renderDiff(component.preview.diff)
  component.addChild(new Spacer(1))
  component.addChild(new Text(body, 0, 0))
  return component
}

function formatUnifiedEditResult(
  preview: Preview | undefined,
  result: { content: ToolContent; details?: UnifiedEditDetails },
  theme: Theme,
  isError: boolean,
): string | undefined {
  const previewDiff = preview && !('error' in preview) ? preview.diff : undefined
  const previewError = preview && 'error' in preview ? preview.error : undefined
  if (isError) {
    const errorText = result.content.map(item => item.text || '').join('\n')
    if (!errorText || errorText === previewError) return undefined
    return theme.fg('error', errorText)
  }

  const resultDiff = result.details?.diff
  if (resultDiff && resultDiff !== previewDiff) return renderDiff(resultDiff)
  return undefined
}

export default function unifiedEditExtension(pi: ExtensionAPI) {
  const toolCallIds = new Set<string>()

  pi.on('tool_result', event => {
    if (!(event.toolName === 'edit' && toolCallIds.delete(event.toolCallId))) return
    const details = typeof event.details === 'object' && event.details !== null ? event.details : {}
    return {
      details: {
        ...details,
        unifiedEdit: { version: UNIFIED_EDIT_VERSION },
      },
    }
  })

  pi.registerTool({
    name: 'edit',
    label: 'edit',
    description: TOOL_DESCRIPTION,
    promptSnippet: TOOL_PROMPT_SNIPPET,
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: unifiedEditSchema,
    renderShell: 'self',
    prepareArguments: prepareUnifiedArguments,

    async execute(toolCallId, params: UnifiedEditParams, signal, _onUpdate, ctx) {
      toolCallIds.add(toolCallId)
      const text = params.text
      if (typeof text !== 'string' || text.trim() === '')
        throw new Error('edit requires a non-empty text payload.')
      const plan = await buildPatchPlan(text, ctx.cwd)
      try {
        await preflightPlan(plan, signal)
      } catch (err) {
        throw new Error(`Preflight failed before mutating files.\n${getErrorMessage(err)}`)
      }
      const details = await applyPlan(plan, signal)
      return { content: [{ type: 'text' as const, text: formatSummary(details) }], details }
    },

    renderCall(args, theme, context: RenderContext<UnifiedRenderState>) {
      const component = getUnifiedEditCallRenderComponent(context.state, context.lastComponent)
      const prepared = prepareUnifiedArguments(args)
      const text = prepared && typeof prepared.text === 'string' ? prepared.text : undefined
      const previewText =
        text === undefined ? undefined : completePreviewText(text, context.argsComplete)
      const key = previewText === undefined ? undefined : `${context.cwd}\0${previewText}`
      component.latestPreviewArgsKey = key
      if (!context.isError) component.settledError = false

      requestUnifiedEditPreview(
        component,
        previewText,
        key,
        context.cwd,
        context.argsComplete,
        () => context.invalidate(),
      )

      return buildUnifiedEditCallComponent(component, text, theme, context.cwd)
    },

    renderResult(result, _options, theme, context: RenderContext<UnifiedRenderState>) {
      const typed = result as { content: ToolContent; details?: UnifiedEditDetails }
      const component = context.state.callComponent
      const prepared = prepareUnifiedArguments(context.args)
      const text = prepared && typeof prepared.text === 'string' ? prepared.text : undefined
      const key = text === undefined ? undefined : `${context.cwd}\0${text}`
      let changed = false

      if (component) {
        component.settled = true
        if (!context.isError && typed.details?.diff) {
          changed =
            setUnifiedEditPreview(
              component,
              {
                diff: typed.details.diff,
                files: uniquePaths(typed.details.files.map(file => file.path)),
                firstChangedLine: typed.details.firstChangedLine,
              },
              key,
            ) || changed
        }
        if (component.settledError !== context.isError) {
          component.settledError = context.isError
          changed = true
        }
        if (changed) buildUnifiedEditCallComponent(component, text, theme, context.cwd)
      }

      const output = formatUnifiedEditResult(component?.preview, typed, theme, context.isError)
      const resultComponent =
        context.lastComponent instanceof Container ? context.lastComponent : new Container()
      resultComponent.clear()
      if (!output) return resultComponent
      resultComponent.addChild(new Spacer(1))
      resultComponent.addChild(new Text(output, 1, 0))
      return resultComponent
    },
  })
}
