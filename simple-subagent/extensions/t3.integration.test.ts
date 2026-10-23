import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import extension from './extension.ts'

const originalEnvironment = { ...process.env }
const dispatchTools = ['runSubAgents', 'runSubAgentsWithContext', 'cancelSubAgents']
const aliasModel = 'openai-codex/gpt-6.1-sol'

test('T3 parents offer only T3 delegation; ordinary Pi and managed children keep native tools', async t => {
  for (const mode of ['t3', 'ordinary', 'managed-child'] as const) {
    await t.test(mode, async t => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'subagent-t3-routing-')))
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
        ...(mode === 'ordinary'
          ? {}
          : {
              T3_MCP_URL: 'http://127.0.0.1:1/mcp',
              T3_MCP_BEARER_TOKEN: 'unused-test-token',
            }),
        ...(mode === 'managed-child' ? { PI_SIMPLE_SUBAGENT: '1' } : {}),
        ...(mode === 't3'
          ? {
              PI_SIMPLE_SUBAGENT_CLIENT: 'file:///obsolete/client.mjs',
              PI_SIMPLE_SUBAGENT_ENDPOINT: 'tcp://127.0.0.1:1',
              PI_SIMPLE_SUBAGENT_TOKEN: 'obsolete-client-token',
            }
          : {}),
      }
      t.after(async () => {
        process.env = originalEnvironment
        await rm(directory, { recursive: true, force: true })
      })
      await mkdir(agentDir)
      await writeFile(
        join(agentDir, 'simple-subagent.json'),
        JSON.stringify({
          enableForkTool: true,
          modelAliases: { sol: aliasModel },
        }),
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
        extensionFactories: [extension],
      })
      await resourceLoader.reload()
      assert.deepEqual(resourceLoader.getExtensions().errors, [])
      const { session } = await createAgentSession({
        cwd: directory,
        agentDir,
        settingsManager,
        modelRuntime,
        resourceLoader,
        sessionManager: SessionManager.inMemory(directory),
      })
      t.after(async () => {
        await session.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' })
        session.dispose()
      })
      await session.bindExtensions({})
      const runner = session.extensionRunner
      assert.ok(runner)
      const registered = session.getAllTools().map(tool => tool.name)
      const active = session.getActiveToolNames()
      for (const name of dispatchTools) {
        assert.equal(registered.includes(name), mode !== 't3', `${mode} registered ${name}`)
        assert.equal(active.includes(name), mode !== 't3', `${mode} activated ${name}`)
        assert.equal(session.getToolDefinition(name) !== undefined, mode !== 't3')
      }
      assert.equal(runner.getCommand('subagents') !== undefined, mode !== 't3')
      assert.equal(process.env.PI_SIMPLE_SUBAGENT_CLIENT !== undefined, mode !== 't3')
      assert.equal(process.env.PI_SIMPLE_SUBAGENT_ENDPOINT !== undefined, mode !== 't3')
      assert.equal(process.env.PI_SIMPLE_SUBAGENT_TOKEN !== undefined, mode !== 't3')

      const { systemPromptOptions } = await runner.emitBeforeAgentStart(
        { messageType: 'user', prompt: 'use a sol subagent to sleep 30s' },
        { cwd: directory, selectedTools: active },
      )
      if (mode === 't3') {
        const routing = systemPromptOptions.sections.t3_delegation
        assert.ok(routing)
        assert.match(routing, /mcp__t3-code__delegate_task/)
        assert.match(routing, /mcp__t3-code__orchestrator_capabilities/)
        assert.ok(routing.includes(`sol: ${aliasModel}`))
        await session.reload()
        for (const name of dispatchTools) assert.equal(session.getToolDefinition(name), undefined)
        assert.equal(process.env.PI_SIMPLE_SUBAGENT_CLIENT, undefined)
        const reloadedRunner = session.extensionRunner
        assert.ok(reloadedRunner)
        const reloaded = await reloadedRunner.emitBeforeAgentStart(
          { messageType: 'user', prompt: 'use a sol subagent to sleep 30s' },
          { cwd: directory, selectedTools: session.getActiveToolNames() },
        )
        assert.equal(reloaded.systemPromptOptions.sections.t3_delegation, routing)
      } else {
        assert.equal(systemPromptOptions.sections.t3_delegation, undefined)
      }
      if (mode === 'managed-child') {
        const tool = session.getToolDefinition('runSubAgents')
        assert.ok(tool)
        await assert.rejects(
          tool.execute(
            'managed-run',
            { agents: [] },
            undefined,
            undefined,
            runner.createToolContext('managed-run', undefined),
          ),
          /Subagent tools are unavailable during this run/,
        )
      }
    })
  }
})
