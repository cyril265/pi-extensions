import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import cwdExtension from './index.ts'

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>

function appendAssistant(session: SessionManager, text: string): void {
  session.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text }],
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
}

function captureHandler(): CommandHandler {
  let handler: CommandHandler | undefined
  const pi = {
    registerCommand(name: string, options: { handler: CommandHandler }) {
      assert.equal(name, 'cwd')
      handler = options.handler
    },
  } as unknown as ExtensionAPI

  cwdExtension(pi)
  assert.ok(handler)
  return handler
}

test('/cwd materializes an unpersisted session in the target cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-cwd-empty-'))
  try {
    const sourceCwd = join(root, 'source')
    const targetCwd = join(root, 'target')
    const sessionsDir = join(root, 'sessions')
    await Promise.all([mkdir(sourceCwd), mkdir(targetCwd)])

    const source = SessionManager.create(sourceCwd, sessionsDir)
    source.appendMessage({
      role: 'bashExecution',
      command: 'pwd',
      output: sourceCwd,
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: Date.now(),
    })

    const sourceSessionFile = source.getSessionFile()
    assert.ok(sourceSessionFile)
    await assert.rejects(access(sourceSessionFile), { code: 'ENOENT' })

    let switchedSession: SessionManager | undefined
    const ctx = {
      cwd: sourceCwd,
      sessionManager: source,
      ui: { notify() {} },
      waitForIdle: async () => {},
      switchSession: async (sessionPath: string) => {
        switchedSession = SessionManager.open(sessionPath, sessionsDir)
        return { cancelled: false }
      },
    } as unknown as ExtensionCommandContext

    await captureHandler()(targetCwd, ctx)

    assert.ok(switchedSession)
    assert.equal(switchedSession.getCwd(), await realpath(targetCwd))
    const header = switchedSession.getHeader()
    assert.ok(header)
    assert.equal(header.parentSession, undefined)
    assert.match(JSON.stringify(switchedSession.buildSessionContext().messages), /bashExecution/)
    assert.match(JSON.stringify(switchedSession.buildSessionContext().messages), /pwd/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('/cwd continues to fork a persisted source session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-cwd-persisted-'))
  try {
    const sourceCwd = join(root, 'source')
    const targetCwd = join(root, 'target')
    const sessionsDir = join(root, 'sessions')
    await Promise.all([mkdir(sourceCwd), mkdir(targetCwd)])

    const source = SessionManager.create(sourceCwd, sessionsDir)
    source.appendMessage({ role: 'user', content: 'Keep this context', timestamp: Date.now() })
    appendAssistant(source, 'Context retained')

    const sourceSessionFile = source.getSessionFile()
    assert.ok(sourceSessionFile)
    await access(sourceSessionFile)

    let switchedSession: SessionManager | undefined
    const ctx = {
      cwd: sourceCwd,
      sessionManager: source,
      ui: { notify() {} },
      waitForIdle: async () => {},
      switchSession: async (sessionPath: string) => {
        switchedSession = SessionManager.open(sessionPath, sessionsDir)
        return { cancelled: false }
      },
    } as unknown as ExtensionCommandContext

    await captureHandler()(targetCwd, ctx)

    assert.ok(switchedSession)
    assert.equal(switchedSession.getHeader()?.parentSession, sourceSessionFile)
    assert.match(JSON.stringify(switchedSession.buildSessionContext().messages), /Context retained/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
