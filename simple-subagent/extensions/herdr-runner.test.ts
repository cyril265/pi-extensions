import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { getHerdrParentLabel, parseHerdrFailure, partitionParentRecords } from './herdr-runner.ts'
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

test('partitions finished records and reuses the newest live one', () => {
  const records = [
    record({ id: 'a', paneId: 'p1', status: 'done', createdAt: '2026-01-01T00:00:01.000Z' }),
    record({ id: 'b', paneId: 'p2', status: 'running', createdAt: '2026-01-01T00:00:02.000Z' }),
    record({ id: 'c', paneId: 'p3', status: 'running', createdAt: '2026-01-01T00:00:03.000Z' }),
    record({ id: 'dead-pane', paneId: 'gone' }),
    record({ id: 'other-parent', paneId: 'p4', parentSessionId: 'other' }),
    record({ id: 'other-workspace', paneId: 'p5', workspaceId: 'other' }),
  ]
  const paneStatuses = new Map<string, string | undefined>([
    ['p1', 'idle'],
    ['p2', 'done'],
    ['p3', 'working'],
    ['p4', 'idle'],
    ['p5', 'idle'],
  ])
  const { finished, reusable } = partitionParentRecords(
    records,
    paneStatuses,
    'workspace',
    'parent-session',
  )
  assert.deepEqual(
    finished.map(item => item.id),
    ['a', 'b'],
  )
  assert.equal(reusable?.id, 'c')
})

test('does not close active panes even when the record says finished', () => {
  const records = [record({ id: 'a', paneId: 'p1', status: 'done' })]
  const paneStatuses = new Map<string, string | undefined>([['p1', 'working']])
  const { finished, reusable } = partitionParentRecords(
    records,
    paneStatuses,
    'workspace',
    'parent-session',
  )
  assert.deepEqual(finished, [])
  assert.equal(reusable?.id, 'a')
})

test('returns no reusable record when everything finished', () => {
  const records = [record({ id: 'a', paneId: 'p1', status: 'failed' })]
  const paneStatuses = new Map<string, string | undefined>([['p1', 'idle']])
  const { finished, reusable } = partitionParentRecords(
    records,
    paneStatuses,
    'workspace',
    'parent-session',
  )
  assert.deepEqual(
    finished.map(item => item.id),
    ['a'],
  )
  assert.equal(reusable, undefined)
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
