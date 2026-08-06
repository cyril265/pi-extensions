import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

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

export function writeHerdrRecord(recordPath: string, record: HerdrSubagentRecord): void {
  fs.mkdirSync(path.dirname(recordPath), { recursive: true })
  const temporaryPath = `${recordPath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`)
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
  if (!fs.existsSync(directory)) return []
  const records: HerdrSubagentRecord[] = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!(entry.isFile() && entry.name.endsWith('.json'))) continue
    try {
      records.push(
        JSON.parse(
          fs.readFileSync(path.join(directory, entry.name), 'utf8'),
        ) as HerdrSubagentRecord,
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
