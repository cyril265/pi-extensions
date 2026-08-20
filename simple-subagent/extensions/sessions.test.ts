import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import {
  createForkedSession,
  ensureUniqueForkSessionId,
  formatPiSessionCommand,
} from './sessions.ts'

test('quotes resumable Pi session paths for the shell', () => {
  assert.equal(
    formatPiSessionCommand("/tmp/reviewer's session.jsonl"),
    "pi --session '/tmp/reviewer'\\''s session.jsonl'",
  )
})

test('forked subagents have unique resumable Pi session IDs', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'simple-subagent-session-'))
  try {
    const sourceId = '019f9304-4fcc-7587-a285-772db38d479f'
    const leafId = '12345678'
    const sourcePath = path.join(directory, 'parent.jsonl')
    await writeFile(
      sourcePath,
      [
        JSON.stringify({
          type: 'session',
          version: 3,
          id: sourceId,
          timestamp: new Date().toISOString(),
          cwd: directory,
        }),
        JSON.stringify({
          type: 'message',
          id: leafId,
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: 'parent', timestamp: Date.now() },
        }),
        '',
      ].join('\n'),
    )
    const targetPath = path.join(directory, 'fork.jsonl')

    createForkedSession(sourcePath, leafId, targetPath)
    const forkId = SessionManager.open(targetPath, directory).getSessionId()
    assert.notEqual(forkId, sourceId)

    const content = await readFile(targetPath, 'utf8')
    const newline = content.indexOf('\n')
    const header = JSON.parse(content.slice(0, newline)) as object
    await writeFile(
      targetPath,
      `${JSON.stringify({ ...header, id: sourceId })}${content.slice(newline)}`,
    )
    const migratedId = ensureUniqueForkSessionId(targetPath, sourceId)
    assert.notEqual(migratedId, sourceId)
    assert.equal(SessionManager.open(targetPath, directory).getSessionId(), migratedId)
  } finally {
    await rm(directory, { recursive: true })
  }
})
