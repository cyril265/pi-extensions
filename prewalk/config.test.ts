import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { loadConfig, saveConfig } from './config.ts'

function tempConfigPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prewalk-test-')), 'prewalk.json')
}

test('missing config returns undefined', () => {
  assert.equal(loadConfig(tempConfigPath()), undefined)
})

test('save and load round-trip', () => {
  const configPath = tempConfigPath()
  const config = { executor: { model: 'fast/executor', thinking: 'low' as const } }
  saveConfig(configPath, config)
  assert.deepEqual(loadConfig(configPath), config)
})

test('rejects malformed configs', () => {
  const configPath = tempConfigPath()

  fs.writeFileSync(configPath, '[]')
  assert.throws(() => loadConfig(configPath), /JSON object/)

  fs.writeFileSync(configPath, '{"executor":{"model":"no-slash","thinking":"low"}}')
  assert.throws(() => loadConfig(configPath), /provider\/model/)

  fs.writeFileSync(configPath, '{"executor":{"model":"fast/executor","thinking":"turbo"}}')
  assert.throws(() => loadConfig(configPath), /thinking/)

  fs.writeFileSync(configPath, '{"executor":"fast/executor"}')
  assert.throws(() => loadConfig(configPath), /"executor" must be an object/)
})
