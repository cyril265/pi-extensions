import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'
import { getPackageDir } from '@earendil-works/pi-coding-agent'
import { getPiInvocation, getProcessExitCode } from './child-process.ts'

test('uses the installed Pi CLI entrypoint instead of the SDK host entrypoint', () => {
  const piCli = path.join(getPackageDir(), 'dist', 'cli.js')
  assert.equal(fs.existsSync(piCli), true)

  const args = ['--mode', 'json']
  assert.deepEqual(getPiInvocation(args), {
    command: process.execPath,
    args: [piCli, ...args],
  })
})

test('treats signal termination as a failed exit', () => {
  assert.equal(getProcessExitCode(null), 1)
  assert.equal(getProcessExitCode(0), 0)
  assert.equal(getProcessExitCode(2), 2)
})
