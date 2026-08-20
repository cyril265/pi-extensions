import { createHash, randomInt, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getAgentDir, SessionManager } from '@earendil-works/pi-coding-agent'
import type { ForkMetadata } from './types.ts'

const SUBAGENT_SESSION_DIRECTORY = '--simple-subagent--'

// biome-ignore lint/security/noSecrets: Random identifier alphabet, not a credential.
const idChars = 'abcdefghijklmnopqrstuvwxyz0123456789'
// biome-ignore lint/security/noSecrets: Random identifier alphabet, not a credential.
const sessionIdChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function getRandomId(): string {
  let id = ''
  for (let i = 0; i < 10; i++) id += idChars[randomInt(idChars.length)]
  return id
}

export function createRunDirectory(): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const runDirectory = path.join(os.tmpdir(), getRandomId())
    try {
      fs.mkdirSync(runDirectory)
      return runDirectory
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('Failed to create random subagent directory')
}

export function sanitizeFileName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!sanitized) throw new Error('Agent name is empty after sanitizing')
  return sanitized
}

export function resolveSubagentSessionKey(
  cwd: string,
  agentName: string,
  suppliedSessionKey: string | undefined,
): string {
  if (suppliedSessionKey !== undefined) return sanitizeFileName(suppliedSessionKey)

  const prefix = sanitizeFileName(agentName)
  for (let attempt = 0; attempt < 10; attempt++) {
    let suffix = ''
    for (let i = 0; i < 8; i++) {
      suffix += sessionIdChars[randomInt(sessionIdChars.length)]
    }
    const sessionKey = `${prefix}-${suffix}`
    const sessionPath = getSubagentSessionPath(cwd, sessionKey)
    const persistentExists =
      fs.existsSync(sessionPath) || fs.existsSync(getForkMetadataPath(sessionPath))
    if (!persistentExists) {
      return sessionKey
    }
  }
  throw new Error(`Failed to generate a unique session key for subagent "${agentName}"`)
}

export function getSubagentSessionDirectory(): string {
  const sessionDirectory = path.join(getAgentDir(), 'sessions', SUBAGENT_SESSION_DIRECTORY)
  fs.mkdirSync(sessionDirectory, { recursive: true })
  return sessionDirectory
}

export function getSubagentSessionPath(cwd: string, sessionKey: string): string {
  const resolvedCwd = path.resolve(cwd)
  const sessionDirectory = getSubagentSessionDirectory()
  const cwdHash = createHash('sha256').update(resolvedCwd).digest('hex').slice(0, 16)
  return path.join(sessionDirectory, `subagent-${cwdHash}-${sanitizeFileName(sessionKey)}.jsonl`)
}

export function readSubagentSessionId(sessionPath: string): string | undefined {
  if (!fs.existsSync(sessionPath)) return undefined
  return SessionManager.open(sessionPath, path.dirname(sessionPath)).getSessionId()
}

export function formatPiSessionCommand(sessionPath: string): string {
  return `pi --session '${sessionPath.replaceAll("'", "'\\''")}'`
}

function getForkMetadataPath(sessionPath: string): string {
  return `${sessionPath}.fork.json`
}

export function readForkMetadata(sessionPath: string): ForkMetadata | undefined {
  const metadataPath = getForkMetadataPath(sessionPath)
  if (!fs.existsSync(metadataPath)) return undefined
  return JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as ForkMetadata
}

export function writeForkMetadata(sessionPath: string, metadata: ForkMetadata): void {
  const metadataPath = getForkMetadataPath(sessionPath)
  const temporaryPath = `${metadataPath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, {
    flag: 'wx',
  })
  fs.renameSync(temporaryPath, metadataPath)
}

export function ensureUniqueForkSessionId(
  sessionPath: string,
  inheritedSessionId: string,
): string {
  const currentId = SessionManager.open(sessionPath, path.dirname(sessionPath)).getSessionId()
  if (currentId !== inheritedSessionId) return currentId

  const content = fs.readFileSync(sessionPath, 'utf8')
  const newline = content.indexOf('\n')
  if (newline < 0) throw new Error(`Forked session has no header at ${sessionPath}`)
  const header = JSON.parse(content.slice(0, newline)) as { type: string; id: string }
  if (header.type !== 'session') throw new Error(`Forked session has no header at ${sessionPath}`)
  const id = randomUUID()
  const temporaryPath = `${sessionPath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ ...header, id })}${content.slice(newline)}`, {
    flag: 'wx',
  })
  fs.renameSync(temporaryPath, sessionPath)
  return id
}

export function findForkLeafId(
  sessionManager: Pick<SessionManager, 'getBranch'>,
  toolCallId: string,
): string {
  const branch = sessionManager.getBranch()
  let toolCallIndex = -1
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue
    const containsCurrentToolCall = entry.message.content.some(
      part => part.type === 'toolCall' && part.id === toolCallId,
    )
    if (!containsCurrentToolCall) continue
    toolCallIndex = index
    break
  }
  if (toolCallIndex === -1) {
    throw new Error('Could not locate the completed subagent tool call in the parent session')
  }

  for (let index = toolCallIndex + 1; index < branch.length; index++) {
    const entry = branch[index]
    if (
      entry.type === 'message' &&
      entry.message.role === 'toolResult' &&
      entry.message.toolCallId === toolCallId
    ) {
      return entry.id
    }
  }
  throw new Error('Forked subagent tool call has not settled')
}

export function createForkedSession(
  sourceSessionPath: string,
  forkLeafId: string,
  targetSessionPath: string,
): void {
  fs.mkdirSync(path.dirname(targetSessionPath), { recursive: true })
  const source = SessionManager.open(sourceSessionPath, path.dirname(targetSessionPath))
  const generatedPath = source.createBranchedSession(forkLeafId)
  if (!generatedPath) throw new Error('Failed to create persisted forked session')
  const id = SessionManager.open(generatedPath, path.dirname(targetSessionPath)).getSessionId()

  const header = source.getHeader()
  if (!header) throw new Error('Forked session has no header')
  const entries = [{ ...header, id }, ...source.getEntries()]
  fs.writeFileSync(
    targetSessionPath,
    `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
    { flag: 'wx' },
  )
  if (fs.existsSync(generatedPath)) fs.unlinkSync(generatedPath)
}
