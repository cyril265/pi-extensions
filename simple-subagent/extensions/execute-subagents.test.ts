import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatFinishedAgentResult,
  getParentAssignedPrompt,
  INLINE_RESULT_MAX_CHARACTERS,
} from './execute-subagents.ts'
import type { SubagentRunResult } from './types.ts'

const agent = {
  name: 'reviewer',
  thinking: 'medium' as const,
  effectiveModel: 'test/model',
  sessionKey: 'reviewer-key',
}

function result(text: string): SubagentRunResult {
  return {
    text,
    exitCode: 0,
    tools: [],
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
    firstTurnUsage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
    },
  }
}

test('tells assigned agents not to call locked subagent tools', () => {
  assert.equal(
    getParentAssignedPrompt('Review the change.'),
    'Review the change.\n\nDo not call runSubAgents, collectSubagents, or runSubAgentsWithContext during this run; those tools are unavailable.',
  )
})

test('inlines finished agent results at the character threshold', () => {
  const text = 'x'.repeat(INLINE_RESULT_MAX_CHARACTERS)
  const lines = formatFinishedAgentResult(agent, '/tmp/reviewer-result.md', result(text), false)

  assert.deepEqual(lines.slice(0, 3), [
    'reviewer (medium, test/model, exit 0): /tmp/reviewer-result.md',
    'sessionKey: reviewer-key',
    '1 turn, 15 tokens (input 10, output 5), cost $0.0000',
  ])
  assert.deepEqual(lines.slice(3), ['', 'reviewer result:', `    ${text}`])
})

test('keeps larger finished agent results path-only', () => {
  const text = 'x'.repeat(INLINE_RESULT_MAX_CHARACTERS + 1)

  assert.deepEqual(
    formatFinishedAgentResult(agent, '/tmp/reviewer-result.md', result(text), false),
    [
      'reviewer (medium, test/model, exit 0): /tmp/reviewer-result.md',
      'sessionKey: reviewer-key',
      '1 turn, 15 tokens (input 10, output 5), cost $0.0000',
    ],
  )
})

test('indents every line of an inlined result under its agent label', () => {
  const lines = formatFinishedAgentResult(
    agent,
    '/tmp/reviewer-result.md',
    result('first line\n\nlast line'),
    false,
  )

  assert.deepEqual(lines.slice(3), [
    '',
    'reviewer result:',
    '    first line',
    '    ',
    '    last line',
  ])
})
