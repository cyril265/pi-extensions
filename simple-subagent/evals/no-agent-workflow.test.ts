import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { attemptsPerScenario, runPrompt, type ToolCall } from './prompting-harness.ts'

type Scenario = {
  name: string
  prompt: string
  expectedTools: string[]
}

function assertDirectCalls(scenario: Scenario, attempt: number, calls: ToolCall[]) {
  const actualTools = calls.map(call => call.toolName).sort()
  assert.ok(
    !actualTools.includes('agentWorkflowScript'),
    `${scenario.name}, attempt ${attempt}: agentWorkflowScript should not run\n${JSON.stringify(calls, null, 2)}`,
  )
  assert.deepEqual(
    actualTools,
    [...scenario.expectedTools].sort(),
    `${scenario.name}, attempt ${attempt}: wrong direct tools\n${JSON.stringify(calls, null, 2)}`,
  )
}

test('realistic coding work does not use agentWorkflowScript when the parent needs the result', { timeout: 3_600_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'simple-subagent-no-workflow-'))
  const sourceDirectory = join(cwd, 'src')
  const configPath = join(sourceDirectory, 'request-config.ts')
  const reviewerPath = join(cwd, 'reviewer.md')
  await mkdir(sourceDirectory)
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test' } }, null, 2),
    'utf8',
  )
  await writeFile(
    configPath,
    'export const requestTimeoutMs = 5_000\nexport const retryCount = 2\n',
    'utf8',
  )
  await writeFile(
    reviewerPath,
    'Review timeout changes against the callers and existing tests.\n',
    'utf8',
  )

  const scenarios: Scenario[] = [
    {
      name: 'starts a code change by inspecting the implementation',
      prompt: `Requests time out too quickly. Inspect ${configPath}, change the timeout to 30 seconds while preserving the existing style, then run the relevant tests. Start by examining the implementation.`,
      expectedTools: ['read'],
    },
    {
      name: 'runs a failing test before diagnosing it',
      prompt: `The test suite in ${cwd} is failing. Run npm test, inspect the failure, and identify the root cause before changing any files.`,
      expectedTools: ['bash'],
    },
    {
      name: 'reads instructions before tailoring a subagent prompt',
      prompt: `Read ${reviewerPath}. Use your own judgment to tailor those instructions to the timeout change in ${configPath}, then dispatch an isolated reviewer. Start by reading the instructions yourself.`,
      expectedTools: ['read'],
    },
    {
      name: 'keeps independent parent and subagent work as separate calls',
      prompt: `Dispatch an isolated reviewer with the complete prompt "Review ${configPath} for timeout bugs." While it runs, independently read ${configPath} yourself so you can explain the current behavior. Start both independent tasks now.`,
      expectedTools: ['read', 'runSubAgents'],
    },
  ]

  try {
    for (const scenario of scenarios) {
      await t.test(scenario.name, { timeout: 600_000 }, async () => {
        for (let attempt = 1; attempt <= attemptsPerScenario; attempt += 1) {
          const calls = await runPrompt(cwd, scenario.prompt)
          assertDirectCalls(scenario, attempt, calls)
        }
      })
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
