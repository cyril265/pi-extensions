import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { writeUpdateDiff } from '../src/update.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-audit-diff-'))
  mkdirSync(join(root, 'installed'))
  mkdirSync(join(root, 'candidate'))
  return root
}

test('writes a complete diff larger than the default spawnSync buffer', () => {
  const root = fixture()
  try {
    const content = `${'large package content\n'.repeat(100_000)}END-OF-DIFF\n`
    writeFileSync(join(root, 'candidate', 'large.txt'), content)
    const diff = readFileSync(writeUpdateDiff(root), 'utf8')
    assert.ok(Buffer.byteLength(diff) > 1024 * 1024)
    assert.ok(diff.includes('+END-OF-DIFF'))
    assert.equal(diff.split('\n').filter(line => line === '+large package content').length, 100_000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('accepts identical snapshots and writes an empty diff', () => {
  const root = fixture()
  try {
    for (const directory of ['installed', 'candidate']) {
      writeFileSync(join(root, directory, 'same.txt'), 'unchanged\n')
    }
    assert.equal(readFileSync(writeUpdateDiff(root), 'utf8'), '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects git errors and closes the output file', () => {
  const root = fixture()
  const configCount = process.env.GIT_CONFIG_COUNT
  try {
    process.env.GIT_CONFIG_COUNT = 'invalid'
    assert.throws(() => writeUpdateDiff(root), /git diff failed/)
  } finally {
    if (configCount === undefined) delete process.env.GIT_CONFIG_COUNT
    else process.env.GIT_CONFIG_COUNT = configCount
    rmSync(root, { recursive: true, force: true })
  }
})
