import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { writePrivateFile } from './private-files.ts'

test('writes new and existing files with owner-only permissions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'simple-subagent-private-file-'))
  const filePath = path.join(directory, 'result.txt')
  try {
    fs.writeFileSync(filePath, 'old', { mode: 0o644 })
    writePrivateFile(filePath, 'new')

    assert.equal(fs.readFileSync(filePath, 'utf8'), 'new')
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600)
  } finally {
    await rm(directory, { recursive: true })
  }
})
