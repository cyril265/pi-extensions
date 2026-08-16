import assert from 'node:assert/strict'
import test from 'node:test'
import type { Message } from '@earendil-works/pi-ai'
import { getAssistantContextTokens } from './usage.ts'

function assistantMessage(stopReason: 'stop' | 'error' | 'aborted'): Message {
  return {
    role: 'assistant',
    stopReason,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 20,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as Message
}

test('calculates context from usage components when totalTokens is unavailable', () => {
  assert.equal(getAssistantContextTokens(assistantMessage('stop')), 35)
})

test('ignores context reported by failed assistant messages', () => {
  assert.equal(getAssistantContextTokens(assistantMessage('error')), undefined)
  assert.equal(getAssistantContextTokens(assistantMessage('aborted')), undefined)
})
