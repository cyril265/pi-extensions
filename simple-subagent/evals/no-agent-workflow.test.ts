import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { attemptsPerScenario, runPrompt, type ToolCall } from './prompting-harness.ts'

type Scenario = {
  name: string
  prompt: string
  requiredTools?: string[]
}

function assertDirectCalls(scenario: Scenario, attempt: number, calls: ToolCall[]) {
  const actualTools = calls.map(call => call.toolName)
  assert.ok(calls.length > 0, `${scenario.name}, attempt ${attempt}: no tool call`)
  assert.ok(
    !actualTools.includes('agentWorkflowScript'),
    `${scenario.name}, attempt ${attempt}: agentWorkflowScript should not run\n${JSON.stringify(calls, null, 2)}`,
  )
  assert.ok(
    !actualTools.includes('joinSubAgents'),
    `${scenario.name}, attempt ${attempt}: joinSubAgents should not run\n${JSON.stringify(calls, null, 2)}`,
  )
  for (const tool of scenario.requiredTools ?? []) {
    assert.ok(
      actualTools.includes(tool),
      `${scenario.name}, attempt ${attempt}: expected ${tool}\n${JSON.stringify(calls, null, 2)}`,
    )
  }
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
      prompt: `Change the request timeout in ${configPath} from 5 seconds to 30 seconds and run the relevant tests.`,
    },
    {
      name: 'runs a failing test before diagnosing it',
      prompt: `npm test is failing in ${cwd}. Find the root cause before editing anything.`,
    },
    {
      name: 'reads instructions before tailoring a subagent prompt',
      prompt: `Read ${reviewerPath} and explain which parts do not fit ${configPath}. Then rewrite the instructions and send them to an isolated reviewer.`,
      requiredTools: ['read'],
    },
    {
      name: 'keeps independent parent and subagent work as separate calls',
      prompt: `Have an isolated reviewer inspect ${configPath} for timeout bugs. While they work, explain the current timeout behavior to me.`,
      requiredTools: ['runSubAgents'],
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
