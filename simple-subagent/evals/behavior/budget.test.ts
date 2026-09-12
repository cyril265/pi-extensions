import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { budgetReason, readBudget, recordTokens, reserveRequest } from './budget.ts'
import { buildPlan, main, parseOptions, regradeCampaign } from './runner.ts'
import { getScenario } from './scenarios.ts'
import { measure } from './metrics.ts'
import type { RunResult } from './types.ts'
import evaluationExtension from './evaluation-extension.ts'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

test('defaults shrink volume without changing the model or thinking', () => {
  const options = parseOptions([])
  assert.equal(options.models[0], 'openai-codex/gpt-5.6-sol')
  assert.equal(options.thinking, 'medium')
  assert.equal(options.repeats, 1)
  assert.equal(buildPlan(options).length, 4)
  assert.equal(options.campaignRequests, 60)
  assert.equal(options.campaignTokens, 200000)
  assert.equal(options.keepGoing, false)
  assert.equal(options.execute, false)
})

test('oversized live plans are rejected before launching anything', async () => {
  await assert.rejects(main(['--cases', 'all', '--execute']), /exceeding --max-runs/)
  assert.throws(() => parseOptions(['--campaign-requests', '0']))
  assert.throws(() => parseOptions(['--regrade', '/tmp/example', '--execute']), /offline/)
})

test('request admissions are atomic across processes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-budget-'))
  try {
    const module = pathToFileURL(join(import.meta.dirname, 'budget.ts')).href
    const outputs = await Promise.all(Array.from({ length: 8 }, () => new Promise<number>((resolve, reject) => {
      const proc = spawn(process.execPath, ['--input-type=module', '-e', `import {reserveRequest} from ${JSON.stringify(module)}; let admitted=0; for(let i=0;i<4;i++) if(reserveRequest(${JSON.stringify(join(root, 'requests'))},7)) admitted++; console.log(admitted);`], { stdio: ['ignore', 'pipe', 'pipe'] })
      let output = '', error = ''
      proc.stdout.on('data', chunk => { output += chunk }); proc.stderr.on('data', chunk => { error += chunk })
      proc.on('error', reject); proc.on('close', code => code === 0 ? resolve(Number(output.trim())) : reject(new Error(error)))
    })))
    assert.equal(outputs.reduce((sum, count) => sum + count, 0), 7)
    assert.equal(readBudget(root).requests, 7)
    assert.equal(reserveRequest(join(root, 'requests'), 7), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('campaign accounting includes cache usage and persists across trials', () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-budget-'))
  try {
    recordTokens(root, 100); recordTokens(root, 150)
    assert.equal(readBudget(root).tokens, 250)
    const limits = { requests: 10, tokens: 250, seconds: 60 }
    assert.equal(budgetReason(root, limits, 0, 1), 'campaign token limit')
    assert.equal(budgetReason(root, { ...limits, tokens: 251 }, 0, 60000), 'campaign time limit')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('provider hook holds denied calls before they can reach the provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-admission-'))
  const savedConfig = process.env.SUBAGENT_EVAL_CONFIG, savedChild = process.env.PI_SIMPLE_SUBAGENT
  try {
    const configPath = join(root, 'config.json'), tracePath = join(root, 'trace.jsonl')
    writeFileSync(tracePath, '')
    writeFileSync(configPath, JSON.stringify({ workdir: root, watch: [], tracePath, maxRequests: 10,
      campaignBudget: { directory: join(root, 'budget'), requests: 1, tokens: 1000, deadline: Date.now() + 60000, trialDirectory: join(root, 'trial') } }))
    process.env.SUBAGENT_EVAL_CONFIG = configPath; process.env.PI_SIMPLE_SUBAGENT = '1'
    const handlers = new Map<string, any>()
    evaluationExtension({ on: (name: string, handler: any) => handlers.set(name, handler) } as unknown as ExtensionAPI)
    await handlers.get('before_provider_request')({ payload: {} })
    let escaped = false
    void handlers.get('before_provider_request')({ payload: {} }).then(() => { escaped = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(escaped, false)
    const events = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(events.filter(event => event.type === 'provider-request').length, 1)
    assert.equal(events.at(-1).data.reason, 'campaign request limit')
  } finally {
    if (savedConfig === undefined) delete process.env.SUBAGENT_EVAL_CONFIG; else process.env.SUBAGENT_EVAL_CONFIG = savedConfig
    if (savedChild === undefined) delete process.env.PI_SIMPLE_SUBAGENT; else process.env.PI_SIMPLE_SUBAGENT = savedChild
    rmSync(root, { recursive: true, force: true })
  }
})

test('failed-only selection preserves each original model, thinking, seed and repetition', () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-rerun-'))
  try {
    const result = { scenario: 'parallel-repair', variant: 'native', model: 'provider/actual-model', thinking: 'xhigh', seed: 22, repeat: 1, artifactDirectory: root, checks: [], metrics: measure([]) }
    writeFileSync(join(root, 'results.jsonl'), [JSON.stringify({ ...result, status: 'passed' }), JSON.stringify({ ...result, variant: 'client', status: 'failed' })].join('\n'))
    const plan = buildPlan(parseOptions(['--rerun-failed', root]))
    assert.deepEqual(plan, [{ model: 'provider/actual-model', thinking: 'xhigh', scenario: 'parallel-repair', variant: 'client', seed: 22, repeat: 1 }])
    assert.throws(() => parseOptions(['--rerun-failed', root, '--thinking', 'low']), /preserves/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('regrading uses saved artifacts and never rewrites the original result', () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-regrade-'))
  try {
    const trial = join(root, 'trial'), repo = join(trial, 'repo')
    mkdirSync(join(repo, 'docs'), { recursive: true })
    writeFileSync(join(repo, 'docs/client.json'), '{"timeoutMs":30000}')
    writeFileSync(join(trial, 'oracle.mjs'), getScenario('small-local-change').fixture(1).oracle)
    writeFileSync(join(trial, 'config.json'), JSON.stringify({ workdir: repo }))
    writeFileSync(join(trial, 'trace.jsonl'), '')
    const result: RunResult = { model: 'provider/model', thinking: 'high', scenario: 'small-local-change', variant: 'client', seed: 1, repeat: 1,
      artifactDirectory: trial, status: 'failed', checks: [], metrics: measure([]) }
    const original = JSON.stringify(result) + '\n'
    writeFileSync(join(root, 'results.jsonl'), original)
    const [updated] = regradeCampaign(root, join(root, 'regraded'))
    assert.equal(updated.status, 'passed')
    assert.equal(updated.thinking, 'high')
    assert.equal(readFileSync(join(root, 'results.jsonl'), 'utf8'), original)
    assert.equal(JSON.parse(readFileSync(join(root, 'regraded/manifest.json'), 'utf8')).providerCalls, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
