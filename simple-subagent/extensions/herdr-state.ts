import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { writePrivateFile } from './private-files.ts'

export type HerdrSubagentStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted'

export type HerdrSubagentRecord = {
  version: 1
  id: string
  runId: string
  parentPaneId: string
  parentSessionId: string
  parentLabel: string
  workspaceId: string
  tabId: string
  paneId: string
  name: string
  prompt: string
  cwd: string
  sessionKey: string
  sessionPath: string
  status: HerdrSubagentStatus
  createdAt: string
  updatedAt: string
  completedAt?: string
  viewedAt?: string
}

export function getHerdrStateDirectory(): string {
  return (
    process.env.SIMPLE_SUBAGENT_STATE_DIR ||
    path.join(
      process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
      'simple-subagent',
    )
  )
}

export function getHerdrRecordDirectory(): string {
  return path.join(getHerdrStateDirectory(), 'agents')
}

export function getHerdrRecordPath(id: string): string {
  return path.join(getHerdrRecordDirectory(), `${id}.json`)
}

export function ensureHerdrStateDirectory(directory: string): void {
  const stateDirectory = getHerdrStateDirectory()
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
  fs.chmodSync(stateDirectory, 0o700)
  if (directory === stateDirectory) return
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(directory, 0o700)
}

export function writeHerdrRecord(recordPath: string, record: HerdrSubagentRecord): void {
  ensureHerdrStateDirectory(path.dirname(recordPath))
  const temporaryPath = `${recordPath}.${process.pid}.tmp`
  writePrivateFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`)
  fs.renameSync(temporaryPath, recordPath)
}

export function updateHerdrRecord(recordPath: string, changes: Partial<HerdrSubagentRecord>): void {
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as HerdrSubagentRecord
  writeHerdrRecord(recordPath, {
    ...record,
    ...changes,
    updatedAt: new Date().toISOString(),
  })
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export function readHerdrRecords(): HerdrSubagentRecord[] {
  const directory = getHerdrRecordDirectory()
  ensureHerdrStateDirectory(directory)
  const records: HerdrSubagentRecord[] = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!(entry.isFile() && entry.name.endsWith('.json'))) continue
    try {
      const recordPath = path.join(directory, entry.name)
      fs.chmodSync(recordPath, 0o600)
      records.push(
        JSON.parse(fs.readFileSync(recordPath, 'utf8')) as HerdrSubagentRecord,
      )
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
  }
  return records
}

export function pruneHerdrRecords(livePaneIds: Set<string>, now = Date.now()): void {
  const staleAfterMs = 24 * 60 * 60 * 1000
  for (const record of readHerdrRecords()) {
    if (livePaneIds.has(record.paneId)) continue
    if (now - Date.parse(record.updatedAt) < staleAfterMs) continue
    try {
      fs.unlinkSync(getHerdrRecordPath(record.id))
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
  }
}
