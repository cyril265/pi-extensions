import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tempCounter = 0

export function splitExitCode(text: string): { body: string; exitCodeLine: string } {
  const match = text.match(/\n\nCommand exited with code \d+$/)
  if (!match) return { body: text, exitCodeLine: '' }
  return { body: text.slice(0, match.index), exitCodeLine: match[0] }
}

export function detailsFullOutputPath(details: unknown): string | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  const path = (details as { fullOutputPath?: unknown }).fullOutputPath
  return typeof path === 'string' ? path : undefined
}

export async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return undefined
  }
}

export async function writeTempText(prefix: string, suffix: string, text: string): Promise<string> {
  const path = join(tmpdir(), `${prefix}-${process.pid}-${++tempCounter}-${suffix}`)
  await writeFile(path, text, 'utf-8')
  return path
}
