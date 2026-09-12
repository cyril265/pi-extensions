import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  attemptsPerScenario,
  runLifecycle,
  runPrintLifecycle,
  runPrompt,
  type PromptRun,
} from './prompting-harness.ts'

const automaticToken = 'LANTERN-482'
const blockingToken = 'ORCHID-731'
const interruptedToken = 'EMBER-529'

function toolNames(run: PromptRun): string[] {
  return run.toolCalls.map(call => call.toolName)
}

function count(run: PromptRun, toolName: string): number {
  return toolNames(run).filter(name => name === toolName).length
}

function usedClient(run: PromptRun): boolean {
  return JSON.stringify(run.toolCalls).includes('PI_SIMPLE_SUBAGENT_CLIENT')
}

function pushedSubagentResult(run: PromptRun): boolean {
  return /Subagent job \S+ finished\./.test(JSON.stringify(run.events))
}

test('dispatches a fire-and-forget subagent job', { timeout: 600_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'simple-subagent-fire-and-forget-'))
  try {
    for (let attempt = 1; attempt <= attemptsPerScenario; attempt += 1) {
      const calls = await runPrompt(
        cwd,
        'Send an isolated reviewer with low thinking to inspect the current directory for obvious problems. I do not need the report yet.',
      )
      assert.deepEqual(
        calls.map(call => call.toolName),
        ['runSubAgents'],
        `attempt ${attempt}: ${JSON.stringify(calls, null, 2)}`,
      )
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('delivers dispatch results automatically', { timeout: 900_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'simple-subagent-automatic-delivery-'))
  const sessionPath = join(cwd, 'parent-session.jsonl')
  const summaryPath = join(cwd, 'summary.txt')

  try {
    const dispatched = await runLifecycle(
      cwd,
      sessionPath,
      `Dispatch an isolated reporter with low thinking to reply with ${automaticToken}. I do not need the report yet.`,
    )
    assert.equal(count(dispatched, 'runSubAgents'), 1, JSON.stringify(dispatched.toolCalls, null, 2))
    assert.equal(usedClient(dispatched), false)
    assert.equal(pushedSubagentResult(dispatched), true)
    assert.match(JSON.stringify(dispatched.events), new RegExp(automaticToken))

    const reused = await runLifecycle(
      cwd,
      sessionPath,
      `Save the reporter's answer from our conversation to ${summaryPath}.`,
    )
    assert.deepEqual(toolNames(reused), ['write'])
    assert.equal((await readFile(summaryPath, 'utf8')).trim(), automaticToken)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('print mode stays alive for dispatched automatic delivery', { timeout: 900_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'simple-subagent-print-delivery-'))
  const sessionPath = join(cwd, 'parent-session.jsonl')
  const markerPath = join(cwd, 'child-finished.txt')
  const token = 'QUARTZ-684'

  try {
    await runPrintLifecycle(
      cwd,
      sessionPath,
      `Dispatch an isolated worker with low thinking. It must run \`sleep 2\`, write exactly ${token} to ${markerPath}, then reply DONE. I do not need the report yet.`,
    )
    assert.equal((await readFile(markerPath, 'utf8')).trim(), token)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('uses the Node client when a subagent result feeds later work', { timeout: 900_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'simple-subagent-blocking-result-'))
  const sessionPath = join(cwd, 'parent-session.jsonl')
  const outputPath = join(cwd, 'release-notes.txt')

  try {
    const run = await runLifecycle(
      cwd,
      sessionPath,
      `Have an isolated subagent with low thinking draft a one-line release note containing ${blockingToken}, then save its response verbatim to ${outputPath}. Do not read or rewrite the response.`,
    )
    assert.equal(usedClient(run), true, JSON.stringify(run.toolCalls, null, 2))
    assert.equal(count(run, 'runSubAgents'), 0)
    assert.equal(pushedSubagentResult(run), false)
    assert.match(await readFile(outputPath, 'utf8'), new RegExp(blockingToken))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a disconnected run waiter leaves the real job for automatic delivery', { timeout: 900_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'simple-subagent-interrupted-run-'))
  const sessionPath = join(cwd, 'parent-session.jsonl')
  const discardedOutputPath = join(cwd, 'discarded-output.txt')

  try {
    const run = await runLifecycle(
      cwd,
      sessionPath,
      `Write a Node script that imports the simple-subagent client and awaits run() for one agent with low thinking whose prompt is "Run \`sleep 10\`, then reply with exactly ${interruptedToken}." and prints the result to ${discardedOutputPath}. Start the script in the background from one Bash call, sleep 3 seconds, kill it, and tolerate its nonzero wait status. Do not cancel the job.`,
    )
    assert.equal(usedClient(run), true, JSON.stringify(run.toolCalls, null, 2))
    assert.equal(count(run, 'cancelSubAgents'), 0)
    assert.equal(pushedSubagentResult(run), true)
    assert.match(JSON.stringify(run.events), new RegExp(interruptedToken))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('cancelSubAgents stops a real child and rejects a second cancellation', { timeout: 900_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'simple-subagent-cancel-'))
  const sessionPath = join(cwd, 'parent-session.jsonl')

  try {
    const run = await runLifecycle(
      cwd,
      sessionPath,
      'Dispatch an isolated low-thinking agent that runs `sleep 60`. After dispatch returns, cancel the job with its jobId. Then cancel it a second time and confirm that the second call reports an error. The cancelled result is expected, so do not restart or replace it.',
    )
    assert.equal(count(run, 'runSubAgents'), 1, JSON.stringify(run.toolCalls, null, 2))
    assert.equal(count(run, 'cancelSubAgents'), 2, JSON.stringify(run.toolCalls, null, 2))
    assert.equal(pushedSubagentResult(run), true)
    assert.match(JSON.stringify(run.events), /cancelled|interrupted/i)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('run returns a complete response longer than the display inline limit', { timeout: 900_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'simple-subagent-long-run-'))
  const sessionPath = join(cwd, 'parent-session.jsonl')
  const sourcePath = join(cwd, 'source.txt')
  const outputPath = join(cwd, 'output.txt')
  const source = Array.from(
    { length: 260 },
    (_, index) => `line-${String(index).padStart(4, '0')}`,
  ).join('\n')
  await writeFile(sourcePath, source, 'utf8')

  try {
    const run = await runLifecycle(
      cwd,
      sessionPath,
      `Have an isolated copier with low thinking read ${sourcePath} and return its contents exactly, with no explanation or code fence. Save the raw response to ${outputPath} without reading or rewriting it.`,
    )
    assert.equal(usedClient(run), true, JSON.stringify(run.toolCalls, null, 2))
    assert.equal(pushedSubagentResult(run), false)
    const output = await readFile(outputPath, 'utf8')
    assert.ok(output.length > 2_048)
    assert.equal(output.trimEnd(), source)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
