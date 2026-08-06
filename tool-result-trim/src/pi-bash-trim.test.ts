import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { trimOutput } from 'pi-bash-trim'
import registerToolResultTrim from './index.ts'

describe('pi-bash-trim dependency', () => {
  test('trims output through the pinned library', () => {
    const text = Array.from(
      { length: 30 },
      (_, index) => `PASS test case ${index} completed in ${index}ms`,
    ).join('\n')

    const result = trimOutput(text, {
      minTokensToTrim: 0,
      maxTotalTokens: 40,
      minDedupLines: 4,
    })

    assert.ok(result.dedupedLines > 0)
    assert.match(result.text, /similar/)
  })

  test('registers pi-bash-trim and skips bash/read in the generic handler', async () => {
    const originalHome = process.env.HOME
    process.env.HOME = mkdtempSync(join(tmpdir(), 'pi-tool-result-trim-test-'))

    const handlers: Array<(event: unknown) => unknown> = []
    const pi = {
      on(eventName: string, handler: (event: unknown) => unknown) {
        if (eventName === 'tool_result') handlers.push(handler)
      },
    } as unknown as ExtensionAPI

    try {
      registerToolResultTrim(pi)

      assert.equal(handlers.length, 2)
      const genericHandler = handlers[1]
      assert.ok(genericHandler)
      assert.equal(await genericHandler({ toolName: 'bash' }), undefined)
      assert.equal(await genericHandler({ toolName: 'read' }), undefined)
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
    }
  })
})
