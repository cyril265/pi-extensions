import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent'
import { registerHerdrChildBridge } from './herdr-child.ts'

async function readBridgeResult(resultPath: string): Promise<unknown> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fs.existsSync(resultPath)) return JSON.parse(await readFile(resultPath, 'utf8'))
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Herdr child did not report prompt startup failure')
}

test('reports missing model authentication before starting a Herdr prompt', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'simple-subagent-herdr-child-'))
  const agentDir = path.join(directory, 'agent')
  const resultPath = path.join(directory, 'result.json')
  const eventPath = path.join(directory, 'events.jsonl')
  const abortPath = path.join(directory, 'abort')
  const promptPath = path.join(directory, 'prompt.txt')
  const startPath = path.join(directory, 'start')
  const originalEnvironment = process.env
  let session: AgentSession | undefined

  try {
    process.env = {
      ...Object.fromEntries(
        Object.entries(originalEnvironment).filter(([name]) =>
          ['PATH', 'SystemRoot', 'COMSPEC'].includes(name),
        ),
      ),
      HOME: directory,
      USERPROFILE: directory,
      TEMP: directory,
      TMP: directory,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: '1',
      PI_SIMPLE_SUBAGENT_HERDR_RESULT_PATH: resultPath,
      PI_SIMPLE_SUBAGENT_HERDR_EVENT_PATH: eventPath,
      PI_SIMPLE_SUBAGENT_HERDR_ABORT_PATH: abortPath,
      PI_SIMPLE_SUBAGENT_HERDR_PROMPT_PATH: promptPath,
      PI_SIMPLE_SUBAGENT_HERDR_START_PATH: startPath,
    }
    await mkdir(agentDir, { recursive: true })
    await writeFile(eventPath, '')
    await writeFile(promptPath, 'This prompt must not reach a provider')
    await writeFile(startPath, '')

    const settingsManager = SettingsManager.inMemory()
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
      modelsStorePath: path.join(agentDir, 'models-store.json'),
    })
    const model = modelRuntime.getModel('anthropic', 'claude-opus-5')
    assert.ok(model)
    assert.equal(await modelRuntime.getAuth(model), undefined)

    const resourceLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir,
      settingsManager,
      extensionFactories: [registerHerdrChildBridge],
    })
    await resourceLoader.reload()
    assert.deepEqual(resourceLoader.getExtensions().errors, [])
    ;({ session } = await createAgentSession({
      cwd: directory,
      agentDir,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(directory),
      settingsManager,
    }))
    await session.bindExtensions({})

    assert.deepEqual(await readBridgeResult(resultPath), {
      ok: false,
      error: 'No API key found for anthropic.',
    })
    assert.deepEqual(session.messages, [])
    assert.equal(await readFile(eventPath, 'utf8'), '')
  } finally {
    await session?.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' })
    session?.dispose()
    process.env = originalEnvironment
    await rm(directory, { recursive: true, force: true })
  }
})
