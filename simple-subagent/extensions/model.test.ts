import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveEffectiveModel } from './model.ts'

const aliases = {
  opus: 'anthropic/claude-opus-5',
  codex: 'openai-codex/gpt-5.6-sol',
}

test('resolves configured model aliases', () => {
  assert.equal(resolveEffectiveModel('opus', aliases), 'anthropic/claude-opus-5')
})

test('accepts explicit full model names', () => {
  assert.equal(
    resolveEffectiveModel('anthropic/claude-sonnet-4-6', aliases),
    'anthropic/claude-sonnet-4-6',
  )
})

test('rejects unknown bare model aliases', () => {
  assert.throws(() => resolveEffectiveModel('opuz', aliases), /Unknown model alias "opuz"/)
})

test('returns undefined when no model override is supplied', () => {
  assert.equal(resolveEffectiveModel(undefined, aliases), undefined)
})
