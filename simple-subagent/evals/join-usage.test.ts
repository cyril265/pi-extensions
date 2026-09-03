import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  attemptsPerScenario,
  isRecord,
  runLifecycle,
  runPrompt,
  type PromptRun,
} from './prompting-harness.ts'

const automaticToken = 'LANTERN-482'
const joinedToken = 'ORCHID-731'

function toolNames(run: PromptRun): string[] {
  return run.toolCalls.map(call => call.toolName)
}

function assertNoJoin(run: PromptRun) {
  const names = toolNames(run)
  assert.ok(!names.includes('joinSubAgents'), JSON.stringify(run.toolCalls, null, 2))
  assert.ok(!names.includes('agentWorkflowScript'), JSON.stringify(run.toolCalls, null, 2))
}

function getWorkflowTrace(run: PromptRun): string[] {
  for (const event of run.events) {
    if (!isRecord(event) || event.type !== 'tool_execution_end') continue
    if (event.toolName !== 'agentWorkflowScript' || !isRecord(event.result)) continue
    if (!isRecord(event.result.details) || !Array.isArray(event.result.details.trace)) continue
    return event.result.details.trace.flatMap(entry =>
      isRecord(entry) && typeof entry.tool === 'string' ? [entry.tool] : [],
    )
  }
  assert.fail('agentWorkflowScript result did not contain a trace')
}

test('does not join a fire-and-forget subagent job', { timeout: 600_000 }, async () => {
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

test('uses automatic delivery instead of joinSubAgents for parent-visible results', { timeout: 900_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'simple-subagent-automatic-delivery-'))
  const sessionPath = join(cwd, 'parent-session.jsonl')
  const summaryPath = join(cwd, 'summary.txt')

  try {
    const dispatched = await runLifecycle(
      cwd,
      sessionPath,
      `Ask an isolated reporter with low thinking to reply with ${automaticToken}, then tell me what it said.`,
    )
    assert.deepEqual(toolNames(dispatched), ['runSubAgents'])
    assertNoJoin(dispatched)
    assert.match(JSON.stringify(dispatched.events), new RegExp(automaticToken))

    const reused = await runLifecycle(
      cwd,
      sessionPath,
      `Save the reporter's answer from our conversation to ${summaryPath}.`,
    )
    assert.deepEqual(toolNames(reused), ['write'])
    assertNoJoin(reused)
    assert.equal((await readFile(summaryPath, 'utf8')).trim(), automaticToken)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('joins once when a subagent result feeds another tool inside one workflow', { timeout: 900_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'simple-subagent-joined-result-'))
  const sessionPath = join(cwd, 'parent-session.jsonl')
  const outputPath = join(cwd, 'release-notes.txt')

  try {
    const run = await runLifecycle(
      cwd,
      sessionPath,
      `Have an isolated subagent with low thinking draft a one-line release note containing ${joinedToken}, then save its response verbatim to ${outputPath}. Do not read or rewrite the response.`,
    )

    assert.equal(
      toolNames(run).filter(name => name === 'agentWorkflowScript').length,
      1,
      JSON.stringify(run.toolCalls, null, 2),
    )
    assert.equal(toolNames(run).filter(name => name === 'joinSubAgents').length, 0)
    assert.deepEqual(getWorkflowTrace(run), ['runSubAgents', 'joinSubAgents', 'write'])
    assert.match(await readFile(outputPath, 'utf8'), new RegExp(joinedToken))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
