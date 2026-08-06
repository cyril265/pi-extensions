import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { buildExecutorPrompt } from './template.ts'

process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'prewalk-agent-'))

const { default: extension } = await import('./index.ts')

type FakeCall = { name: string; args: unknown[] }

function createFakePi() {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>()
  const tools: Array<{ name: string; execute: Function }> = []
  const handlers = new Map<string, Function[]>()
  const sent: FakeCall[] = []
  const pi = {
    registerCommand: (name: string, command: { handler: never }) => commands.set(name, command),
    registerTool: (tool: { name: string; execute: Function }) => tools.push(tool),
    on: (name: string, handler: Function) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    sendMessage: (...args: unknown[]) => sent.push({ name: 'sendMessage', args }),
    getThinkingLevel: () => 'high',
    getActiveTools: () => ['read', 'bash', 'edit', 'write'],
  }
  return { pi, commands, tools, handlers, sent }
}

function createFakeContext() {
  const notifications: Array<{ message: string; level?: string }> = []
  const ctx = {
    ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
    modelRegistry: {
      getAvailable: () => [{ provider: 'fast', id: 'executor' }],
      hasConfiguredAuth: () => true,
    },
  }
  return { ctx, notifications }
}

test('executor prompt continues the inherited todo list without exposing the handoff', () => {
  const reportContract =
    'When done, end your final message with a report: every changed file with a one-line reason, and per checklist item the exact command you ran and its result. Unproven claims will be re-run.'
  assert.equal(buildExecutorPrompt(undefined), `Continue with the todo list.\n\n${reportContract}`)
  assert.equal(
    buildExecutorPrompt('Also update the focused test.'),
    `Continue with the todo list. Also:\n\nAlso update the focused test.\n\n${reportContract}`,
  )
})

test('parent process: config command, edit gate, and dispatch scheduling', async () => {
  delete process.env.PI_SIMPLE_SUBAGENT
  const { pi, commands, tools, handlers, sent } = createFakePi()
  const { ctx, notifications } = createFakeContext()
  extension(pi as never)

  assert.ok(commands.has('prewalk'))
  assert.ok(commands.has('prewalk-config'))
  assert.equal(tools.length, 0)

  await commands.get('prewalk')?.handler('', ctx)
  assert.match(notifications.at(-1)?.message ?? '', /prewalk-config/)
  assert.equal(tools.length, 0)

  await commands.get('prewalk-config')?.handler('fast/executor turbo', ctx)
  assert.match(notifications.at(-1)?.message ?? '', /not a thinking level/)

  await commands.get('prewalk-config')?.handler('fast/executor low', ctx)
  assert.match(notifications.at(-1)?.message ?? '', /executor set/)

  await commands.get('prewalk')?.handler('add a feature', ctx)
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'dispatch_executor')
  const [message, options] = sent.at(-1)?.args as [
    { customType: string; content: string; display: boolean },
    { triggerTurn?: boolean },
  ]
  assert.equal(message.customType, 'prewalk-template')
  assert.equal(message.display, true)
  assert.match(message.content, /add a feature/)
  assert.match(message.content, /dispatch_executor/)
  assert.match(message.content, /numbered checklist/)
  assert.equal(options.triggerTurn, true)

  const editGate = handlers.get('tool_execution_end')?.[0]
  assert.ok(editGate)
  await editGate({ toolName: 'edit', isError: true })
  await editGate({ toolName: 'read', isError: false })
  assert.equal(sent.length, 1)
  await editGate({ toolName: 'edit', isError: false })
  const [nudge, nudgeOptions] = sent.at(-1)?.args as [
    { customType: string; content: string; display: boolean },
    { deliverAs: string },
  ]
  assert.equal(nudge.customType, 'prewalk-nudge')
  assert.match(nudge.content, /First edit landed/)
  assert.equal(nudgeOptions.deliverAs, 'steer')
  await editGate({ toolName: 'write', isError: false })
  assert.equal(sent.length, 2)

  const result = await tools[0].execute('tool-1', {})
  assert.equal(result.terminate, true)
  assert.match(result.content[0].text, /fast\/executor/)
  await assert.rejects(
    () => tools[0].execute('tool-2', { instructions: 'again' }),
    /already in flight/,
  )
})

test('restored prewalk session registers the dispatch tool once', async () => {
  delete process.env.PI_SIMPLE_SUBAGENT
  const { pi, tools, handlers } = createFakePi()
  extension(pi as never)

  assert.equal(tools.length, 0)
  const sessionStart = handlers.get('session_start')?.[0]
  assert.ok(sessionStart)

  await sessionStart(
    { type: 'session_start', reason: 'resume' },
    { sessionManager: { getEntries: () => [] } },
  )
  assert.equal(tools.length, 0)

  const restoredContext = {
    sessionManager: {
      getEntries: () => [
        {
          type: 'custom_message',
          customType: 'prewalk-template',
          content: 'workflow',
          display: true,
        },
      ],
    },
  }
  await sessionStart({ type: 'session_start', reason: 'resume' }, restoredContext)
  await sessionStart({ type: 'session_start', reason: 'reload' }, restoredContext)

  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'dispatch_executor')
})

test('subagent process: scrubs prewalk messages from context, registers nothing', async () => {
  process.env.PI_SIMPLE_SUBAGENT = '1'
  try {
    const { pi, commands, tools, handlers } = createFakePi()
    extension(pi as never)

    assert.equal(commands.size, 0)
    assert.equal(tools.length, 0)
    const contextHandler = handlers.get('context')?.[0]
    assert.ok(contextHandler)
    const filtered = contextHandler({
      messages: [
        { role: 'custom', customType: 'prewalk-template', content: 'hidden' },
        { role: 'custom', customType: 'prewalk-executor-result', content: 'hidden' },
        { role: 'custom', customType: 'prewalk-nudge', content: 'hidden' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'the first edit landed' },
            { type: 'toolCall', id: 't1', name: 'dispatch_executor', arguments: {} },
          ],
        },
        { role: 'toolResult', toolCallId: 't1', toolName: 'dispatch_executor', content: [] },
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't2', name: 'dispatch_executor', arguments: {} }],
        },
        { role: 'toolResult', toolCallId: 'x', toolName: 'edit', content: [] },
        { role: 'assistant', content: 'the plan' },
      ],
    })
    assert.deepEqual(filtered.messages, [
      { role: 'assistant', content: [{ type: 'text', text: 'the first edit landed' }] },
      { role: 'toolResult', toolCallId: 'x', toolName: 'edit', content: [] },
      { role: 'assistant', content: 'the plan' },
    ])
  } finally {
    delete process.env.PI_SIMPLE_SUBAGENT
  }
})
