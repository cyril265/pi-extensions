import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openHerdrForkTab } from './herdr-tab.ts'

const HERDR_ENV_NAMES = [
  'HERDR_BIN_PATH',
  'HERDR_ENV',
  'HERDR_PANE_ID',
  'HERDR_WORKSPACE_ID',
  'SIMPLE_SUBAGENT_TEST_LOG',
] as const

test('opens a personal session fork in a new Herdr tab', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'simple-subagent-fork-tab-'))
  const executable = path.join(directory, 'herdr')
  const logPath = path.join(directory, 'calls.jsonl')
  const previousEnvironment = new Map(
    HERDR_ENV_NAMES.map(name => [name, process.env[name]] as const),
  )

  try {
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.SIMPLE_SUBAGENT_TEST_LOG, JSON.stringify(args) + '\\n')
if (args[0] === 'tab' && args[1] === 'create') {
  console.log(JSON.stringify({ result: { root_pane: { pane_id: 'w1:p9' }, tab: { tab_id: 'w1:t3' } } }))
} else {
  console.log(JSON.stringify({ result: {} }))
}
`,
    )
    await chmod(executable, 0o755)
    process.env.HERDR_BIN_PATH = executable
    process.env.HERDR_ENV = '1'
    process.env.HERDR_PANE_ID = 'w1:p1'
    process.env.HERDR_WORKSPACE_ID = 'w1'
    process.env.SIMPLE_SUBAGENT_TEST_LOG = logPath

    openHerdrForkTab('openai/gpt-5.4', 'xhigh', directory, '/tmp/parent session.jsonl')

    const calls = (await readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as string[])
    assert.deepEqual(calls[0], [
      'tab',
      'create',
      '--workspace',
      'w1',
      '--cwd',
      directory,
      '--focus',
    ])
    assert.equal(calls[1][0], 'pane')
    assert.equal(calls[1][1], 'run')
    assert.equal(calls[1][2], 'w1:p9')
    const command = calls[1][3]
    assert.ok(command.includes("'--fork' '/tmp/parent session.jsonl'"))
    assert.ok(command.includes("'--model' 'openai/gpt-5.4'"))
    assert.ok(command.includes("'--thinking' 'xhigh'"))
    assert.ok(!command.includes('PI_SIMPLE_SUBAGENT'))
    assert.ok(!command.includes('--session-dir'))
  } finally {
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(directory, { recursive: true })
  }
})

test('closes a new Herdr tab when launching its fork fails', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'simple-subagent-fork-tab-failure-'))
  const executable = path.join(directory, 'herdr')
  const logPath = path.join(directory, 'calls.jsonl')
  const previousEnvironment = new Map(
    HERDR_ENV_NAMES.map(name => [name, process.env[name]] as const),
  )

  try {
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.SIMPLE_SUBAGENT_TEST_LOG, JSON.stringify(args) + '\\n')
if (args[0] === 'tab' && args[1] === 'create') {
  console.log(JSON.stringify({ result: { root_pane: { pane_id: 'w1:p9' }, tab: { tab_id: 'w1:t3' } } }))
} else if (args[0] === 'pane' && args[1] === 'run') {
  console.error(JSON.stringify({ error: { message: 'pane run failed' } }))
  process.exit(1)
} else {
  console.log(JSON.stringify({ result: {} }))
}
`,
    )
    await chmod(executable, 0o755)
    process.env.HERDR_BIN_PATH = executable
    process.env.HERDR_ENV = '1'
    process.env.HERDR_PANE_ID = 'w1:p1'
    process.env.HERDR_WORKSPACE_ID = 'w1'
    process.env.SIMPLE_SUBAGENT_TEST_LOG = logPath

    assert.throws(
      () =>
        openHerdrForkTab(
          'anthropic/claude-sonnet-4-5',
          'high',
          directory,
          '/tmp/parent-session.jsonl',
        ),
      /herdr pane run failed: pane run failed/,
    )

    const calls = (await readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as string[])
    assert.deepEqual(calls[2], ['tab', 'close', 'w1:t3'])
  } finally {
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(directory, { recursive: true })
  }
})
