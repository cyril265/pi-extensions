import assert from 'node:assert/strict'
import test from 'node:test'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { formatElapsed, renderSubagentWidget } from './display.ts'

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
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
          status: 'running',
          tools: [
            { name: 'read', args: { path: '/tmp/old.ts' } },
            { name: 'bash', args: { command: 'npm test' } },
          ],
        },
        {
          name: 'beta',
          thinking: 'medium',
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
      'runSubAgents · deadbeef · 1 done · 1 running · 1 failed · 1m23s',
      '● alpha · Ran npm test',
      '✓ beta',
      '✗ gamma · Wrote /tmp/out',
    ].join('\n'),
  )
  assert.doesNotMatch(output, /old\.ts/)
})
