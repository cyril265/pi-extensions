import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'

const extensionPath = join(import.meta.dirname, 'index.ts')
const section = 'provider_system_prompt_append'
const originalEnvironment = { ...process.env }
let directory: string
let modelRuntime: ModelRuntime
let session: AgentSession
let renderedPrompt: string

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'provider-system-prompt-append-')))
  const agentDir = join(directory, 'agent')
  const cwd = join(directory, 'project')
  process.env = { ...originalEnvironment, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' }
  await mkdir(agentDir, { recursive: true })
  await mkdir(join(cwd, '.pi'), { recursive: true })
  const provider = (models: string[]) => ({
    baseUrl: 'http://127.0.0.1:9/v1',
    api: 'openai-completions',
    apiKey: 'offline-test-not-a-real-key',
    models: models.map((id) => ({ id })),
  })
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: { alpha: provider(['one/model:x', 'two']), beta: provider(['plain']) },
    }),
  )
  await writeFile(join(agentDir, 'APPEND_SYSTEM.alpha.md'), 'global alpha provider')
  await writeFile(join(cwd, '.pi', 'APPEND_SYSTEM.alpha.md'), 'project alpha provider')
  await writeFile(join(agentDir, 'APPEND_SYSTEM.alpha.one%2Fmodel%3Ax.md'), 'global alpha model')

  const settingsManager = SettingsManager.inMemory()
  modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    modelsStorePath: join(agentDir, 'models-store.json'),
  })
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [extensionPath],
    extensionFactories: [
      (pi) => {
        pi.on('before_agent_start', (event) => {
          renderedPrompt = event.systemPrompt
        })
      },
    ],
  })
  await resourceLoader.reload()
  assert.deepEqual(resourceLoader.getExtensions().errors, [])
  ;({ session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    modelRuntime,
    resourceLoader,
    model: modelRuntime.getModel('alpha', 'one/model:x'),
    sessionManager: SessionManager.inMemory(cwd),
  }))
  await session.bindExtensions({})
})

after(async () => {
  session?.dispose()
  process.env = originalEnvironment
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function startTurn() {
  const result = await session.extensionRunner.emitBeforeAgentStart(
    'hello',
    undefined,
    session.extensionRunner.createCommandContext().getSystemPromptOptions(),
  )
  assert.equal(result.systemPromptOptions.forceSystemPrompt, undefined)
  return { sections: result.systemPromptOptions.sections, prompt: renderedPrompt }
}

async function switchModel(provider: string, id: string) {
  const model = modelRuntime.getModel(provider, id)
  assert.ok(model)
  await session.setModel(model)
}

test('provider and model appends follow the current model as one structured section', async () => {
  const first = await startTurn()
  const expected = 'project alpha provider\n\nglobal alpha model'
  assert.equal(first.sections[section], expected)
  assert.ok(first.prompt.endsWith(`<${section}>\n${expected}\n</${section}>`))
  assert.deepEqual(await startTurn(), first)

  await switchModel('alpha', 'two')
  assert.equal((await startTurn()).sections[section], 'project alpha provider')

  await switchModel('beta', 'plain')
  const withoutAppends = await startTurn()
  assert.equal(section in withoutAppends.sections, false)
  assert.ok(!withoutAppends.prompt.includes('alpha'))

  await switchModel('alpha', 'one/model:x')
  assert.deepEqual(await startTurn(), first)
})
