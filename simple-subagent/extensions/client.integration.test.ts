import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { registerClientBridge } from './client-bridge.ts'
import { registerSubagentTools, type RegisteredSubagentTools } from './tools.ts'

// Real Pi runtime, TCP bridge, registry, child processes, and the real bash tool.
// An unknown provider makes children fail locally before any model request. A
// provider whose server never answers requests that mention "hold" keeps children
// running until cancelled; every other request gets an immediate 401.
const unavailableModel = 'client-offline-test/missing-model'
const hangingModel = 'hanging-test/never-answers'
let directory: string
let session: AgentSession | undefined
let modelRuntime: ModelRuntime
let runtime: RegisteredSubagentTools
let context: ExtensionContext
let hangingServer: Server
let heldRequests = 0
let onExtensionInput: ((text: string) => void) | undefined
const originalEnvironment = { ...process.env }

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'subagent-client-integration-')))
  const agentDir = join(directory, 'agent')
  process.env = {
    ...Object.fromEntries(Object.entries(originalEnvironment).filter(([key]) =>
      ['PATH', 'SystemRoot', 'COMSPEC'].includes(key),
    )),
    HOME: directory,
    USERPROFILE: directory,
    TEMP: directory,
    TMP: directory,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
  }
  await mkdir(agentDir, { recursive: true })
  hangingServer = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8').on('data', chunk => { body += chunk }).on('end', () => {
      if (body.includes('hold')) {
        heldRequests += 1
        return
      }
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end('{"error":{"message":"offline test rejects this request"}}')
    })
  })
  await new Promise<void>(resolve => hangingServer.listen(0, '127.0.0.1', resolve))
  const address = hangingServer.address()
  assert.ok(address && typeof address !== 'string')
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      'hanging-test': {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: 'openai-completions',
        apiKey: 'offline-test-not-a-real-key',
        models: [{ id: 'never-answers' }],
      },
    },
  }))
  const settingsManager = SettingsManager.inMemory()
  modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    modelsStorePath: join(agentDir, 'models-store.json'),
  })
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir,
    settingsManager,
    extensionFactories: [pi => {
      const bridge = registerClientBridge(pi)
      runtime = registerSubagentTools(pi, false, {
        enableForkTool: true,
        modelAliases: { unavailable: unavailableModel },
      })
      bridge.attach(runtime)
      bridge.registerClosureWait()
      pi.on('session_start', (_event, ctx) => { context = ctx })
      pi.on('input', event => {
        if (event.source !== 'extension') return
        onExtensionInput?.(event.text)
        return { action: 'handled' }
      })
    }],
  })
  await resourceLoader.reload()
  assert.deepEqual(resourceLoader.getExtensions().errors, [])
  ;({ session } = await createAgentSession({
    cwd: directory,
    agentDir,
    settingsManager,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(directory),
  }))
  await session.bindExtensions({})
})

after(async () => {
  await session?.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' })
  session?.dispose()
  hangingServer.close()
  process.env = originalEnvironment
  if (directory) await rm(directory, { recursive: true, force: true })
})

type RunResult = {
  jobId: string
  isError: boolean
  text: string
  agents: Array<Record<string, unknown> & { name: string; sessionKey: string; status: string; output?: string }>
}

function script(code: string, env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: directory,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

const runScript = (agents: string) => `
  const { run } = await import(process.env.PI_SIMPLE_SUBAGENT_CLIENT)
  console.log(JSON.stringify(await run(${agents})))
`

async function run(agents: unknown[]): Promise<RunResult> {
  const result = await script(runScript(JSON.stringify(agents)))
  assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout)
}

async function rejects(agents: unknown, pattern: RegExp): Promise<void> {
  const result = await script(runScript(JSON.stringify(agents)))
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, pattern)
}

const agent = (name: string, extra: Record<string, unknown> = {}) => ({
  name, prompt: `${name} task`, cwd: directory, thinking: 'medium' as const, overrideModel: 'unavailable', ...extra,
})

test('run waits for all agents and returns the settled job without tools or prompts', { timeout: 30_000 }, async () => {
  const result = await run([
    agent('first', { sessionKey: 'first-session' }),
    agent('second', { overrideModel: unavailableModel, thinking: 'high', sessionKey: 'second-session' }),
  ])
  assert.equal(result.isError, true)
  assert.match(result.text, /client-offline-test\/missing-model/)
  assert.deepEqual(result.agents.map(({ name, sessionKey, status }) => ({ name, sessionKey, status })), [
    { name: 'first', sessionKey: 'first-session', status: 'failed' },
    { name: 'second', sessionKey: 'second-session', status: 'failed' },
  ])
  for (const entry of result.agents) {
    assert.equal(entry.output, undefined)
    assert.equal('tools' in entry, false)
    assert.equal('prompt' in entry, false)
    assert.equal(entry.effectiveModel, unavailableModel)
  }
  const joined = await runtime.join(result.jobId, undefined)
  assert.equal(joined.text, result.text)
})

test('invalid requests are rejected before any agent starts and leave no reservation', { timeout: 30_000 }, async () => {
  const valid = agent('valid', { sessionKey: 'valid-session' })
  await rejects([valid, { ...valid, thinking: 'invalid' }], /agents\/1\/thinking/)
  await rejects([{ ...valid, sesionKey: 'typo' }], /agents\/0: must not have additional properties/)
  await rejects([{ ...valid, name: '' }], /agents\/0\/name/)
  await rejects([{ ...valid, cwd: 'relative' }], /cwd must be an absolute path/)
  await rejects([], /agents: must not have fewer than 1 items/)
  await rejects({ agents: [valid] }, /agents: must be array/)
  await rejects(null, /agents: must be array/)
  const result = await run([valid])
  assert.equal(result.agents[0].sessionKey, 'valid-session')
})

test('same cwd and sessionKey cannot run twice in parallel but can run again afterwards', { timeout: 30_000 }, async () => {
  const shared = agent('shared', { sessionKey: 'shared-session' })
  const job = runtime.dispatchIsolated([shared], 'test', context)
  await rejects([shared], /Subagent session is already running/)
  await runtime.join(job.id, undefined)
  const result = await run([shared])
  assert.equal(result.agents[0].sessionKey, 'shared-session')
})

test('run fails outside a live session and with a wrong token', async () => {
  const clientUrl = process.env.PI_SIMPLE_SUBAGENT_CLIENT
  assert.ok(clientUrl?.startsWith('file://'))
  const outside = await script(`
    const { run } = await import(${JSON.stringify(clientUrl)})
    delete process.env.PI_SIMPLE_SUBAGENT_ENDPOINT
    delete process.env.PI_SIMPLE_SUBAGENT_TOKEN
    await run([])
  `)
  assert.equal(outside.code, 1)
  assert.match(outside.stderr, /available only inside a live Pi session/)
  const forged = await script(runScript('[]'), { ...process.env, PI_SIMPLE_SUBAGENT_TOKEN: 'forged' })
  assert.equal(forged.code, 1)
  assert.match(forged.stderr, /Authentication failed/)
})

test('dispatch returns immediately and the result arrives once through the user-input lifecycle', { timeout: 30_000 }, async t => {
  const completion = Promise.withResolvers<string>()
  const messages: string[] = []
  onExtensionInput = text => {
    messages.push(text)
    completion.resolve(text)
  }
  t.after(() => { onExtensionInput = undefined })
  const dispatched = await script(`
    const { dispatch } = await import(process.env.PI_SIMPLE_SUBAGENT_CLIENT)
    console.log(JSON.stringify(await dispatch(${JSON.stringify([agent('auto-first'), agent('auto-second', { sessionKey: 'auto-second-session' })])})))
  `)
  assert.equal(dispatched.code, 0, dispatched.stderr)
  const receipt: { jobId: string; agents: Array<{ name: string; sessionKey: string }> } = JSON.parse(dispatched.stdout)
  assert.equal(receipt.agents.length, 2)
  assert.deepEqual(receipt.agents[1], { name: 'auto-second', sessionKey: 'auto-second-session' })
  const message = await completion.promise
  assert.match(message, new RegExp(receipt.jobId))
  assert.match(message, /auto-first/)
  assert.match(message, /auto-second/)
  await runtime.join(receipt.jobId, undefined)
  assert.equal(messages.length, 1)
})

test('fork failure enters the user-input lifecycle', { timeout: 15_000 }, async t => {
  assert.ok(session)
  const completion = Promise.withResolvers<string>()
  onExtensionInput = text => completion.resolve(text)
  t.after(() => { onExtensionInput = undefined })
  const forkTool = session.getToolDefinition('runSubAgentsWithContext')
  assert.ok(forkTool)
  await forkTool.execute(
    'fork-call',
    { agents: [{ name: 'reviewer', prompt: 'Review', sessionKey: 'fork-key' }] },
    undefined,
    undefined,
    context,
  )
  await session.agent.prompt('Process the queued fork without configured credentials')
  assert.match(await completion.promise, /Forked subagents failed: Parent context can only be forked from a persisted session/)
})

test('omitted overrideModel inherits the current parent model after a model change', { timeout: 20_000 }, async () => {
  assert.ok(session)
  // Only the unprompted parent gets this in-memory credential. Children have none.
  await modelRuntime.setRuntimeApiKey('anthropic', 'offline-test-not-a-real-key')
  for (const id of ['claude-opus-4-5', 'claude-sonnet-4-5']) {
    const model = modelRuntime.getModel('anthropic', id)
    assert.ok(model)
    await session.setModel(model)
    const result = await run([{ name: 'inherited', prompt: 'No credentials are configured', cwd: directory, thinking: 'medium' }])
    assert.equal(result.agents[0].effectiveModel, `anthropic/${id}`)
    assert.equal(result.agents[0].suppliedModel, undefined)
    assert.equal(result.isError, true)
    assert.match(result.text, /No API key/)
  }
})

test('the real bash tool reaches the client through inherited environment', { timeout: 30_000 }, async () => {
  assert.ok(session)
  const bash = session.getToolDefinition('bash')
  assert.ok(bash)
  await writeFile(join(directory, 'delegate.mjs'), runScript(JSON.stringify([agent('via-bash')])))
  const result = await bash.execute('bash-call', { command: 'node delegate.mjs' }, undefined, undefined, context)
  const text = result.content.map(part => (part.type === 'text' ? part.text : '')).join('')
  const parsed: RunResult = JSON.parse(text.trim().split('\n').at(-1)!)
  assert.equal(parsed.agents[0].name, 'via-bash')
  assert.equal(parsed.agents[0].status, 'failed')
})

test('aborting the bash tool mid-run leaves the job running for automatic delivery', { timeout: 30_000 }, async t => {
  assert.ok(session)
  const bash = session.getToolDefinition('bash')
  assert.ok(bash)
  await writeFile(join(directory, 'hang.mjs'), runScript(JSON.stringify([agent('hanging', { prompt: 'hold', overrideModel: hangingModel })])))
  const controller = new AbortController()
  const execution = bash.execute('bash-abort', { command: 'node hang.mjs' }, controller.signal, undefined, context)
  const job = await waitFor(() => runningJob('hanging'))
  await waitFor(() => heldRequests === 1)
  const completion = Promise.withResolvers<string>()
  onExtensionInput = text => { if (text.includes(job.id)) completion.resolve(text) }
  t.after(() => { onExtensionInput = undefined })
  controller.abort()
  await execution.catch(() => {})
  assert.ok(runningJob('hanging'))
  const cancel = session.getToolDefinition('cancelSubAgents')
  assert.ok(cancel)
  await cancel.execute('cancel-orphan', { jobId: job.id }, undefined, undefined, context)
  const message = await completion.promise
  assert.match(message, new RegExp(job.id))
  assert.match(message, /interrupted/)
})

test('cancelSubAgents interrupts a running job and rejects unknown jobs', { timeout: 30_000 }, async () => {
  assert.ok(session)
  const cancel = session.getToolDefinition('cancelSubAgents')
  assert.ok(cancel)
  await assert.rejects(
    cancel.execute('cancel-unknown', { jobId: 'unknown' }, undefined, undefined, context),
    /No running subagent job unknown/,
  )
  const pending = script(runScript(JSON.stringify([agent('cancelled', { prompt: 'hold', overrideModel: hangingModel })])))
  const job = await waitFor(() => runningJob('cancelled'))
  await waitFor(() => heldRequests === 2)
  await cancel.execute('cancel-running', { jobId: job.id }, undefined, undefined, context)
  const result = await pending
  assert.equal(result.code, 0, result.stderr)
  const parsed: RunResult = JSON.parse(result.stdout)
  assert.equal(parsed.jobId, job.id)
  assert.equal(parsed.isError, true)
  assert.equal(parsed.agents[0].status, 'interrupted')
  assert.match(parsed.text, /interrupted/)
})

test('session shutdown rejects a waiting run and clears the environment', { timeout: 30_000 }, async () => {
  assert.ok(session)
  const endpoint = process.env.PI_SIMPLE_SUBAGENT_ENDPOINT!
  const pending = script(runScript(JSON.stringify([agent('orphaned', { prompt: 'hold', overrideModel: hangingModel })])))
  await waitFor(() => runningJob('orphaned'))
  await waitFor(() => heldRequests === 3)
  await session.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' })
  const result = await pending
  assert.equal(result.code, 1)
  assert.match(result.stderr, /closed the connection before replying/)
  assert.equal(process.env.PI_SIMPLE_SUBAGENT_ENDPOINT, undefined)
  assert.equal(process.env.PI_SIMPLE_SUBAGENT_TOKEN, undefined)
  assert.equal(process.env.PI_SIMPLE_SUBAGENT_CLIENT, undefined)
  const port = Number(new URL(endpoint).port)
  await assert.rejects(new Promise((resolve, reject) => {
    connect({ host: '127.0.0.1', port }).once('connect', resolve).once('error', reject)
  }), /ECONNREFUSED/)
})

function runningJob(agentName: string) {
  return runtime.listRunning().find(job => job.agents[0].name === agentName)
}

async function waitFor<T>(condition: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 20_000
  while (true) {
    const value = condition()
    if (value) return value
    if (Date.now() > deadline) throw new Error('Condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
