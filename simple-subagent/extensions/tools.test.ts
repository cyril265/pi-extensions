import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  parseStringifiedAgents,
  registerSubagentTools,
  reserveSessionPaths,
  shouldLockSubagentTools,
} from './tools.ts'

test('rejects concurrent session reuse and allows sequential reuse', () => {
  const activePaths = new Set<string>()
  const release = reserveSessionPaths(activePaths, ['/tmp/shared-session.jsonl'])

  assert.throws(
    () => reserveSessionPaths(activePaths, ['/tmp/shared-session.jsonl']),
    /Subagent session is already running/,
  )

  release()
  reserveSessionPaths(activePaths, ['/tmp/shared-session.jsonl'])()
})

test('parses agents when a schema-less provider path delivers them as a JSON string', () => {
  const agents = [{ thinking: 'medium', name: 'a', prompt: 'p', cwd: '/tmp' }]
  assert.deepEqual(parseStringifiedAgents({ agents: JSON.stringify(agents) }), { agents })
})

test('passes through agents that already arrive as an array', () => {
  const args = { agents: [{ thinking: 'low', name: 'b', prompt: 'q', cwd: '/tmp' }] }
  assert.equal(parseStringifiedAgents(args), args)
})

test('surfaces invalid JSON instead of hiding it', () => {
  assert.throws(() => parseStringifiedAgents({ agents: '[{broken' }), SyntaxError)
})

test('lists configured aliases only in the isolated subagent tool description', () => {
  const tools: Array<{ name: string; description: string }> = []
  let startSession: ((event: { reason: 'startup' }, ctx: unknown) => void) | undefined
  const pi = {
    registerTool: (tool: { name: string; description: string }) => tools.push(tool),
    registerMessageRenderer: () => {},
    registerCommand: () => {},
    on: (event: string, handler: unknown) => {
      if (event === 'session_start') {
        startSession = handler as typeof startSession
      }
    },
  } as unknown as ExtensionAPI

  const registered = registerSubagentTools(pi, false, {
    enableForkTool: true,
    modelAliases: {
      opus: 'anthropic/claude-opus-5',
      codex: 'openai-codex/gpt-5.6-sol',
    },
  })
  startSession?.({ reason: 'startup' }, {})

  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]))
  assert.match(byName.runSubAgents.description, /aliases: opus, codex/)
  assert.doesNotMatch(byName.runSubAgentsWithContext.description, /aliases: opus, codex/)
  assert.ok(byName.cancelSubAgents)
  assert.deepEqual(Object.keys(registered), ['dispatchIsolated', 'join', 'listRunning'])
})

test('locks subagent tools only for managed process startup', () => {
  assert.equal(shouldLockSubagentTools(true, 'startup'), true)
  for (const reason of ['reload', 'new', 'resume', 'fork'] as const) {
    assert.equal(shouldLockSubagentTools(true, reason), false)
  }
  assert.equal(shouldLockSubagentTools(false, 'startup'), false)
})

test('keeps tool schemas active while locking their execution during the assigned run', async () => {
  type TestTool = {
    name: string
    execute: (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
    ) => Promise<unknown>
  }
  const tools: TestTool[] = []
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  let activeToolChanges = 0
  const pi = {
    registerTool: (tool: unknown) => tools.push(tool as TestTool),
    registerMessageRenderer: () => {},
    registerCommand: () => {},
    on: (event: string, handler: unknown) =>
      handlers.set(event, handler as (...args: unknown[]) => unknown),
    setActiveTools: () => {
      activeToolChanges += 1
    },
  } as unknown as ExtensionAPI

  registerSubagentTools(pi, true, { enableForkTool: false, modelAliases: {} })
  handlers.get('session_start')?.({ reason: 'startup' }, {})

  const runTool = tools.find(tool => tool.name === 'runSubAgents')
  assert.ok(runTool)
  await assert.rejects(
    runTool.execute('run-call', { agents: [] }, undefined),
    /Subagent tools are unavailable during this run/,
  )

  handlers.get('agent_settled')?.()
  assert.equal(activeToolChanges, 0)
})
