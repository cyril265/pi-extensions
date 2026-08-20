import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  parseStringifiedAgents,
  registerSubagentTools,
  shouldLockSubagentTools,
} from './tools.ts'

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

  assert.match(tools[0].description, /options opus, codex/)
  assert.doesNotMatch(tools[1].description, /options opus, codex/)
  assert.equal(registered.runSubAgentsTool, tools[0])
  assert.equal(registered.collectSubagentsTool, tools[1])
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
      params: { jobId: string },
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

  const collectTool = tools.find(tool => tool.name === 'collectSubagents')
  assert.ok(collectTool)
  await assert.rejects(
    collectTool.execute('collect-call', { jobId: 'missing' }, undefined),
    /Subagent tools are unavailable during this run/,
  )

  handlers.get('agent_settled')?.()
  await assert.rejects(
    collectTool.execute('collect-call', { jobId: 'missing' }, undefined),
    /Unknown subagent job: missing/,
  )
  assert.equal(activeToolChanges, 0)
})

test('pushes a fork spawn failure from turn_end as steering', async () => {
  const tools: Array<{
    name: string
    execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }> }>
  }> = []
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const sent: Array<{ message: { customType: string; content: string }; options: unknown }> = []
  const pi = {
    registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
    registerMessageRenderer: () => {},
    registerCommand: () => {},
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    getThinkingLevel: () => 'high',
    sendMessage: (message: { customType: string; content: string }, options: unknown) => {
      sent.push({ message, options })
    },
  } as unknown as ExtensionAPI
  const ctx = {
    cwd: '/tmp',
    mode: 'json',
    model: { provider: 'test', id: 'model' },
    isIdle: () => false,
    sessionManager: {
      getSessionFile: () => undefined,
    },
  }

  registerSubagentTools(pi, false, { enableForkTool: true, modelAliases: {} })
  handlers.get('session_start')?.({ reason: 'startup' }, ctx)
  const forkTool = tools.find(tool => tool.name === 'runSubAgentsWithContext')
  assert.ok(forkTool)
  const dispatch = await forkTool.execute(
    'fork-call',
    { agents: [{ name: 'reviewer', prompt: 'Review', sessionKey: 'fork-key' }] },
    undefined,
    undefined,
    ctx,
  )
  assert.match(dispatch.content[0].text, /jobId:/)

  await handlers.get('turn_end')?.({}, ctx)

  assert.equal(sent.length, 1)
  assert.equal(sent[0].message.customType, 'forked-subagent-results')
  assert.match(
    sent[0].message.content,
    /Continue your current work and use these findings where relevant\.\n\nForked subagents failed: Parent context can only be forked from a persisted session/,
  )
  assert.deepEqual(sent[0].options, { deliverAs: 'steer' })
})
