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
  await writeFile(instructionsPath, 'Review the change for correctness.\n', 'utf8')

  const scenarios: Scenario[] = [
    {
      name: 'passes file contents directly to a subagent',
      prompt: `Read ${instructionsPath} and pass its exact contents unchanged as the prompt to one isolated subagent named reviewer. Do not inspect or quote the file yourself.`,
      expectedTool: 'agentWorkflowScript',
      nestedTools: ['read'],
    },
    {
      name: 'passes command output directly to a subagent',
      prompt:
        'Run `printf workflow-source` and pass its stdout unchanged as the prompt to one isolated subagent named reviewer. Do not inspect or quote stdout yourself.',
      expectedTool: 'agentWorkflowScript',
      nestedTools: ['bash'],
    },
    {
      name: 'combines independent tool results in a subagent prompt',
      prompt: `Read ${instructionsPath} and run \`printf change-set\` independently. Start one isolated subagent named reviewer with a prompt containing the complete file text followed by the complete command output. Do not inspect either result yourself.`,
      expectedTool: 'agentWorkflowScript',
      nestedTools: ['read', 'bash'],
    },
    {
      name: 'dispatches directly when the subagent prompt is complete',
      prompt: 'Start one isolated subagent named reviewer with the exact prompt `Reply with READY.`',
      expectedTool: 'runSubAgents',
    },
    {
      name: 'reads directly when the parent needs the result',
      prompt: `Read ${instructionsPath} and tell me its first line.`,
      expectedTool: 'read',
    },
    {
      name: 'reads directly when the parent must interpret the result',
      prompt: `Read ${instructionsPath}. Interpret its instructions yourself, then decide what prompt to write for an isolated subagent named reviewer.`,
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
