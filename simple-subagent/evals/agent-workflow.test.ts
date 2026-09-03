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
  expectedTool: 'agentWorkflowScript' | 'read' | 'runSubAgents'
  nestedTools?: Array<'read' | 'bash'>
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

  if (scenario.expectedTool !== 'agentWorkflowScript') return
  assert.ok(isRecord(call.args) && typeof call.args.code === 'string')
  const code = call.args.code
  assert.match(code, /tools\.runSubAgents\s*\(/)
  assert.match(code, /\.text\b/)
  for (const tool of scenario.nestedTools ?? []) {
    assert.match(code, new RegExp(`tools\\.${tool}\\s*\\(`))
  }
}

test('agentWorkflowScript prompting routes dependent and direct work correctly', { timeout: 3_600_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'simple-subagent-prompting-'))
  const instructionsPath = join(cwd, 'reviewer.md')
  await writeFile(
    instructionsPath,
    'Review the current changes for correctness and name the most serious risk.\n',
    'utf8',
  )

  const scenarios: Scenario[] = [
    {
      name: 'gives file-based instructions to a subagent',
      prompt: `Have an isolated reviewer follow the instructions in ${instructionsPath}.`,
      expectedTool: 'agentWorkflowScript',
      nestedTools: ['read'],
    },
    {
      name: 'sends command output to a subagent',
      prompt:
        'Run `printf workflow-source` here, then have an isolated reviewer examine exactly what it printed.',
      expectedTool: 'agentWorkflowScript',
      nestedTools: ['bash'],
    },
    {
      name: 'combines review instructions with command output',
      prompt: `Have an isolated reviewer apply ${instructionsPath} to the output of \`printf change-set\`.`,
      expectedTool: 'agentWorkflowScript',
      nestedTools: ['read', 'bash'],
    },
    {
      name: 'dispatches directly when the subagent prompt is complete',
      prompt: 'Ask an isolated reviewer to reply with READY.',
      expectedTool: 'runSubAgents',
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
