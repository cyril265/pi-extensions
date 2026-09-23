import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseNpmVersionResponse } from '../src/sources.ts'

test('accepts npm version responses as strings or single-element arrays', () => {
  for (const raw of ['"33.0.5"', '[\n  "33.0.5"\n]']) {
    assert.equal(parseNpmVersionResponse('@example/package', raw), '33.0.5')
  }
})

test('rejects missing, ambiguous, or malformed npm version responses', () => {
  for (const raw of ['', 'null', '[]', '["1.0.0","2.0.0"]', '{}', '42', '[42]', '""', '[" "]']) {
    assert.throws(() => parseNpmVersionResponse('@example/package', raw), /Invalid npm view response/)
  }
  assert.throws(() => parseNpmVersionResponse('@example/package', 'not json'), SyntaxError)
})
