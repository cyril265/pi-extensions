import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { Model } from '@earendil-works/pi-ai'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type { SelfCompactionDetails } from './index.ts'

const extensionPath = fileURLToPath(new URL('./index.ts', import.meta.url))
const placeholder = '<<CODEWORD>>'
const codeword = 'PELICAN-7731'
const deployPlaceholder = '<<DEPLOY-TARGET>>'
const deployTarget = 'staging-eu-3'

const services = ['billing', 'search', 'auth', 'inventory', 'notifications', 'reporting']
const regions = ['eu-1', 'eu-2', 'us-east', 'us-west', 'ap-south']
const systemPrompt = [
  'You help a small team keep notes about their deployment. Keep answers short. Do not use tools.',
  '',
  'Team notes about the current services:',
  ...services.flatMap((service, serviceIndex) =>
    regions.map(
      (region, regionIndex) =>
        `- The ${service} service in ${region} runs ${2 + ((serviceIndex + regionIndex) % 5)} replicas behind the ${region} load balancer, is owned by squad ${String.fromCharCode(65 + serviceIndex)}, deploys on ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'][regionIndex]}, keeps logs for ${7 * (regionIndex + 1)} days, and pages the on-call engineer when its p99 latency stays above ${200 + 50 * serviceIndex} ms for ten minutes. Its database is backed up every ${serviceIndex + 2} hours and restores are rehearsed monthly.`,
    ),
  ),
  '',
  'Release checklist: update the changelog, run the smoke tests in staging, confirm the dashboards are green, announce the release in the team channel, and watch error rates for thirty minutes after rollout. Rollbacks use the previous image tag and need no approval. Hotfixes follow the same checklist but may skip the announcement until after rollout.',
  '',
  'Incident notes: write a short timeline, record the customer impact, list follow-up tasks with owners, and schedule a review within five working days. Keep incident documents factual and blameless.',
].join('\n')

const models = [
  { provider: 'openai-codex', id: 'gpt-5.6-luna' },
  { provider: 'anthropic', id: 'claude-haiku-5-5' },
  { provider: 'anthropic', id: 'claude-opus-5' },
]

type Target = { provider: string; id: string }

async function openSession(
  t: TestContext,
  target: Target,
  options: {
    thinkingLevel: ThinkingLevel
    reserveTokens?: number
    adjustModel?: (model: Model<string>) => Model<string>
  },
) {
  const root = await mkdtemp(join(tmpdir(), 'pi-self-compaction-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  const sessionDir = join(root, 'sessions')
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)])
  const payloads: string[] = []
  const sessions: { dispose(): void }[] = []
  t.after(async () => {
    for (const session of sessions) session.dispose()
    await rm(root, { recursive: true, force: true })
  })

  const settingsManager = SettingsManager.inMemory({
    defaultThinkingLevel: options.thinkingLevel,
    transport: 'sse',
    compaction: {
      keepRecentTokens: 1,
      ...(options.reserveTokens === undefined ? {} : { reserveTokens: options.reserveTokens }),
    },
    retry: { enabled: false, provider: { timeoutMs: 120_000, maxRetries: 0 } },
  })

  const start = async (sessionManager: SessionManager) => {
    const modelRuntime = await ModelRuntime.create()
    const catalogModel = modelRuntime.getModel(target.provider, target.id)
    assert.ok(
      catalogModel,
      `live test requires ${target.provider}/${target.id} in the model catalog`,
    )
    assert.ok(
      await modelRuntime.checkAuth(target.provider),
      `live test requires an existing ${target.provider} login`,
    )
    const model = options.adjustModel ? options.adjustModel(catalogModel) : catalogModel
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
      systemPromptOverride: () => systemPrompt,
      appendSystemPromptOverride: () => [],
      extensionFactories: [
        {
          name: 'codeword-projection',
          factory(pi) {
            pi.on('context', event => ({
              messages: event.messages.map(message => {
                if (message.role !== 'user') return message
                if (typeof message.content === 'string') {
                  return { ...message, content: message.content.replace(placeholder, codeword) }
                }
                return {
                  ...message,
                  content: message.content.map(block =>
                    block.type === 'text'
                      ? { ...block, text: block.text.replace(placeholder, codeword) }
                      : block,
                  ),
                }
              }),
            }))
          },
        },
        {
          name: 'deploy-target-payload',
          factory(pi) {
            pi.on('before_provider_request', event => {
              const payload = JSON.stringify(event.payload).replaceAll(
                deployPlaceholder,
                deployTarget,
              )
              payloads.push(payload)
              return JSON.parse(payload)
            })
          },
        },
      ],
    })
    await loader.reload()

    const { session, extensionsResult } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoader: loader,
      sessionManager,
      settingsManager,
      model,
      thinkingLevel: options.thinkingLevel,
      noTools: 'builtin',
    })
    sessions.push(session)
    const extensionErrors: unknown[] = []
    assert.deepEqual(extensionsResult.errors, [])
    await session.bindExtensions({ onError: error => extensionErrors.push(error) })
    return { session, extensionErrors }
  }

  const { session, extensionErrors } = await start(SessionManager.create(cwd, sessionDir))

  await session.prompt(`Remember this: the codeword is ${placeholder}. Reply OK.`)
  await session.prompt(
    `Also remember that the deploy target is ${deployPlaceholder}. Reply with a random six-digit number and nothing else.`,
  )
  const lastReply = session.messages.at(-1)
  assert.ok(
    lastReply?.role === 'assistant' && lastReply.stopReason === 'stop',
    `the session must answer normally: ${lastReply?.role === 'assistant' ? `${lastReply.stopReason} ${lastReply.errorMessage ?? ''}` : lastReply?.role}`,
  )
  const lastReplyNumber = lastReply.content
    .flatMap(block => (block.type === 'text' ? [block.text] : []))
    .join('')
    .match(/\d{6}/)?.[0]
  assert.ok(lastReplyNumber, 'the last reply must contain the six-digit number')
  const restart = () => {
    const sessionFile = session.sessionFile
    assert.ok(sessionFile, 'the session must be saved to a file')
    sessions.splice(sessions.indexOf(session), 1)
    session.dispose()
    return start(SessionManager.open(sessionFile, sessionDir))
  }
  return { session, lastReply, lastReplyNumber, payloads, extensionErrors, restart }
}

for (const target of models)
  test(`compaction asks ${target.provider}/${target.id} with the cached session context`, {
    timeout: 10 * 60_000,
  }, async t => {
    const { session, lastReply, lastReplyNumber, payloads, extensionErrors } = await openSession(
      t,
      target,
      {
        thinkingLevel: 'low',
        reserveTokens: 100,
      },
    )
    assert.ok(
      lastReply.usage.cacheRead > 0,
      'the session itself must hit the provider cache before compaction',
    )

    const result = await session.compact()
    assert.deepEqual(extensionErrors, [])

    const details = result.details as SelfCompactionDetails
    assert.equal(details.method, 'self-compaction', 'the extension must produce the compaction')
    assert.ok(
      payloads.at(-1)?.includes(lastReplyNumber),
      'the summary request must include the reply the session received after its last request',
    )
    assert.equal(
      details.source,
      'projection',
      'the extension must replay the projected session request',
    )
    assert.ok(
      result.summary.includes(codeword),
      `the summary must come from what the model saw, not the raw transcript: ${JSON.stringify(result.summary)}`,
    )
    assert.ok(
      !result.summary.includes(placeholder),
      'the raw transcript text never reached the model',
    )
    assert.ok(
      result.summary.includes(deployTarget),
      'the before_provider_request handlers of the session must rewrite the summary request',
    )
    assert.ok(result.usage, 'the compaction must report usage')
    t.diagnostic(
      `session cacheRead=${lastReply.usage.cacheRead} input=${lastReply.usage.input}; compaction cacheRead=${result.usage.cacheRead} input=${result.usage.input} output=${result.usage.output}`,
    )
    assert.ok(
      result.usage.cacheRead >= lastReply.usage.cacheRead,
      `compaction must reuse the session's cached prefix (cacheRead ${result.usage.cacheRead}, session ${lastReply.usage.cacheRead})`,
    )

    const entry = session.sessionManager
      .getEntries()
      .findLast(candidate => candidate.type === 'compaction')
    assert.ok(
      entry?.type === 'compaction' && entry.fromHook,
      'the persisted compaction must be extension-provided',
    )
  })

test('compaction right after a restart runs the provider hooks', {
  timeout: 10 * 60_000,
}, async t => {
  const { restart, payloads, lastReplyNumber } = await openSession(
    t,
    { provider: 'anthropic', id: 'claude-haiku-5-5' },
    { thinkingLevel: 'low', reserveTokens: 100 },
  )
  const { session, extensionErrors } = await restart()
  const requestsBeforeCompaction = payloads.length

  const result = await session.compact()
  assert.deepEqual(extensionErrors, [])

  const details = result.details as SelfCompactionDetails
  assert.equal(details.method, 'self-compaction', 'the extension must produce the compaction')
  assert.equal(details.source, 'session', 'no request may have been recorded since the restart')
  assert.equal(
    payloads.length,
    requestsBeforeCompaction + 1,
    'the summary request must pass the before_provider_request handlers',
  )
  assert.ok(
    payloads.at(-1)?.includes(lastReplyNumber),
    'the summary request must include the last reply',
  )
  assert.ok(
    result.summary.includes(deployTarget),
    `the summary must come from the rewritten request: ${JSON.stringify(result.summary)}`,
  )
})

test('a summary cut off at the output limit is not saved', { timeout: 10 * 60_000 }, async t => {
  const { session, extensionErrors } = await openSession(
    t,
    { provider: 'anthropic', id: 'claude-haiku-5-5' },
    { thinkingLevel: 'off', adjustModel: model => ({ ...model, maxTokens: 8 }) },
  )

  const outcome = await session.compact().then(
    result => result,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  )
  assert.ok(
    outcome instanceof Error && /token cap/.test(outcome.message),
    `compaction must fail at the token cap, got ${outcome instanceof Error ? outcome.message : JSON.stringify(outcome)}`,
  )
  assert.deepEqual(extensionErrors, [])
  assert.equal(
    session.sessionManager.getEntries().some(entry => entry.type === 'compaction'),
    false,
    'neither the cut-off handoff nor the cut-off default summary may be persisted',
  )
})
