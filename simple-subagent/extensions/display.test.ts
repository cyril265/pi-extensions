import assert from 'node:assert/strict'
import test from 'node:test'
import type { Theme } from '@earendil-works/pi-coding-agent'
import {
  formatElapsed,
  renderAgentsOverview,
  renderDispatchResult,
  renderLiveCompact,
  renderSubagentWidget,
} from './display.ts'

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme

const taggedTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
} as unknown as Theme

test('formats elapsed time compactly', () => {
  assert.equal(formatElapsed(0, 83000), '1m23s')
  assert.equal(formatElapsed(0, 3723000), '1h2m3s')
})

test('renders one compact line per agent with only its latest tool call', () => {
  const output = renderSubagentWidget(
    {
      agents: [
        {
          name: 'alpha',
          thinking: 'medium',
          suppliedModel: 'sol',
          effectiveModel: 'openai-codex/gpt-5.6-sol',
          status: 'running',
          tools: [
            { name: 'read', args: { path: '/tmp/old.ts' } },
            { name: 'bash', args: { command: 'npm test' } },
          ],
        },
        {
          name: 'beta',
          thinking: 'medium',
          effectiveModel: 'anthropic/claude-opus-5',
          status: 'done',
          tools: [],
        },
        {
          name: 'gamma',
          thinking: 'medium',
          status: 'failed',
          tools: [{ name: 'write', args: { path: '/tmp/out' } }],
        },
      ],
    },
    theme,
    'runSubAgents',
    'deadbeef',
    0,
    83000,
  )

  assert.equal(
    output,
    [
      'runSubAgents · job deadbeef · 1 done · 1 running · 1 failed · 1m23s',
      '● alpha · sol · Ran npm test',
      '✓ beta · claude-opus-5',
      '✗ gamma · Wrote /tmp/out',
    ].join('\n'),
  )
  assert.doesNotMatch(output, /old\.ts/)
})

test('renders agent names normally and model labels as accents', () => {
  const agents = [
    {
      name: 'reviewer',
      thinking: 'high' as const,
      suppliedModel: 'sol',
      effectiveModel: 'openai-codex/gpt-5.6-sol',
      status: 'running' as const,
    },
  ]

  const identity = '<text>reviewer</text><muted> · </muted><accent>sol</accent>'
  assert.ok(renderAgentsOverview(agents, taggedTheme).includes(identity))
  assert.ok(renderLiveCompact(agents, taggedTheme).includes(identity))
})

test('renders dispatch results without repeating the raw tool response', () => {
  assert.equal(
    renderDispatchResult(
      'deadbeef',
      [{ name: 'reviewer', sessionKey: 'reviewer-a1b2c3d4' }],
      theme,
    ),
    [
      'dispatched · job deadbeef · 1 agent',
      'reviewer → reviewer-a1b2c3d4',
      'collect with collectSubagents({ jobId: "deadbeef" })',
    ].join('\n'),
  )
})

test('renders completed usage on the agent line', () => {
  assert.equal(
    renderLiveCompact(
      [
        {
          name: 'reviewer',
          thinking: 'low',
          suppliedModel: 'sol',
          status: 'done',
          sessionId: '019f9304-4fcc-7587-a285-772db38d479f',
          sessionPath: '/tmp/reviewer-session.jsonl',
          usage: {
            turns: 1,
            input: 7200,
            output: 8,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.0361,
          },
        },
      ],
      theme,
    ),
    [
      'runSubAgents · 1/1 done',
      '✓ reviewer · sol · 1 turn · 7.2k tokens (7.2k in, 8 out) · $0.0361',
      '  session 019f9304-4fcc-7587-a285-772db38d479f',
      "  pi --session '/tmp/reviewer-session.jsonl'",
    ].join('\n'),
  )
})
