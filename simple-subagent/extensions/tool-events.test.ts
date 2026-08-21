import assert from 'node:assert/strict'
import test from 'node:test'
import type { Message } from '@earendil-works/pi-ai'
import { getFinalOutput } from './tool-events.ts'

test('joins every text block from the last assistant message', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: 'old' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'first' },
        { type: 'thinking', thinking: 'hidden' },
        { type: 'text', text: 'second' },
      ],
    },
  ] as Message[]

  assert.equal(getFinalOutput(messages), 'firstsecond')
})
