import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  acquireHerdrWorkspaceLock,
  getHerdrParentLabel,
  HERDR_SUBAGENT_TAB_LABEL,
  parseHerdrFailure,
  partitionWorkspaceRecords,
} from './herdr-runner.ts'
import type { HerdrSubagentRecord } from './herdr-state.ts'

function record(overrides: Partial<HerdrSubagentRecord>): HerdrSubagentRecord {
  return {
    version: 1,
    id: 'id',
    runId: 'run',
    parentPaneId: 'parent-pane',
    parentSessionId: 'parent-session',
    parentLabel: 'parent',
    workspaceId: 'workspace',
    tabId: 'tab',
    paneId: 'pane',
    name: 'agent',
    prompt: 'prompt',
    cwd: '/tmp',
    sessionKey: 'key',
    sessionPath: '/tmp/session.jsonl',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('partitions finished workspace records and reuses the newest live one', () => {
  const records = [
    record({ id: 'a', paneId: 'p1', status: 'done', createdAt: '2026-01-01T00:00:01.000Z' }),
    record({ id: 'b', paneId: 'p2', status: 'running', createdAt: '2026-01-01T00:00:02.000Z' }),
    record({ id: 'c', paneId: 'p3', status: 'running', createdAt: '2026-01-01T00:00:03.000Z' }),
    record({ id: 'dead-pane', paneId: 'gone' }),
    record({ id: 'other-parent', paneId: 'p4', parentSessionId: 'other', status: 'done' }),
    record({ id: 'other-workspace', paneId: 'p5', workspaceId: 'other' }),
  ]
  const paneStatuses = new Map<string, string | undefined>([
    ['p1', 'idle'],
    ['p2', 'done'],
    ['p3', 'working'],
    ['p4', 'idle'],
    ['p5', 'idle'],
  ])
  const { finished, reusable } = partitionWorkspaceRecords(records, paneStatuses, 'workspace')
  assert.deepEqual(
    finished.map(item => item.id),
    ['a', 'b', 'other-parent'],
  )
  assert.equal(reusable?.id, 'c')
})

test('does not close active panes even when the record says finished', () => {
  const records = [record({ id: 'a', paneId: 'p1', status: 'done' })]
  const paneStatuses = new Map<string, string | undefined>([['p1', 'working']])
  const { finished, reusable } = partitionWorkspaceRecords(records, paneStatuses, 'workspace')
  assert.deepEqual(finished, [])
  assert.equal(reusable?.id, 'a')
})

test('returns no reusable record when everything finished', () => {
  const records = [record({ id: 'a', paneId: 'p1', status: 'failed' })]
  const paneStatuses = new Map<string, string | undefined>([['p1', 'idle']])
  const { finished, reusable } = partitionWorkspaceRecords(records, paneStatuses, 'workspace')
  assert.deepEqual(
    finished.map(item => item.id),
    ['a'],
  )
  assert.equal(reusable, undefined)
})

test('uses one stable subagent tab label per workspace', () => {
  assert.equal(HERDR_SUBAGENT_TAB_LABEL, 'Subagents')
})

test('serializes subagent tab setup within a workspace', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'simple-subagent-herdr-lock-'))
  const previousStateDirectory = process.env.SIMPLE_SUBAGENT_STATE_DIR
  process.env.SIMPLE_SUBAGENT_STATE_DIR = directory

  try {
    const releaseFirst = await acquireHerdrWorkspaceLock(
      'workspace',
      AbortSignal.timeout(2000),
      1,
    )
    let secondAcquired = false
    const second = acquireHerdrWorkspaceLock('workspace', AbortSignal.timeout(2000), 1).then(
      release => {
        secondAcquired = true
        return release
      },
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(secondAcquired, false)
    releaseFirst()
    const releaseSecond = await second
    assert.equal(secondAcquired, true)
    releaseSecond()
  } finally {
    if (previousStateDirectory === undefined) delete process.env.SIMPLE_SUBAGENT_STATE_DIR
    else process.env.SIMPLE_SUBAGENT_STATE_DIR = previousStateDirectory
    await rm(directory, { recursive: true })
  }
})

test('releases the workspace lock after a hard crash', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'simple-subagent-herdr-crash-lock-'))
  const workspaceId = path.basename(directory)
  const moduleUrl = new URL('./herdr-runner.ts', import.meta.url).href
  let child: ChildProcess | undefined

  try {
    child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { acquireHerdrWorkspaceLock } from ${JSON.stringify(moduleUrl)}; await acquireHerdrWorkspaceLock(${JSON.stringify(workspaceId)}); process.stdout.write('locked\\n'); setInterval(() => {}, 1000);`,
      ],
      {
        env: { ...process.env, SIMPLE_SUBAGENT_STATE_DIR: directory },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
    await new Promise<void>((resolve, reject) => {
      child?.stdout?.once('data', () => resolve())
      child?.once('exit', code => reject(new Error(`Lock holder exited with code ${code}`)))
    })
    const previousStateDirectory = process.env.SIMPLE_SUBAGENT_STATE_DIR
    process.env.SIMPLE_SUBAGENT_STATE_DIR = directory
    try {
      let parentAcquired = false
      const parentLock = acquireHerdrWorkspaceLock(
        workspaceId,
        AbortSignal.timeout(2000),
        1,
      ).then(release => {
        parentAcquired = true
        return release
      })
      await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(parentAcquired, false)
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
      const release = await parentLock
      assert.equal(parentAcquired, true)
      release()
    } finally {
      if (previousStateDirectory === undefined) delete process.env.SIMPLE_SUBAGENT_STATE_DIR
      else process.env.SIMPLE_SUBAGENT_STATE_DIR = previousStateDirectory
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(directory, { recursive: true })
  }
})

test('reads structured Herdr command errors from stderr', () => {
  assert.deepEqual(
    parseHerdrFailure(
      '',
      JSON.stringify({
        id: 'cli:agent:start',
        error: {
          code: 'agent_pane_busy',
          message: 'agent target pane is not an available shell',
        },
      }),
    ),
    {
      code: 'agent_pane_busy',
      message: 'agent target pane is not an available shell',
    },
  )
})

test('includes the Herdr command in raw CLI errors', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'simple-subagent-herdr-error-'))
  const executable = path.join(directory, 'herdr')
  const previousBinary = process.env.HERDR_BIN_PATH
  const previousTabId = process.env.HERDR_TAB_ID

  try {
    await writeFile(executable, '#!/bin/sh\necho "unknown option: --cwd" >&2\nexit 2\n')
    await chmod(executable, 0o755)
    process.env.HERDR_BIN_PATH = executable
    process.env.HERDR_TAB_ID = 'test-tab'

    await assert.rejects(
      getHerdrParentLabel('fallback', directory),
      error => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /herdr tab get failed: unknown option: --cwd/)
        assert.match(error.message, /Run `\/reload` to load the current simple-subagent code/)
        return true
      },
    )
  } finally {
    if (previousBinary === undefined) delete process.env.HERDR_BIN_PATH
    else process.env.HERDR_BIN_PATH = previousBinary
    if (previousTabId === undefined) delete process.env.HERDR_TAB_ID
    else process.env.HERDR_TAB_ID = previousTabId
    await rm(directory, { recursive: true })
  }
})
