import type { Check, Fixture, Scenario, TraceEvent } from './types.ts'

const helper = String.raw`import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const config = JSON.parse(readFileSync(process.env.SUBAGENT_EVAL_CONFIG, 'utf8'));
const mode = process.argv[2];
function emit(type, data = {}) {
  appendFileSync(config.tracePath, JSON.stringify({at: Date.now(), type, role: process.env.PI_SIMPLE_SUBAGENT === '1' ? 'child' : 'parent', pid: Number(process.env.SUBAGENT_EVAL_ACTOR_PID), sessionId: process.env.SUBAGENT_EVAL_SESSION, data: {mode, probePid: process.pid, ...data}}) + '\n');
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
mkdirSync('reports', {recursive:true});
emit('probe-start');
if (mode === 'gate') {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && !readFileSync('docs/client.json', 'utf8').includes('30000')) await pause(100);
  const released = readFileSync('docs/client.json', 'utf8').includes('30000');
  writeFileSync('reports/gate.json', JSON.stringify({released}));
  emit('probe-end', {released});
  console.log(JSON.stringify({released}));
} else if (mode === 'verify') {
  const {quote} = await import(pathToFileURL(resolve('src/price.mjs')));
  const passed = quote(199, 10) === 179 && quote(100, 150) === 0;
  writeFileSync('reports/verification.json', JSON.stringify({passed}));
  emit('probe-end', {passed});
  console.log(JSON.stringify({passed}));
  if (!passed) process.exitCode = 1;
} else if (mode === 'crash') {
  if (process.env.PI_SIMPLE_SUBAGENT !== '1') throw new Error('Crash probe must run in a delegated worker');
  let first = false;
  try { closeSync(openSync(config.tracePath + '.crashed', 'wx')); first = true } catch {}
  if (first) {
    emit('fault-injected');
    process.kill(Number(process.env.SUBAGENT_EVAL_ACTOR_PID), 'SIGTERM');
  } else {
    writeFileSync('reports/recovered.json', JSON.stringify({recovered:true}));
    emit('probe-end', {recovered:true});
  }
} else if (mode === 'cancel') {
  await pause(90000);
  writeFileSync('reports/uncancelled.json', '{}');
  emit('probe-end');
} else { throw new Error('Unknown probe mode: ' + mode) }
`

const oraclePrelude = String.raw`import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const checks = [];
async function check(name, fn) { try { await fn(); checks.push({name, pass:true}); } catch(error) { checks.push({name, pass:false, detail:String(error.message)}); } }
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const moduleAt = path => import(pathToFileURL(resolve(path)));
`

const priceCheck = String.raw`await check('pricing behavior', async () => {
  const {quote} = await moduleAt('src/price.mjs');
  for (const [cents, discount, expected] of [[199,10,179],[100,150,0],[100,-10,100],[51,50,26],[0,30,0]]) assert.equal(quote(cents,discount),expected);
});`
const accessCheck = String.raw`await check('tenant and expiry behavior', async () => {
  const {canRead} = await moduleAt('src/access.mjs');
  assert.equal(canRead({tenant:'a',expires:101}, 'a',100),true);
  assert.equal(canRead({tenant:'a',expires:100}, 'a',100),false);
  assert.equal(canRead({tenant:'a',expires:101}, 'b',100),false);
  assert.equal(canRead(null,'a',100),false);
});`
const jsonCheck = (path: string, expected: unknown) => `await check(${JSON.stringify(path)}, () => assert.deepEqual(json(${JSON.stringify(path)}), ${JSON.stringify(expected)}));`

function fixture(prompt: string, checks: string, extra: Record<string, string> = {}): Fixture {
  return {
    files: {
      'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
      'src/price.mjs': 'export function quote(cents, discount) { return cents * (100 - discount) / 100 }\n',
      'src/access.mjs': 'export function canRead(token, tenant, now) { return !!token && token.expires >= now }\n',
      'test/price.test.mjs': "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {quote} from '../src/price.mjs'; test('zero discount', () => assert.equal(quote(100,0),100));\n",
      'docs/contract.md': 'quote(cents, discount) returns integer cents rounded to nearest integer, with discount percentage clamped to [0,100]. Inputs are finite numbers and cents is nonnegative. canRead(token, tenant, now) accepts only a non-null token whose tenant matches exactly and whose expires is strictly greater than now.\n',
      'docs/client.json': '{"timeoutMs":5000}\n',
      'tools/probe.mjs': helper,
      ...extra,
    },
    prompt,
    oracle: `${oraclePrelude}\n${checks}\nconsole.log(JSON.stringify(checks));\n`,
    watch: ['src/price.mjs', 'src/access.mjs', 'docs/client.json', 'reports/verification.json'],
  }
}

function childCount(events: TraceEvent[], minimum: number): Check {
  const count = new Set(events.filter(e => e.type === 'session-start' && e.role === 'child').map(e => e.sessionId)).size
  return { name: `at least ${minimum} independent child sessions`, pass: count >= minimum, detail: `observed ${count}` }
}

export const scenarios: Scenario[] = [
  {
    id: 'parallel-repair',
    question: 'Can independent delegated changes finish correctly without lost work or serial launch overhead?',
    fixture: () => fixture(
      'Have two independent subagents fix the pricing and access-control implementations against docs/contract.md. Give each exclusive ownership of its implementation file and relevant tests. Integrate their findings and ensure both behaviors work. Do not implement their changes yourself.',
      `${priceCheck}\n${accessCheck}`,
    ),
    gradeTrace: events => [childCount(events, 2)],
  },
  {
    id: 'parent-progress',
    question: 'Does the parent make useful progress while a child is still working?',
    fixture: () => fixture(
      'Delegate the pricing fix from docs/contract.md to a worker. Its verification must include node tools/probe.mjs gate, an integration check that waits for the client configuration update. While the worker works, YOU update docs/client.json to timeoutMs 30000. Keep file ownership separate; do not hand your configuration update to the worker. Finish both tasks.',
      `${priceCheck}\n${jsonCheck('docs/client.json', { timeoutMs: 30000 })}\n${jsonCheck('reports/gate.json', { released: true })}`,
    ),
    gradeTrace: events => {
      const probe = events.find(e => e.type === 'probe-start' && e.role === 'child' && e.data.mode === 'gate')
      const end = events.find(e => e.type === 'probe-end' && e.role === 'child' && e.data.mode === 'gate')
      const progress = events.find(e => e.type === 'artifact-change' && e.data.path === 'docs/client.json')
      const childStart = events.find(e => e.type === 'job-start')
      return [childCount(events, 1), {
        name: 'parent-owned artifact changes while a delegated job is pending',
        pass: !!childStart && !!progress && !!end && childStart.at <= progress.at && progress.at <= end.at,
        detail: `child=${childStart?.at}, artifact=${progress?.at}, checkEnd=${end?.at}; probe started=${probe?.at}`,
      }]
    },
  },
  {
    id: 'dependent-verification',
    question: 'Can a different agent verify a completed implementation, with no premature verification?',
    fixture: () => fixture(
      'Have one subagent implement the pricing contract in docs/contract.md. After that agent finishes, have a DIFFERENT subagent independently inspect the changes and run node tools/probe.mjs verify. The verifier must not edit production code. Also update docs/client.json to timeoutMs 30000 yourself while delegated work proceeds. Finish with verified behavior.',
      `${priceCheck}\n${jsonCheck('reports/verification.json', { passed: true })}\n${jsonCheck('docs/client.json', { timeoutMs: 30000 })}`,
    ),
    gradeTrace: events => {
      const verify = events.find(e => e.type === 'probe-start' && e.role === 'child' && e.data.mode === 'verify')
      const writer = events.find(e => e.type === 'tool-result' && e.role === 'child' && e.data.changed?.includes('src/price.mjs'))
      const prior = events.find(e => e.type === 'job-result' && e.at < (verify?.at ?? 0) && e.data.result?.details?.agents?.some((agent: any) => agent.sessionId === writer?.sessionId && agent.exitCode === 0))
      return [childCount(events, 2), {
        name: 'verification follows a completed job by a different child',
        pass: !!prior && !!verify && !!writer && verify.sessionId !== writer.sessionId,
      }]
    },
  },
  {
    id: 'large-report',
    question: 'Can the parent use findings beyond inline/tool-output limits without losing important tail findings?',
    fixture: seed => {
      const services = Array.from({ length: 90 }, (_, index) => ({ name: `service-${seed}-${index}`, timeoutMs: index === 89 ? 0 : 30000 }))
      return fixture(
        'Have a subagent audit config/services.json against docs/service-policy.md. Ask it to return a complete per-service report in its final response, ending with actionable violations. Use its findings to fix the configuration and write reports/audit-summary.json with a violations array of affected service names. The audit should be independent; you own the final configuration correction.',
        `await check('all services corrected', () => { const services = json('config/services.json'); assert.equal(services.length,90); assert.ok(services.every(s => s.timeoutMs === 30000)); });\n${jsonCheck('reports/audit-summary.json', { violations: [`service-${seed}-89`] })}`,
        { 'config/services.json': JSON.stringify(services, null, 2), 'docs/service-policy.md': 'Every service must have timeoutMs 30000. Audit each service by name and observed value.\n' },
      )
    },
    gradeTrace: events => [childCount(events, 1), {
      name: 'actually exercised a report beyond the inline threshold',
      pass: events.some(e => e.role === 'child' && e.type === 'assistant-message' && (e.data.text?.length ?? 0) > 2048),
    }],
  },
  {
    id: 'quoting-and-paths',
    question: 'Do prompts, literal configuration strings, and paths survive shell metacharacters?',
    fixture: seed => {
      const values = ["O'Reilly", 'literal $HOME', '$(touch SHOULD_NOT_EXIST)', '`touch ALSO_SHOULD_NOT_EXIST`', `雪-${seed}`, 'two\nlines', '"quoted" \\ path']
      return fixture(
        `Delegate implementing src/labels.mjs to a worker. It must export labels equal to this exact JSON array: ${JSON.stringify(values)}. These are literal application labels, including punctuation and the embedded newline. Have the worker add tests. Inspect the result.`,
        `await check('literal labels survive', async () => assert.deepEqual((await moduleAt('src/labels.mjs')).labels, ${JSON.stringify(values)}));\nawait check('no accidental command substitution', () => {assert.equal(existsSync('SHOULD_NOT_EXIST'),false); assert.equal(existsSync('ALSO_SHOULD_NOT_EXIST'),false);});`,
        { 'src/labels.mjs': 'export const labels = []\n' },
      )
    },
    gradeTrace: events => [childCount(events, 1)],
  },
  {
    id: 'session-followup',
    question: 'Can a follow-up reuse the reviewer session rather than lose context or restart the investigation?',
    fixture: seed => {
      const value = fixture(
        'Have a reviewer inspect docs/private-review-note.json and the pricing implementation, retain the note in its context, and report what needs fixing. Do not change files yet. I will ask the same reviewer for a follow-up.',
        `${priceCheck}\n${jsonCheck('reports/followup.json', { ticket: `CASE-${seed}-PRIVATE` })}`,
        { 'docs/private-review-note.json': JSON.stringify({ ticket: `CASE-${seed}-PRIVATE`, requirement: 'Fix pricing according to docs/contract.md.' }) },
      )
      value.followUp = {
        trigger: 'idle', remove: ['docs/private-review-note.json'],
        prompt: 'Ask that same reviewer to continue its existing session, fix the pricing issue, and write reports/followup.json containing the ticket from its earlier note. The note file is now unavailable. Have it run the tests.',
      }
      return value
    },
    gradeTrace: events => {
      const sessions = events.filter(e => e.type === 'session-start' && e.role === 'child').map(e => e.sessionId)
      return [{ name: 'child session reused across processes', pass: sessions.length >= 2 && new Set(sessions).size < sessions.length }]
    },
  },
  {
    id: 'partial-failure',
    question: 'Does a real worker crash preserve unrelated successful changes and produce an accurate outcome?',
    fixture: () => fixture(
      'Delegate two independent tasks: a worker fixes pricing against docs/contract.md; a diagnostic worker runs node tools/probe.mjs crash. The diagnostic probe may terminate its worker process. Preserve the pricing work even if diagnostics fail. You may retry diagnostics once. Write reports/outcome.json with pricing:"done" and diagnostics either "failed" or "recovered", matching what actually happened.',
      `${priceCheck}\nawait check('accurate partial outcome', () => {const outcome=json('reports/outcome.json'); assert.equal(outcome.pricing,'done'); assert.equal(outcome.diagnostics,existsSync('reports/recovered.json') ? 'recovered' : 'failed');});`,
    ),
    gradeTrace: events => [childCount(events, 2), { name: 'real child process fault exercised', pass: events.some(e => e.type === 'fault-injected' && e.role === 'child') }],
  },
  {
    id: 'cancellation',
    question: 'Can the parent cancel active work promptly when the user changes priorities?',
    fixture: () => {
      const value = fixture(
        'Start a background diagnostic worker whose task is to run node tools/probe.mjs cancel and report its result. Meanwhile update docs/client.json to timeoutMs 30000 yourself. Keep the diagnostic running unless I tell you to stop it.',
        `${jsonCheck('docs/client.json', { timeoutMs: 30000 })}\nawait check('cancelled diagnostic did not finish', () => assert.equal(existsSync('reports/uncancelled.json'),false));`,
      )
      value.followUp = { trigger: 'probe-start', prompt: 'Cancel the diagnostic worker now. Do not restart it. Finish the client timeout update if needed and report the cancellation.' }
      return value
    },
    gradeTrace: events => {
      const request = events.find(e => e.type === 'follow-up')
      const cancelled = events.find(e => e.type === 'cancel' && e.data.accepted && e.at >= (request?.at ?? Infinity))
      const result = events.find(e => e.type === 'job-result' && e.data.jobId === cancelled?.data.jobId && e.at >= (cancelled?.at ?? Infinity))
      return [
        { name: 'active child was exercised', pass: events.some(e => e.type === 'probe-start' && e.role === 'child' && e.data.mode === 'cancel') },
        { name: 'user cancellation reached the runtime', pass: !!request && !!cancelled },
        { name: 'cancelled job settled within 15 seconds', pass: !!result && !!cancelled && result.at - cancelled.at <= 15000 },
        { name: 'cancelled subprocess stopped before harness cleanup', pass: events.some(e => e.type === 'cancelled-probe-state' && e.data.alive === false) },
      ]
    },
  },
  {
    id: 'semantic-blocker',
    question: 'Does the parent distinguish an agent reporting a blocker from successful task completion?',
    fixture: () => {
      const original = '{"tenant":"legacy-a","region":"eu"}\n'
      return fixture(
        'Have an analyst check whether config/tenant.json can be migrated using config/mapping.json. Only if the mapping supplies the destination for this tenant, delegate an implementation to update the tenant. Never invent a destination. Write reports/decision.json with status "migrated" or "blocked" and the relevant tenant. Independently update docs/client.json to timeoutMs 30000.',
        `${jsonCheck('reports/decision.json', { status: 'blocked', tenant: 'legacy-a' })}\nawait check('blocked migration preserved original bytes', () => assert.equal(readFileSync('config/tenant.json','utf8'),${JSON.stringify(original)}));\n${jsonCheck('docs/client.json', { timeoutMs: 30000 })}`,
        { 'config/tenant.json': original, 'config/mapping.json': '{"legacy-b":"new-b"}\n' },
      )
    },
    gradeTrace: events => [childCount(events, 1)],
  },
  {
    id: 'small-local-change',
    question: 'Does exposing delegation cause unnecessary overhead on a trivial local task?',
    fixture: () => fixture('Change docs/client.json so timeoutMs is 30000. Preserve its JSON structure.', jsonCheck('docs/client.json', { timeoutMs: 30000 })),
  },
]

export function getScenario(id: string): Scenario {
  const scenario = scenarios.find(value => value.id === id)
  if (!scenario) throw new Error(`Unknown scenario: ${id}`)
  return scenario
}
