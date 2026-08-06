import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  parseStringifiedAgents,
  registerSubagentTools,
  setSubagentToolsActive,
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
    on: (event: string, handler: unknown) => {
      if (event === 'session_start') {
        startSession = handler as typeof startSession
      }
    },
  } as unknown as ExtensionAPI

  registerSubagentTools(pi, false, {
    enableForkTool: true,
    modelAliases: {
      opus: 'anthropic/claude-opus-5',
      codex: 'openai-codex/gpt-5.6-sol',
    },
  })
  startSession?.({ reason: 'startup' }, {})

  assert.match(tools[0].description, /options opus, codex/)
  assert.doesNotMatch(tools[1].description, /options opus, codex/)
})

test('locks subagent tools only for managed process startup', () => {
  assert.equal(shouldLockSubagentTools(true, 'startup'), true)
  for (const reason of ['reload', 'new', 'resume', 'fork'] as const) {
    assert.equal(shouldLockSubagentTools(true, reason), false)
  }
  assert.equal(shouldLockSubagentTools(false, 'startup'), false)
})

test('removes and restores registered subagent tools without changing other tools', () => {
  let activeTools = ['read', 'runSubAgents', 'runSubAgentsWithContext']
  const pi = {
    getActiveTools: () => activeTools,
    getAllTools: () => [
      { name: 'read' },
      { name: 'runSubAgents' },
      { name: 'runSubAgentsWithContext' },
    ],
    setActiveTools: (names: string[]) => {
      activeTools = names
    },
  }

  setSubagentToolsActive(pi, false)
  assert.deepEqual(activeTools, ['read'])

  setSubagentToolsActive(pi, true)
  assert.deepEqual(activeTools, ['read', 'runSubAgents', 'runSubAgentsWithContext'])
})
