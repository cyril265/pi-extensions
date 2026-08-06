import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readSimpleSubagentConfig } from './config.ts'

test('uses disabled empty settings when the config file is absent', () => {
  assert.deepEqual(readSimpleSubagentConfig('/path/that/does/not/exist.json'), {
    enableForkTool: false,
    modelAliases: {},
  })
})

test('reads the dedicated simple-subagent config', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'simple-subagent-config-'))
  const configPath = path.join(directory, 'simple-subagent.json')

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        enableForkTool: true,
        modelAliases: {
          opus: 'anthropic/claude-opus-5',
          codex: 'openai-codex/gpt-5.6-sol',
        },
      }),
    )

    assert.deepEqual(readSimpleSubagentConfig(configPath), {
      enableForkTool: true,
      modelAliases: {
        opus: 'anthropic/claude-opus-5',
        codex: 'openai-codex/gpt-5.6-sol',
      },
    })
  } finally {
    await rm(directory, { recursive: true })
  }
})

test('rejects aliases that do not map to a full model name', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'simple-subagent-config-'))
  const configPath = path.join(directory, 'simple-subagent.json')

  try {
    await writeFile(
      configPath,
      JSON.stringify({ enableForkTool: false, modelAliases: { opus: 'claude-opus-5' } }),
    )
    assert.throws(
      () => readSimpleSubagentConfig(configPath),
      /Model alias "opus" must map to provider\/model/,
    )
  } finally {
    await rm(directory, { recursive: true })
  }
})

test('allows either setting to be omitted', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'simple-subagent-config-'))
  const configPath = path.join(directory, 'simple-subagent.json')

  try {
    await writeFile(configPath, JSON.stringify({ enableForkTool: true }))
    assert.deepEqual(readSimpleSubagentConfig(configPath), {
      enableForkTool: true,
      modelAliases: {},
    })
  } finally {
    await rm(directory, { recursive: true })
  }
})
