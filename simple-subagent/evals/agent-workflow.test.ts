import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  attemptsPerScenario,
  isRecord,
  runPrompt,
  type ToolCall,
} from './prompting-harness.ts'

type Scenario = {
  name: string
  prompt: string
  expectedTool: 'bash' | 'read'
  cliCommand?: 'dispatch' | 'run'
}

function assertScenario(scenario: Scenario, attempt: number, calls: ToolCall[]) {
  assert.equal(
    calls.length,
    1,
    `${scenario.name}, attempt ${attempt}: expected one tool call\n${JSON.stringify(calls, null, 2)}`,
  )
  const call = calls[0]
  assert.equal(
    call.toolName,
    scenario.expectedTool,
    `${scenario.name}, attempt ${attempt}: wrong tool\n${JSON.stringify(call, null, 2)}`,
  )

  if (scenario.expectedTool === 'bash') {
    assert.ok(isRecord(call.args) && typeof call.args.command === 'string')
    assert.match(call.args.command, new RegExp(`subagent\\s+${scenario.cliCommand}`))
    return
  }
}

test('shell CLI prompting routes dependent and direct work correctly', { timeout: 3_600_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'simple-subagent-prompting-'))
  const instructionsPath = join(cwd, 'reviewer.md')
  const responsePath = join(cwd, 'response.txt')
  await writeFile(
    instructionsPath,
    'Review the current changes for correctness and name the most serious risk.\n',
    'utf8',
  )

  const scenarios: Scenario[] = [
    {
      name: 'gives file-based instructions to a subagent',
      prompt: `Have an isolated reviewer follow the instructions in ${instructionsPath}, then save its exact response to ${responsePath}. Do not inspect or rewrite either file.`,
      expectedTool: 'bash',
      cliCommand: 'run',
    },
    {
      name: 'sends command output to a subagent',
      prompt:
        `Run \`printf workflow-source\` here, have an isolated reviewer examine exactly what it printed, then save the exact response to ${responsePath}. Do not inspect or rewrite the command output or response.`,
      expectedTool: 'bash',
      cliCommand: 'run',
    },
    {
      name: 'combines review instructions with command output',
      prompt: `Have an isolated reviewer apply ${instructionsPath} to the output of \`printf change-set\`, then save its exact response to ${responsePath}. Do not inspect or rewrite the file, command output, or response.`,
      expectedTool: 'bash',
      cliCommand: 'run',
    },
    {
      name: 'dispatches when the parent does not need the result yet',
      prompt: 'Dispatch an isolated reviewer to reply with READY. I do not need the report yet.',
      expectedTool: 'bash',
      cliCommand: 'dispatch',
    },
    {
      name: 'reads directly when the parent needs the result',
      prompt: `What is the first line of ${instructionsPath}?`,
      expectedTool: 'read',
    },
    {
      name: 'reads directly when the parent must interpret the result',
      prompt: `Read ${instructionsPath} and tell me which instructions do not fit a timeout review. Then rewrite them and send the new instructions to an isolated reviewer.`,
      expectedTool: 'read',
    },
  ]

  try {
    for (const scenario of scenarios) {
      await t.test(scenario.name, { timeout: 600_000 }, async () => {
        for (let attempt = 1; attempt <= attemptsPerScenario; attempt += 1) {
          const calls = await runPrompt(cwd, scenario.prompt)
          assertScenario(scenario, attempt, calls)
        }
      })
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
