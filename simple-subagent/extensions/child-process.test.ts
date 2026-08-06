import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import test from 'node:test'
import { getPiInvocation } from './child-process.ts'

test('reuses the current Pi entrypoint instead of relying on a platform command shim', () => {
  const currentScript = process.argv[1]
  assert.ok(currentScript)
  assert.equal(fs.existsSync(currentScript), true)

  const args = ['--mode', 'json']
  assert.deepEqual(getPiInvocation(args), {
    command: process.execPath,
    args: [currentScript, ...args],
  })
})
