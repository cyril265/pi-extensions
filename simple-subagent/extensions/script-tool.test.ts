import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  createNativeNodeScriptTools,
  invokePiTool,
  limitNodeScriptOutput,
  NodeScriptWorkerError,
  registerNodeScriptTool,
  runNodeScriptWorker,
  type NodeScriptToolValue,
} from './script-tool.ts'
import { registerSubagentTools, type RegisteredSubagentTools } from './tools.ts'

function value(text: string): NodeScriptToolValue {
  return {
    text,
    content: [{ type: 'text', text }],
    details: undefined,
  }
}

async function runWorker(
  code: string,
  invoke: (
    tool: Parameters<Parameters<typeof runNodeScriptWorker>[0]['invoke']>[0],
    args: unknown,
    callId: string,
    signal: AbortSignal,
  ) => Promise<NodeScriptToolValue>,
  controller = new AbortController(),
): Promise<string> {
  const result = await runNodeScriptWorker({ code, invoke, controller })
  return result.consoleOutput && result.returnOutput
    ? `${result.consoleOutput}\n\n${result.returnOutput}`
    : result.consoleOutput || result.returnOutput
}

test('nodeScript runs sequential and conditional tool calls with prior results', async () => {
  const calls: unknown[] = []
  const output = await runWorker(
    `
      const first = await tools.read({ value: "first" })
      if (first.text === "first") {
        const second = await tools.bash({ value: first.text + "-second" })
        return second.text
      }
      return "wrong"
    `,
    async (_tool, args) => {
      calls.push(args)
      return value((args as { value: string }).value)
    },
  )

  assert.equal(output, 'first-second')
  assert.deepEqual(calls, [{ value: 'first' }, { value: 'first-second' }])
})

test('nodeScript sends Promise.all tool calls concurrently', async () => {
  let active = 0
  let maxActive = 0
  const output = await runWorker(
    `
      const results = await Promise.all([
        tools.read({ value: "a" }),
        tools.bash({ value: "b" }),
        tools.grep({ value: "c" }),
      ])
      return results.map(result => result.text)
    `,
    async (_tool, args) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 30))
      active -= 1
      return value((args as { value: string }).value)
    },
  )

  assert.equal(maxActive, 3)
  assert.equal(output, '[\n  "a",\n  "b",\n  "c"\n]')
})

test('nodeScript lets scripts catch bridge failures', async () => {
  const output = await runWorker(
    `
      try {
        await tools.read({})
      } catch (error) {
        return error.message
      }
    `,
    async () => {
      throw new Error('read failed')
    },
  )

  assert.equal(output, 'read failed')
})

test('nodeScript preserves console order before a JSON return value', async () => {
  const output = await runWorker(
    `
      console.log("first", 1)
      console.warn("second")
      return { ok: true }
    `,
    async () => value('unused'),
  )

  assert.equal(output, 'first 1\nsecond\n\n{\n  "ok": true\n}')
})

test('nodeScript fails on an uncaught script error', async () => {
  await assert.rejects(
    runWorker('throw new Error("broken")', async () => value('unused')),
    (error: unknown) => error instanceof NodeScriptWorkerError && error.message === 'broken',
  )
})

test('nodeScript aborts unresolved tool calls when the script returns', async () => {
  const controller = new AbortController()
  await assert.rejects(
    runWorker(
      'tools.read({}); return "done"',
      async (_tool, _args, _callId, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
      controller,
    ),
    /nodeScript returned with 1 unresolved tool call/,
  )
  assert.equal(controller.signal.aborted, true)
})

test('nodeScript abort terminates synchronous infinite code', { timeout: 2000 }, async () => {
  const controller = new AbortController()
  const run = runWorker('while (true) {}', async () => value('unused'), controller)
  setTimeout(() => controller.abort('stop'), 50)
  await assert.rejects(run, /stop/)
})

test('native invocation prepares, validates, and executes with the supplied context and signal', async () => {
  const parameters = Type.Object({ count: Type.Number() })
  const controller = new AbortController()
  const ctx = { cwd: '/work' } as ExtensionContext
  let executed = false
  const definition: ToolDefinition<typeof parameters, { count: number }> = {
    name: 'test',
    label: 'test',
    description: 'test',
    parameters,
    prepareArguments(args) {
      return { count: Number((args as { count: string }).count) }
    },
    async execute(_id, params, signal, onUpdate, receivedContext) {
      executed = true
      assert.equal(params.count, 4)
      assert.equal(signal, controller.signal)
      assert.equal(onUpdate, undefined)
      assert.equal(receivedContext, ctx)
      return {
        content: [{ type: 'text', text: String(params.count) }],
        details: { count: params.count },
      }
    },
  }

  const result = await invokePiTool(
    definition,
    { count: '4' },
    'nested-call',
    controller.signal,
    ctx,
  )

  assert.equal(executed, true)
  assert.deepEqual(result, {
    text: '4',
    content: [{ type: 'text', text: '4' }],
    details: { count: 4 },
  })
})

test('native invocation rejects invalid arguments before execution', async () => {
  const parameters = Type.Object({ count: Type.Number() })
  let executed = false
  const definition: ToolDefinition<typeof parameters> = {
    name: 'test',
    label: 'test',
    description: 'test',
    parameters,
    async execute() {
      executed = true
      return { content: [{ type: 'text', text: 'wrong' }], details: undefined }
    },
  }

  await assert.rejects(
    invokePiTool(
      definition,
      { count: 'not-a-number' },
      'nested-call',
      new AbortController().signal,
      {} as ExtensionContext,
    ),
    /Validation failed for tool "test"/,
  )
  assert.equal(executed, false)
})

test('stock native definitions use the parent cwd', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-script-cwd-'))
  await writeFile(join(cwd, 'file.txt'), 'from cwd', 'utf8')
  const ctx = {
    cwd,
    isProjectTrusted: () => true,
  } as ExtensionContext
  const tools = createNativeNodeScriptTools(ctx)

  const result = await invokePiTool(
    tools.read,
    { path: 'file.txt' },
    'read-call',
    new AbortController().signal,
    ctx,
  )

  assert.equal(result.text, 'from cwd')
})

test('stock bash receives the parent session environment', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-script-bash-'))
  const ctx = {
    cwd,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => 'session-1',
      getSessionFile: () => undefined,
    },
    model: { provider: 'test-provider', id: 'test-model' },
    thinkingLevel: 'high',
  } as unknown as ExtensionContext
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(cwd, 'agent-dir')
  const tools = createNativeNodeScriptTools(ctx)
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir

  const result = await invokePiTool(
    tools.bash,
    { command: 'printf "$PI_SESSION_ID:$PI_PROVIDER:$PI_MODEL:$PI_REASONING_LEVEL"' },
    'bash-call',
    new AbortController().signal,
    ctx,
  )

  assert.equal(result.text, 'session-1:test-provider:test-model:high')
})

test('nodeScript truncates combined output and saves the complete text', async () => {
  const output = Array.from({ length: 2001 }, (_, index) => `line ${index}`).join('\n')
  const limited = await limitNodeScriptOutput(output)

  assert.equal(limited.truncation?.truncated, true)
  assert.ok(limited.fullOutputPath)
  assert.match(limited.text, /Full output saved to:/)
  assert.equal(await readFile(limited.fullOutputPath, 'utf8'), output)
})

test('nodeScript invokes the registered subagent definition', async () => {
  let scriptTool: ToolDefinition<any, any> | undefined
  const pi = {
    registerTool(tool: ToolDefinition<any, any>) {
      scriptTool = tool
    },
    on() {},
  } as unknown as ExtensionAPI
  const parameters = Type.Object({ value: Type.String() })
  let received: string | undefined
  const runSubAgentsTool: ToolDefinition<typeof parameters, { jobId: string }> = {
    name: 'runSubAgents',
    label: 'runSubAgents',
    description: 'test',
    parameters,
    async execute(_id, params) {
      received = params.value
      return {
        content: [{ type: 'text', text: `dispatched ${params.value}` }],
        details: { jobId: 'job-1' },
      }
    },
  }
  const integration: RegisteredSubagentTools = {
    runSubAgentsTool:
      runSubAgentsTool as unknown as RegisteredSubagentTools['runSubAgentsTool'],
    collectSubagentsTool:
      runSubAgentsTool as unknown as RegisteredSubagentTools['collectSubagentsTool'],
  }
  registerNodeScriptTool(pi, integration)
  assert.ok(scriptTool)

  const cwd = await mkdtemp(join(tmpdir(), 'pi-script-subagent-'))
  const result = await scriptTool.execute(
    'script-call',
    { code: 'return tools.runSubAgents({ value: "review" })' },
    undefined,
    undefined,
    { cwd, isProjectTrusted: () => true } as ExtensionContext,
  )

  assert.equal(received, 'review')
  assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /job-1/)
  const trace = (result.details as { trace: Array<Record<string, unknown>> }).trace
  assert.equal(trace.length, 1)
  assert.equal(trace[0].tool, 'runSubAgents')
  assert.equal(trace[0].status, 'success')
  assert.equal(typeof trace[0].durationMs, 'number')
})

test('nodeScript renders the complete JavaScript source', () => {
  let scriptTool: ToolDefinition<any, any> | undefined
  const pi = {
    registerTool(tool: ToolDefinition<any, any>) {
      scriptTool = tool
    },
  } as unknown as ExtensionAPI
  const unavailableTool = {} as ToolDefinition<any, any>
  registerNodeScriptTool(pi, {
    runSubAgentsTool: unavailableTool,
    collectSubagentsTool: unavailableTool,
  })
  assert.ok(scriptTool?.renderCall)

  const code = Array.from({ length: 10 }, (_, index) => `const value${index} = ${index}`).join('\n')
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  }
  const component = scriptTool.renderCall(
    { code },
    theme as never,
    {} as never,
  )
  const rendered = component
    .render(200)
    .join('\n')
    .replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')

  assert.match(rendered, /nodeScript/)
  for (const line of code.split('\n')) assert.match(rendered, new RegExp(line))
})

test('managed children can use nodeScript while subagent calls stay locked', async () => {
  const tools: ToolDefinition<any, any>[] = []
  const pi = {
    registerTool(tool: ToolDefinition<any, any>) {
      tools.push(tool)
    },
    registerMessageRenderer() {},
    registerCommand() {},
    on() {},
  } as unknown as ExtensionAPI
  const integration = registerSubagentTools(pi, true, {
    enableForkTool: false,
    modelAliases: {},
  })
  registerNodeScriptTool(pi, integration)
  const scriptTool = tools.find(tool => tool.name === 'nodeScript')
  assert.ok(scriptTool)

  const cwd = await mkdtemp(join(tmpdir(), 'node-script-managed-child-'))
  await writeFile(join(cwd, 'value.txt'), 'native tools work', 'utf8')
  const result = await scriptTool.execute(
    'script-call',
    {
      code: `
        const file = await tools.read({ path: "value.txt" })
        try {
          await tools.collectSubagents({ jobId: "missing" })
          return "wrong"
        } catch (error) {
          return { native: file.text, subagents: error.message }
        }
      `,
    },
    undefined,
    undefined,
    { cwd, isProjectTrusted: () => true } as ExtensionContext,
  )
  const output = result.content[0]
  assert.equal(output.type, 'text')
  assert.deepEqual(JSON.parse(output.text), {
    native: 'native tools work',
    subagents: 'Subagent tools are unavailable during this run',
  })
})

test('nodeScript collect uses the real registered JobRegistry', async () => {
  const tools: ToolDefinition<any, any>[] = []
  const pi = {
    registerTool(tool: ToolDefinition<any, any>) {
      tools.push(tool)
    },
    registerMessageRenderer() {},
    registerCommand() {},
    on() {},
  } as unknown as ExtensionAPI
  const integration = registerSubagentTools(pi, false, {
    enableForkTool: false,
    modelAliases: {},
  })
  registerNodeScriptTool(pi, integration)
  const scriptTool = tools.find(tool => tool.name === 'nodeScript')
  assert.ok(scriptTool)

  const cwd = await mkdtemp(join(tmpdir(), 'pi-script-real-jobs-'))
  const result = await scriptTool.execute(
    'script-call',
    {
      code: `
        try {
          await tools.collectSubagents({ jobId: "missing" })
          return "wrong"
        } catch (error) {
          return error.message
        }
      `,
    },
    undefined,
    undefined,
    { cwd, isProjectTrusted: () => true } as ExtensionContext,
  )

  assert.equal(
    result.content[0].type === 'text' ? result.content[0].text : '',
    'Unknown subagent job: missing',
  )
})
