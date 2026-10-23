import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import * as pi from '@earendil-works/pi-coding-agent'
import sessionSearchExtension from './index.ts'

const environmentKeys = [
  'HOME',
  'USERPROFILE',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_OFFLINE',
]

test('searches sessions from other working directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-session-search-'))
  const originalEnvironment = Object.fromEntries(
    environmentKeys.map(key => [key, process.env[key]]),
  )
  let closeSession = async () => {}

  try {
    const agentDir = join(root, 'agent')
    const currentCwd = join(root, 'current-project')
    const priorCwd = join(root, 'prior-project')
    await Promise.all([mkdir(agentDir), mkdir(currentCwd), mkdir(priorCwd)])

    process.env.HOME = root
    process.env.USERPROFILE = root
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.PI_OFFLINE = '1'
    delete process.env.PI_CODING_AGENT_SESSION_DIR

    const query = 'cross-project-session-result-47d2'
    const priorSession = pi.SessionManager.create(priorCwd)
    priorSession.appendMessage({ role: 'user', content: query, timestamp: Date.now() })
    priorSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'Recorded' }],
      api: 'test',
      provider: 'test',
      model: 'test',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    })
    const priorSessionFile = priorSession.getSessionFile()
    assert.ok(priorSessionFile)

    const currentSession = pi.SessionManager.create(currentCwd)
    currentSession.appendMessage({
      role: 'user',
      content: 'Current session content',
      timestamp: Date.now(),
    })

    let context
    const settingsManager = pi.SettingsManager.inMemory()
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: currentCwd,
      agentDir,
      settingsManager,
      extensionFactories: [
        sessionSearchExtension,
        extension => {
          extension.on('session_start', (_event, ctx) => {
            context = ctx
          })
        },
      ],
    })
    await resourceLoader.reload()
    assert.deepEqual(resourceLoader.getExtensions().errors, [])

    const modelRuntime = await pi.ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: join(agentDir, 'models.json'),
      modelsStorePath: join(agentDir, 'models-store.json'),
    })
    const created = await pi.createAgentSession({
      cwd: currentCwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoader,
      sessionManager: currentSession,
    })
    const session = created.session
    await session.bindExtensions({})
    closeSession = async () => {
      await session.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' })
      session.dispose()
    }

    assert.ok(context)
    const search = session.getToolDefinition('sessions-search')
    assert.ok(search)
    const result = await search.execute(
      'search-call',
      { query, caseSensitive: false, maxResults: 10 },
      undefined,
      undefined,
      context,
    )
    const text = result.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')

    assert.match(text, new RegExp(query))
    assert.ok(text.includes(priorSessionFile), text)
  } finally {
    await closeSession()
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})
