import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'

const live = process.env.PI_ASTRA_LIVE_TEST === '1'
const extensionPath = fileURLToPath(new URL('./index.ts', import.meta.url))
const prompt = 'Reply with exactly OK and nothing else.'

type Payload = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requirePayload(value: unknown): Payload {
  assert.ok(isRecord(value), 'provider payload must be an object')
  return value
}

function requireInput(payload: Payload): unknown[] {
  assert.ok(Array.isArray(payload.input), 'provider payload must have an input array')
  return payload.input
}

function requestPrefix(payload: Payload): Payload {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'input'))
}

function assertAstraPayload(
  value: unknown,
  expectedTopLevelEffort: string,
  expectedUpdates: string[],
): Payload {
  const payload = requirePayload(value)
  assert.equal(payload.model, 'gpt-6-astra')
  assert.ok(isRecord(payload.reasoning), 'Astra payload must have reasoning settings')
  assert.equal(
    payload.reasoning.effort,
    expectedTopLevelEffort,
    'the request effort must stay pinned to the current prompt prefix',
  )
  assert.equal(payload.tools, undefined, 'the extension must not add a reasoning tool')

  const input = requireInput(payload)
  const updates: string[] = []

  for (const [index, item] of input.entries()) {
    if (!isRecord(item) || item.type !== 'configuration_update') continue

    assert.deepEqual(Object.keys(item).sort(), ['reasoning', 'type'])
    assert.ok(isRecord(item.reasoning), 'configuration_update must contain reasoning')
    assert.deepEqual(Object.keys(item.reasoning), ['effort'])
    assert.ok(typeof item.reasoning.effort === 'string')
    updates.push(item.reasoning.effort)

    const previous = input[index - 1]
    assert.ok(
      !isRecord(previous) || previous.type !== 'configuration_update',
      'consecutive configuration_update items must be coalesced',
    )
    const next = input[index + 1]
    assert.ok(
      isRecord(next) && next.role === 'user',
      'configuration_update must precede the user turn where it takes effect',
    )
  }

  assert.deepEqual(updates, expectedUpdates)
  return payload
}

function hiddenMarkerTexts(session: AgentSession): string[] {
  return session.sessionManager.getEntries().flatMap(entry => {
    if (entry.type !== 'custom_message' || entry.display) return []
    if (typeof entry.content === 'string') return [entry.content]
    return entry.content.flatMap(content => (content.type === 'text' ? [content.text] : []))
  })
}

function activeHiddenMarkerIds(session: AgentSession): string[] {
  return session.sessionManager
    .buildContextEntries()
    .flatMap(entry => (entry.type === 'custom_message' && !entry.display ? [entry.id] : []))
}

function userInputTexts(payload: Payload): string[] {
  return requireInput(payload).flatMap(item => {
    if (!isRecord(item) || item.role !== 'user' || !Array.isArray(item.content)) return []
    return item.content.flatMap(content =>
      isRecord(content) && content.type === 'input_text' && typeof content.text === 'string'
        ? [content.text]
        : [],
    )
  })
}

function expectedUserItemCount(session: AgentSession): number {
  return session.messages.filter(message => {
    if (message.role === 'user' || message.role === 'compactionSummary') return true
    if (message.role === 'branchSummary') return true
    return message.role === 'bashExecution' && !message.excludeFromContext
  }).length
}

test(
  'Astra reasoning updates use the live Codex configuration_update protocol',
  {
    skip: live ? undefined : 'set PI_ASTRA_LIVE_TEST=1 to spend live Codex credits',
    timeout: 15 * 60_000,
  },
  async t => {
    const root = await mkdtemp(join(tmpdir(), 'pi-astra-reasoning-'))
    const cwd = join(root, 'project')
    const agentDir = join(root, 'agent')
    const sessionDir = join(root, 'sessions')
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(agentDir, { recursive: true }),
      mkdir(sessionDir, { recursive: true }),
    ])

    const sessions = new Set<AgentSession>()
    t.after(async () => {
      for (const session of sessions) session.dispose()
      await rm(root, { recursive: true, force: true })
    })

    // ModelRuntime intentionally uses Pi's normal catalog and existing login.
    const modelRuntime = await ModelRuntime.create()
    const astra = modelRuntime.getModel('openai-codex', 'gpt-6-astra')
    const luna = modelRuntime.getModel('openai-codex', 'gpt-5.6-luna')
    assert.ok(astra, 'live test requires openai-codex/gpt-6-astra in the model catalog')
    assert.ok(luna, 'live test requires openai-codex/gpt-5.6-luna in the model catalog')
    assert.ok(
      await modelRuntime.checkAuth('openai-codex'),
      'live test requires an existing OpenAI Codex login',
    )

    const settingsManager = SettingsManager.inMemory({
      defaultThinkingLevel: 'low',
      transport: 'sse',
      compaction: { keepRecentTokens: 1 },
      retry: {
        enabled: false,
        provider: { timeoutMs: 120_000, maxRetries: 0 },
      },
    })
    const payloads: unknown[] = []
    const extensionErrors: unknown[] = []
    let cacheReadTokens = 0

    async function openSession(
      sessionManager: SessionManager,
      restore: boolean,
    ): Promise<AgentSession> {
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: [extensionPath],
        systemPromptOverride: () => 'Return exactly OK. Do not use tools.',
        appendSystemPromptOverride: () => [],
        // File extensions load first. This observer therefore sees the final payload
        // after the real extension and never replaces the request or response.
        extensionFactories: [
          {
            name: 'provider-request-observer',
            factory(pi) {
              pi.on('before_provider_request', event => {
                payloads.push(structuredClone(event.payload))
              })
            },
          },
        ],
      })
      await loader.reload()

      const options: CreateAgentSessionOptions = {
        cwd,
        agentDir,
        modelRuntime,
        resourceLoader: loader,
        sessionManager,
        settingsManager,
        noTools: 'builtin',
      }
      if (!restore) {
        options.model = astra
        options.thinkingLevel = 'low'
      }

      const result = await createAgentSession(options)
      assert.deepEqual(result.extensionsResult.errors, [])
      await result.session.bindExtensions({ onError: error => extensionErrors.push(error) })
      assert.deepEqual(
        result.session.agent.state.tools.map(tool => tool.name),
        [],
        'the extension must not register an automatic reasoning tool',
      )
      sessions.add(result.session)
      return result.session
    }

    async function promptOnce(session: AgentSession): Promise<unknown> {
      const payloadCount = payloads.length
      await session.prompt(prompt)
      assert.equal(
        payloads.length,
        payloadCount + 1,
        'a tool-free prompt must make exactly one observed provider request',
      )
      const response = session.messages.at(-1)
      assert.ok(
        response && response.role === 'assistant',
        'live model must return an assistant response',
      )
      assert.equal(response.errorMessage, undefined)
      assert.equal(response.stopReason, 'stop')
      cacheReadTokens += response.usage.cacheRead
      assert.deepEqual(extensionErrors, [], 'extension hooks must not fail')
      return payloads[payloadCount]
    }

    let session = await openSession(SessionManager.create(cwd, sessionDir), false)

    const initial = assertAstraPayload(await promptOnce(session), 'low', [])

    session.setThinkingLevel('medium')
    assert.equal(session.cycleThinkingLevel(), 'high')
    const coalesced = assertAstraPayload(await promptOnce(session), 'low', ['high'])
    assert.equal(
      JSON.stringify(requestPrefix(coalesced)),
      JSON.stringify(requestPrefix(initial)),
      'changing effort must leave the request prefix outside input byte-equivalent',
    )
    assert.equal(
      JSON.stringify(requireInput(coalesced).slice(0, requireInput(initial).length)),
      JSON.stringify(requireInput(initial)),
      'changing effort must leave the existing input prefix byte-equivalent',
    )

    assert.equal(session.cycleThinkingLevel(), 'xhigh')
    assertAstraPayload(await promptOnce(session), 'low', ['high', 'xhigh'])

    const originalSessionFile = session.sessionFile
    assert.ok(originalSessionFile, 'the test session must be persisted to disk')
    const persisted = await readFile(originalSessionFile, 'utf8')
    assert.match(persisted, /"type":"custom_message"/)
    session.dispose()
    sessions.delete(session)

    session = await openSession(SessionManager.open(originalSessionFile, sessionDir), true)
    assert.equal(session.model?.id, 'gpt-6-astra')
    assert.equal(session.thinkingLevel, 'xhigh')
    assertAstraPayload(await promptOnce(session), 'low', ['high', 'xhigh'])

    const sourceSessionFile = session.sessionFile
    assert.ok(sourceSessionFile)
    session.dispose()
    sessions.delete(session)

    const forkManager = SessionManager.forkFrom(sourceSessionFile, cwd, sessionDir)
    assert.notEqual(forkManager.getSessionFile(), sourceSessionFile)
    const forkHeader = forkManager.getHeader()
    assert.ok(forkHeader)
    assert.equal(forkHeader.parentSession, sourceSessionFile)
    session = await openSession(forkManager, true)
    assertAstraPayload(await promptOnce(session), 'low', ['high', 'xhigh'])

    await session.setModel(luna)
    session.setThinkingLevel('high')
    assert.equal(session.cycleThinkingLevel(), 'xhigh')
    const lunaPayload = requirePayload(await promptOnce(session))
    assert.equal(lunaPayload.model, 'gpt-5.6-luna')
    assert.ok(isRecord(lunaPayload.reasoning))
    const lunaEffort = luna.thinkingLevelMap?.xhigh ?? 'xhigh'
    assert.equal(lunaPayload.reasoning.effort, lunaEffort)
    assert.equal(lunaPayload.tools, undefined)
    assert.equal(
      requireInput(lunaPayload).some(
        item => isRecord(item) && item.type === 'configuration_update',
      ),
      false,
      'GPT-5.6 must not receive native Astra updates',
    )

    const markerTexts = hiddenMarkerTexts(session)
    assert.ok(markerTexts.length > 0, 'the persisted Astra transition must use hidden messages')
    const lunaTexts = userInputTexts(lunaPayload)
    for (const markerText of markerTexts) {
      assert.ok(!lunaTexts.includes(markerText), 'GPT-5.6 must not receive internal marker text')
    }
    assert.equal(
      requireInput(lunaPayload).filter(item => isRecord(item) && item.role === 'user').length,
      expectedUserItemCount(session),
      'GPT-5.6 must not receive an ephemeral carrier as an extra user item',
    )

    await session.setModel(astra)
    assert.equal(session.thinkingLevel, 'low')
    assertAstraPayload(await promptOnce(session), 'low', ['high', 'xhigh', 'low'])

    session.setThinkingLevel('xhigh')
    assertAstraPayload(await promptOnce(session), 'low', ['high', 'xhigh', 'low', 'xhigh'])

    const oldMarkerIds = activeHiddenMarkerIds(session)
    assert.ok(oldMarkerIds.length > 0)
    const compaction = await session.compact()
    assert.ok(
      compaction.summary.length > 0,
      'ordinary Pi compaction must complete through live Codex',
    )
    // Pi's summarizer bypasses the session's before_provider_request hook.
    assert.ok(
      compaction.usage && compaction.usage.totalTokens > 0,
      'compaction must report live model usage',
    )
    assert.deepEqual(extensionErrors, [], 'compaction hooks must not fail')

    const activeIdsAfterCompaction = new Set(activeHiddenMarkerIds(session))
    for (const oldMarkerId of oldMarkerIds) {
      assert.equal(
        activeIdsAfterCompaction.has(oldMarkerId),
        false,
        'keepRecentTokens=1 must remove the old transition markers from active context',
      )
    }

    // Compaction creates a new prompt prefix. The selected effort becomes its new
    // top-level baseline, and later changes use native updates from that baseline.
    assertAstraPayload(await promptOnce(session), 'xhigh', [])
    session.setThinkingLevel('max')
    assertAstraPayload(await promptOnce(session), 'xhigh', ['max'])

    assert.ok(payloads.length <= 15, `live test exceeded its 15-request budget: ${payloads.length}`)
    t.diagnostic(
      `Observed ${cacheReadTokens} cache-read tokens; cache hits are intentionally not asserted.`,
    )
  },
)
