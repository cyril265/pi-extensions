import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  attemptsPerScenario,
  isRecord,
  runLifecycle,
  runPrintLifecycle,
  runPrompt,
  type PromptRun,
} from './prompting-harness.ts'

const automaticToken = 'LANTERN-482'
const joinedToken = 'ORCHID-731'
const interruptedToken = 'EMBER-529'

function toolNames(run: PromptRun): string[] {
  return run.toolCalls.map(call => call.toolName)
}

function assertNoJoin(run: PromptRun) {
  const names = toolNames(run)
  assert.ok(!names.includes('joinSubAgents'), JSON.stringify(run.toolCalls, null, 2))
  assert.ok(!names.includes('agentWorkflowScript'), JSON.stringify(run.toolCalls, null, 2))
}

function getBashCommands(run: PromptRun): string[] {
  assert.ok(run.toolCalls.length > 0, 'expected at least one Bash call')
  return run.toolCalls.map(call => {
    assert.equal(call.toolName, 'bash', JSON.stringify(run.toolCalls, null, 2))
    assert.ok(isRecord(call.args) && typeof call.args.command === 'string')
    return call.args.command
  })
}

function matchesCliCommand(shellCommand: string, command: 'dispatch' | 'run'): boolean {
  return new RegExp(`subagent(?:\\s+|["'],\\s*["'])${command}`).test(shellCommand)
}

function assertSingleCliInvocation(run: PromptRun, command: 'dispatch' | 'run'): string {
  const matches = getBashCommands(run).filter(
    shellCommand =>
      matchesCliCommand(shellCommand, command) &&
      !shellCommand.includes(`subagent ${command} --help`),
  )
  assert.equal(matches.length, 1, JSON.stringify(run.toolCalls, null, 2))
  assertNoJoin(run)
  return matches[0]
}

function pushedSubagentResult(run: PromptRun): boolean {
  return JSON.stringify(run.events).includes('forked-subagent-results')
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
        ['bash'],
        `attempt ${attempt}: ${JSON.stringify(calls, null, 2)}`,
      )
      assert.ok(isRecord(calls[0].args) && typeof calls[0].args.command === 'string')
      assert.match(calls[0].args.command, /subagent\s+dispatch/)
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
      `Dispatch an isolated reporter with low thinking to reply with ${automaticToken}. I do not need the report yet.`,
    )
    assertSingleCliInvocation(dispatched, 'dispatch')
    assert.equal(pushedSubagentResult(dispatched), true)
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

test('print mode stays alive for CLI-dispatched automatic delivery', { timeout: 900_000 }, async () => {
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

test('uses one blocking CLI run when a subagent result feeds later shell work', { timeout: 900_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'simple-subagent-joined-result-'))
  const sessionPath = join(cwd, 'parent-session.jsonl')
  const outputPath = join(cwd, 'release-notes.txt')

  try {
    const run = await runLifecycle(
      cwd,
      sessionPath,
      `Have an isolated subagent with low thinking draft a one-line release note containing ${joinedToken}, then save its response verbatim to ${outputPath}. Do not read or rewrite the response.`,
    )

    assertSingleCliInvocation(run, 'run')
    assert.equal(pushedSubagentResult(run), false)
    assert.match(await readFile(outputPath, 'utf8'), new RegExp(joinedToken))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a disconnected run waiter leaves the real job for automatic delivery', { timeout: 900_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'simple-subagent-interrupted-run-'))
  const sessionPath = join(cwd, 'parent-session.jsonl')
  const metadataPath = join(cwd, 'metadata.txt')
  const discardedOutputPath = join(cwd, 'discarded-output.txt')

  try {
    const run = await runLifecycle(
      cwd,
      sessionPath,
      `Run exactly one Bash call that pipes this prompt into subagent run: "Run \`sleep 10\`, then reply with exactly ${interruptedToken}." Redirect stdout to ${discardedOutputPath} and stderr to ${metadataPath}, background the CLI, wait until ${metadataPath} is non-empty, kill that background CLI process, and tolerate its nonzero wait status. Do not call subagent cancel.`,
    )

    const command = assertSingleCliInvocation(run, 'run')
    assert.match(command, /kill|terminate/)
    assert.doesNotMatch(command, /subagent\s+cancel/)
    assert.equal(pushedSubagentResult(run), true)
    assert.match(JSON.stringify(run.events), new RegExp(interruptedToken))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('cancel stops a real CLI-dispatched child and rejects a second cancellation', { timeout: 900_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'simple-subagent-cancel-'))
  const sessionPath = join(cwd, 'parent-session.jsonl')

  try {
    const run = await runLifecycle(
      cwd,
      sessionPath,
      'Dispatch an isolated low-thinking agent that runs `sleep 60`. After dispatch returns, use its returned jobId to cancel the job with subagent cancel. Then call subagent cancel a second time and verify that it exits nonzero. The cancelled result is expected, so do not restart or replace it.',
    )

    const commands = getBashCommands(run)
    assert.equal(
      commands.filter(command => matchesCliCommand(command, 'dispatch')).length,
      1,
      JSON.stringify(run.toolCalls, null, 2),
    )
    assert.equal(commands.join('\n').match(/subagent\s+cancel/g)?.length, 2)
    assertNoJoin(run)
    assert.equal(pushedSubagentResult(run), true)
    assert.match(JSON.stringify(run.events), /cancelled|interrupted/i)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('run writes a complete response longer than the display inline limit', { timeout: 900_000 }, async () => {
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

    assertSingleCliInvocation(run, 'run')
    assert.equal(pushedSubagentResult(run), false)
    const output = await readFile(outputPath, 'utf8')
    assert.ok(output.length > 2_048)
    assert.equal(output.trimEnd(), source)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('concurrent CLI dispatch cannot reuse one cwd and session key', { timeout: 900_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'simple-subagent-session-lock-'))
  const sessionPath = join(cwd, 'parent-session.jsonl')

  try {
    const run = await runLifecycle(
      cwd,
      sessionPath,
      'In one shell call, start two subagent dispatch commands concurrently with the same cwd and --session-key shared-lock. Give both low thinking and ask them to reply DONE. Verify that exactly one dispatch succeeds and the other exits nonzero. The rejected collision is expected, so do not retry it.',
    )

    const commands = getBashCommands(run)
    assert.equal(
      commands.join('\n').match(/subagent\s+dispatch/g)?.length,
      2,
      JSON.stringify(run.toolCalls, null, 2),
    )
    assertNoJoin(run)
    assert.match(JSON.stringify(run.events), /Subagent session is already running/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
