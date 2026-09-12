import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { measure, parseTrace, summarize, wilson } from './metrics.ts'
import { buildPlan, parseOptions, verifyFixture } from './runner.ts'
import { getScenario, scenarios } from './scenarios.ts'
import { pairedComparisons, renderReport } from './report.ts'
import type { TraceEvent, RunResult } from './types.ts'

function event(type: string, data: Record<string, any> = {}, at = 1, role: TraceEvent['role'] = 'parent', sessionId: string = role): TraceEvent {
  return { type, data, at, role, pid: 1, sessionId }
}

test('plans paired repetitions with reproducible randomized interface order', () => {
  const options = parseOptions(['--cases', 'parallel-repair', '--variants', 'native,client', '--repeats', '4'])
  const plan = buildPlan(options)
  assert.deepEqual(plan, buildPlan(options))
  assert.equal(plan.length, 8)
  for (const repeat of [1, 2, 3, 4]) {
    const block = plan.filter(item => item.repeat === repeat)
    assert.equal(new Set(block.map(item => item.seed)).size, 1)
    assert.deepEqual(new Set(block.map(item => item.variant)), new Set(options.variants))
  }
  assert.ok(new Set([1, 2, 3, 4].map(repeat => plan.filter(item => item.repeat === repeat).map(item => item.variant).join(','))).size > 1)
  assert.equal(options.execute, false)
  assert.throws(() => parseOptions(['--variants', 'fictional']))
  assert.throws(() => parseOptions(['--repeats', '0']))
})

test('usage keeps parent, child, cached input, and billed components separate', () => {
  const events = [
    event('provider-request', { bytes: 123 }),
    event('assistant-message', { usage: { input: 10, output: 3, cacheRead: 90, cacheWrite: 2, cost: { total: 0.1 } } }),
    event('provider-request', {}, 2, 'child'),
    event('assistant-message', { usage: { input: 20, output: 8, cacheRead: 40, cost: { total: 0.2 } } }, 3, 'child'),
    event('session-start', {}, 2, 'child'),
  ]
  const result = measure(events)
  assert.equal(result.parent.input, 10)
  assert.equal(result.parent.cacheRead, 90)
  assert.equal(result.parent.cost, 0.1)
  assert.equal(result.child.output, 8)
  assert.equal(result.child.cost, 0.2)
  assert.equal(result.parentRequestBytes, 123)
  assert.equal(result.usageComplete, true)
  assert.equal(measure([...events, event('assistant-message', {}, 4, 'child')]).usageComplete, false)
})

test('detects duplicate delivery without counting child tool errors as parent errors', () => {
  const result = measure([
    event('push', { jobIds: ['a'] }), event('push', { jobIds: ['a'] }),
    event('tool-result', { isError: true }, 2, 'child'),
  ])
  assert.equal(result.duplicatePushes, 1)
  assert.equal(result.parentToolErrors, 0)
  assert.equal(result.childToolErrors, 1)
})

test('summary exposes infrastructure failures and does not reward fast failed attempts', () => {
  const make = (status: RunResult['status'], elapsedMs: number): RunResult => ({
    scenario: 'x', variant: 'client', model: 'provider/model', thinking: 'medium', seed: 1, repeat: 1,
    status, checks: [], artifactDirectory: '/tmp/example', metrics: { ...measure([]), elapsedMs },
  })
  const [summary] = summarize([make('passed', 100), make('failed', 1), make('timeout', 200), make('infrastructure-error', 0)])
  assert.equal(summary.successRate, 1 / 3)
  assert.equal(summary.infrastructureErrors, 1)
  assert.equal(summary.medianElapsedMsPassed, 100)
  assert.ok(summary.successRate95![1] > 1 / 3)
  assert.equal(wilson(0, 0), null)
})

test('trace parser tolerates an incomplete final write but rejects corrupted complete records', () => {
  assert.deepEqual(parseTrace(`${JSON.stringify(event('a'))}\n{"at":`), [event('a')])
  assert.throws(() => parseTrace('{bad}\n'))
})

test('paired comparisons match seeds and repetitions and expose one-sided success', () => {
  const make = (variant: RunResult['variant'], repeat: number, status: RunResult['status'], requests: number): RunResult => ({
    scenario: 'x', variant, model: 'provider/model', thinking: 'medium', seed: repeat, repeat,
    status, checks: [], artifactDirectory: `/tmp/campaign/${variant}-${repeat}`, metrics: { ...measure([]), parent: { ...measure([]).parent, requests } },
  })
  const runs = [make('native', 1, 'passed', 5), make('client', 1, 'passed', 7), make('native', 2, 'passed', 3), make('client', 2, 'failed', 1), make('client', 3, 'passed', 9)]
  const [comparison] = pairedComparisons(runs)
  assert.equal(comparison.matched, 2)
  assert.equal(comparison.bothPassed, 1)
  assert.equal(comparison.onlyRightPassed, 1)
  assert.deepEqual(comparison.parentRequestDeltaRightMinusLeft, [-2])
  assert.match(renderReport(runs, '/tmp/campaign'), /native-1\/result.json/)
})

test('all artifact oracles accept a complete correct outcome', () => {
  for (const scenario of scenarios) {
    const root = mkdtempSync(join(tmpdir(), 'eval-solved-'))
    try {
      const fixture = scenario.fixture(1729)
      for (const [path, text] of Object.entries(fixture.files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
      if (scenario.id === 'run-result-decision') {
        writeFileSync(join(root, 'release-decision.json'), JSON.stringify({ releaseId: 'release-1729', decision: 'block', failingSuites: ['pagination-boundary'] }))
        writeFileSync(join(root, 'oracle.mjs'), fixture.oracle)
        assert.ok(verifyFixture(join(root, 'oracle.mjs'), root).every(check => check.pass))
        writeFileSync(join(root, 'release-decision.json'), JSON.stringify({ releaseId: 'release-1729', decision: 'approve', failingSuites: [] }))
        assert.ok(verifyFixture(join(root, 'oracle.mjs'), root).some(check => !check.pass))
        continue
      }
      mkdirSync(join(root, 'reports'), { recursive: true })
      writeFileSync(join(root, 'src/price.mjs'), 'export const quote = (c,p) => Math.round(c*(100-Math.max(0,Math.min(100,p)))/100);')
      writeFileSync(join(root, 'src/access.mjs'), 'export const canRead = (t,tenant,now) => !!t && t.tenant === tenant && t.expires > now;')
      writeFileSync(join(root, 'docs/client.json'), '{"timeoutMs":30000}')
      writeFileSync(join(root, 'reports/gate.json'), '{"released":true}')
      writeFileSync(join(root, 'reports/verification.json'), '{"passed":true}')
      writeFileSync(join(root, 'reports/followup.json'), '{"ticket":"CASE-1729-PRIVATE"}')
      writeFileSync(join(root, 'reports/outcome.json'), '{"pricing":"done","diagnostics":"failed"}')
      writeFileSync(join(root, 'reports/decision.json'), '{"status":"blocked","tenant":"legacy-a"}')
      writeFileSync(join(root, 'src/labels.mjs'), `export const labels = ${JSON.stringify(["O'Reilly", 'literal $HOME', '$(touch SHOULD_NOT_EXIST)', '`touch ALSO_SHOULD_NOT_EXIST`', '雪-1729', 'two\nlines', '"quoted" \\ path'])};`)
      if (scenario.id === 'large-report') {
        const services = JSON.parse(readFileSync(join(root, 'config/services.json'), 'utf8'))
        for (const service of services) service.timeoutMs = 30000
        writeFileSync(join(root, 'config/services.json'), JSON.stringify(services))
        writeFileSync(join(root, 'reports/audit-summary.json'), '{"violations":["service-1729-89"]}')
      }
      writeFileSync(join(root, 'oracle.mjs'), fixture.oracle)
      const checks = verifyFixture(join(root, 'oracle.mjs'), root)
      assert.ok(checks.every(check => check.pass), `${scenario.id}: ${JSON.stringify(checks)}`)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('every scenario oracle rejects the unfinished fixture', () => {
  for (const scenario of scenarios) {
    const root = mkdtempSync(join(tmpdir(), 'eval-oracle-'))
    try {
      const fixture = scenario.fixture(1729)
      for (const [path, text] of Object.entries(fixture.files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
      writeFileSync(join(root, 'oracle.mjs'), fixture.oracle)
      const checks = verifyFixture(join(root, 'oracle.mjs'), root)
      assert.ok(checks.some(check => !check.pass), `${scenario.id} accepted its unfinished fixture`)
      assert.ok(checks.every(check => check.name !== 'artifact oracle returned valid checks'), scenario.id)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('hidden pricing oracle accepts correct behavior and rejects a superficially plausible patch', () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-price-'))
  try {
    const fixture = getScenario('parallel-repair').fixture(1)
    for (const [path, text] of Object.entries(fixture.files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
    writeFileSync(join(root, 'oracle.mjs'), fixture.oracle)
    writeFileSync(join(root, 'src/price.mjs'), 'export const quote = (c,p) => Math.round(c*(100-Math.max(0,Math.min(100,p)))/100);')
    writeFileSync(join(root, 'src/access.mjs'), 'export const canRead = (t,tenant,now) => !!t && t.tenant === tenant && t.expires > now;')
    assert.ok(verifyFixture(join(root, 'oracle.mjs'), root).every(check => check.pass))
    writeFileSync(join(root, 'src/price.mjs'), 'export const quote = (c,p) => Math.round(c*(100-p)/100);')
    assert.equal(verifyFixture(join(root, 'oracle.mjs'), root).find(check => check.name === 'pricing behavior')?.pass, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('ordering grader rejects premature verification and same-agent verification', () => {
  const grade = getScenario('dependent-verification').gradeTrace!
  const base = [event('session-start', {}, 1, 'child', 'a'), event('session-start', {}, 2, 'child', 'b'), event('tool-result', { changed: ['src/price.mjs'] }, 3, 'child', 'a')]
  const result = { result: { details: { agents: [{ sessionId: 'a', exitCode: 0 }] } } }
  assert.equal(grade([...base, event('probe-start', { mode: 'verify' }, 4, 'child', 'b'), event('job-result', result, 5)]).at(-1)?.pass, false)
  assert.equal(grade([...base, event('job-result', result, 4), event('probe-start', { mode: 'verify' }, 5, 'child', 'a')]).at(-1)?.pass, false)
  assert.equal(grade([...base, event('job-result', {}, 4), event('probe-start', { mode: 'verify' }, 5, 'child', 'b')]).at(-1)?.pass, false)
  assert.equal(grade([...base, event('job-result', result, 4), event('probe-start', { mode: 'verify' }, 5, 'child', 'b')]).at(-1)?.pass, true)
})

test('parent-progress grader rejects work done before delegation or after completion', () => {
  const grade = getScenario('parent-progress').gradeTrace!
  const base = [event('job-start', {}, 10), event('session-start', {}, 11, 'child'), event('probe-start', { mode: 'gate' }, 15, 'child'), event('probe-end', { mode: 'gate' }, 30, 'child')]
  for (const at of [5, 35]) assert.equal(grade([...base, event('artifact-change', { path: 'docs/client.json' }, at, 'harness')]).at(-1)?.pass, false)
  assert.equal(grade([...base, event('artifact-change', { path: 'docs/client.json' }, 20, 'harness')]).at(-1)?.pass, true)
})
