import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  ModelRuntime,
  type SessionEntry,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import prewalk from './index.ts'

// Real Pi runtime with a persisted session. The executor model points at a local
// server that answers every request with 401, so the forked child fails on its
// first turn and the failure report flows back through the real registry.
const executorModel = 'offline-test/executor'
let directory: string
let session: AgentSession
let context: ExtensionContext
let server: Server
const originalEnvironment = { ...process.env }

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'prewalk-integration-')))
  const agentDir = join(directory, 'agent')
  process.env = {
    ...Object.fromEntries(
      Object.entries(originalEnvironment).filter(([key]) =>
        ['PATH', 'SystemRoot', 'COMSPEC'].includes(key),
      ),
    ),
    HOME: directory,
    USERPROFILE: directory,
    TEMP: directory,
    TMP: directory,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
  }
  await mkdir(agentDir, { recursive: true })
  server = createServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end('{"error":{"message":"offline test rejects this request"}}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'offline-test': {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: 'openai-completions',
          apiKey: 'offline-test-not-a-real-key',
          models: [{ id: 'executor' }],
        },
      },
    }),
  )
  await writeFile(
    join(agentDir, 'prewalk.json'),
    JSON.stringify({ executor: { model: executorModel, thinking: 'low' } }),
  )
  const settingsManager = SettingsManager.inMemory()
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    modelsStorePath: join(agentDir, 'models-store.json'),
  })
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir,
    settingsManager,
    extensionFactories: [
      prewalk,
      pi => {
        pi.on('session_start', (_event, ctx) => {
          context = ctx
        })
      },
    ],
  })
  await resourceLoader.reload()
  assert.deepEqual(resourceLoader.getExtensions().errors, [])
  ;({ session } = await createAgentSession({
    cwd: directory,
    agentDir,
    settingsManager,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.create(directory, join(agentDir, 'sessions')),
  }))
  await session.bindExtensions({})
})

after(async () => {
  await session.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' })
  session.dispose()
  server.close()
  process.env = originalEnvironment
  if (directory) await rm(directory, { recursive: true, force: true })
})

function customMessages(customType: string): Array<SessionEntry & { type: 'custom_message' }> {
  return session.sessionManager
    .getEntries()
    .filter(
      (entry): entry is SessionEntry & { type: 'custom_message' } =>
        entry.type === 'custom_message' && entry.customType === customType,
    )
}

async function waitFor<T>(read: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await sleep(100)
  }
  throw new Error('Timed out waiting for condition')
}

async function waitForIdle(): Promise<void> {
  await waitFor(() => (session.isStreaming ? undefined : true), 20_000)
}

function text(content: string | Array<{ type: string; text?: string }>): string {
  return typeof content === 'string'
    ? content
    : content.map(part => (part.type === 'text' ? part.text : '')).join('')
}

test(
  '/prewalk sends the template and registers dispatch_executor',
  { timeout: 30_000 },
  async () => {
    assert.equal(session.getToolDefinition('dispatch_executor'), undefined)
    await session.prompt('/prewalk add a feature', { expandPromptTemplates: true })
    const template = await waitFor(() => customMessages('prewalk-template')[0], 20_000)
    await waitForIdle()
    assert.match(text(template.content), /add a feature/)
    assert.match(text(template.content), /dispatch_executor/)
    assert.ok(session.getToolDefinition('dispatch_executor'))
  },
)

test('the first successful edit sends exactly one nudge', async () => {
  const runner = session.extensionRunner
  assert.ok(runner)
  const edit = (toolName: string, isError: boolean) =>
    runner.emit({
      type: 'tool_execution_end',
      toolName,
      toolCallId: `${toolName}-call`,
      input: {},
      result: { content: [], details: undefined },
      isError,
    })
  await edit('edit', true)
  await edit('read', false)
  assert.equal(customMessages('prewalk-nudge').length, 0)
  await edit('edit', false)
  await edit('write', false)
  assert.equal(customMessages('prewalk-nudge').length, 1)
})

test('dispatch forks the executor and the failure report arrives once', { timeout: 60_000 }, async () => {
  const dispatch = session.getToolDefinition('dispatch_executor')
  assert.ok(dispatch)
  const toolCallId = 'dispatch-call'
  const result = await dispatch.execute(toolCallId, {}, undefined, undefined, context)
  assert.match(text(result.content), new RegExp(executorModel))
  await assert.rejects(
    () => dispatch.execute('dispatch-call-2', {}, undefined, undefined, context),
    /already in flight/,
  )

  const now = Date.now()
  session.sessionManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'toolCall', id: toolCallId, name: 'dispatch_executor', arguments: {} }],
    api: 'openai-completions',
    provider: 'offline-test',
    model: 'executor',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: now,
  })
  session.sessionManager.appendMessage({
    role: 'toolResult',
    toolCallId,
    toolName: 'dispatch_executor',
    content: result.content,
    isError: false,
    timestamp: now,
  })
  await session.prompt('start the scheduled dispatch')
  await waitForIdle()

  const report = await waitFor(() => customMessages('prewalk-executor-result')[0], 45_000)
  const body = text(report.content)
  assert.match(body, /^Continuation finished WITH ERRORS/)
  assert.match(body, /executor \(low, offline-test\/executor, exit 1\)/)
  assert.match(body, /offline test rejects this request/)
  assert.match(body, /Verify the result/)
  await waitForIdle()
  assert.equal(customMessages('prewalk-executor-result').length, 1)
  await assert.doesNotReject(() =>
    dispatch.execute('dispatch-call-3', {}, undefined, undefined, context),
  )
})

test(
  'resuming a session that started prewalk registers dispatch_executor',
  { timeout: 30_000 },
  async () => {
    const sessionPath = session.sessionManager.getSessionFile()
    assert.ok(sessionPath)
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: join(directory, 'agent'),
      settingsManager: SettingsManager.inMemory(),
      extensionFactories: [prewalk],
    })
    await resourceLoader.reload()
    const { session: resumed } = await createAgentSession({
      cwd: directory,
      agentDir: join(directory, 'agent'),
      settingsManager: SettingsManager.inMemory(),
      modelRuntime: await ModelRuntime.create({
        authPath: join(directory, 'agent', 'auth.json'),
        modelsPath: join(directory, 'agent', 'models.json'),
        modelsStorePath: join(directory, 'agent', 'models-store.json'),
      }),
      resourceLoader,
      sessionManager: SessionManager.open(sessionPath, join(directory, 'agent', 'sessions')),
    })
    try {
      await resumed.bindExtensions({})
      assert.ok(resumed.getToolDefinition('dispatch_executor'))
    } finally {
      await resumed.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' })
      resumed.dispose()
    }
  },
)
