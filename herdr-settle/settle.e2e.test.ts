import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createConnection } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  appendShelf,
  defaultAgentDir,
  type LogEntry,
  logFile,
  readShelf,
  type SettledTab,
  type ShelfEvent,
} from './settle.ts'

const herdrCommand = process.platform === 'win32' ? 'herdr.exe' : 'herdr'
const realAgentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
const integration = path.join(realAgentDir, 'extensions', 'herdr-agent-state.ts')
const workspaceId = process.env.HERDR_WORKSPACE_ID
const skip =
  process.env.HERDR_SOCKET_PATH && workspaceId
    ? existsSync(integration)
      ? false
      : 'requires the herdr pi integration (herdr integration install pi)'
    : 'requires a running herdr server'
const DAY_MS = 24 * 60 * 60 * 1000

interface Pane {
  pane_id: string
  tab_id: string
  agent?: string
  agent_session?: { kind?: string; value?: string }
}

function herdr<T>(args: string[]): T {
  const result = spawnSync(herdrCommand, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = result.stdout.trim() || result.stderr.trim()
  if (!output && result.status === 0) return undefined as T
  const parsed = JSON.parse(output) as { result?: T; error?: { code?: string; message?: string } }
  if (parsed.error)
    throw Object.assign(new Error(parsed.error.message), { code: parsed.error.code })
  return parsed.result as T
}

function tabExists(tabId: string): boolean {
  try {
    herdr(['tab', 'get', tabId])
    return true
  } catch (error) {
    if ((error as { code?: string }).code === 'tab_not_found') return false
    throw error
  }
}

function panes(): Pane[] {
  return herdr<{ panes: Pane[] }>(['pane', 'list', '--workspace', workspaceId!]).panes
}

async function waitFor<T>(
  what: string,
  timeoutMs: number,
  probe: () => T | undefined | false,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`timed out waiting for ${what}`)
}

class Fixture {
  readonly root = mkdtempSync(path.join(os.tmpdir(), 'herdr-settle-'))
  readonly agentDir = path.join(this.root, 'agent')
  readonly project = path.join(this.root, 'project')
  readonly tabs: string[] = []

  constructor() {
    mkdirSync(path.join(this.agentDir, 'extensions'), { recursive: true })
    mkdirSync(path.join(this.agentDir, 'sessions'), { recursive: true })
    mkdirSync(this.project, { recursive: true })
    const forward = (name: string, target: string) =>
      writeFileSync(
        path.join(this.agentDir, 'extensions', name),
        `export { default } from ${JSON.stringify(pathToFileURL(target).href)};\n`,
      )
    forward('herdr-settle.ts', path.join(import.meta.dirname, 'index.ts'))
    forward('herdr-agent-state.ts', integration)
  }

  session(name: string, lastActivity: number): string {
    const file = path.join(this.agentDir, 'sessions', `${name}.jsonl`)
    const at = (offset: number) => new Date(lastActivity - 2000 + offset).toISOString()
    const entries = [
      {
        type: 'session',
        version: 3,
        id: `0199aaaa-0000-7000-8000-${name.padStart(12, '0').slice(-12)}`,
        timestamp: at(0),
        cwd: this.project,
      },
      {
        type: 'message',
        id: 'a0000001',
        parentId: null,
        timestamp: at(1000),
        message: { role: 'user', content: 'Fix the settle flow', timestamp: lastActivity - 1000 },
      },
      {
        type: 'message',
        id: 'a0000002',
        parentId: 'a0000001',
        timestamp: at(2000),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'claude-opus-5',
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: lastActivity,
        },
      },
    ]
    writeFileSync(file, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`)
    return file
  }

  tab(label: string, env: string[] = []): { tabId: string; paneId: string } {
    const created = herdr<{ tab: { tab_id: string }; root_pane: { pane_id: string } }>([
      'tab',
      'create',
      '--workspace',
      workspaceId!,
      '--cwd',
      this.project,
      '--label',
      label,
      '--no-focus',
      '--env',
      `PI_CODING_AGENT_DIR=${this.agentDir}`,
      ...env.flatMap(entry => ['--env', entry]),
    ])
    this.tabs.push(created.tab.tab_id)
    return { tabId: created.tab.tab_id, paneId: created.root_pane.pane_id }
  }

  workspace(label: string): { workspaceId: string; tabId: string; paneId: string } {
    const created = herdr<{
      workspace: { workspace_id: string }
      tab: { tab_id: string }
      root_pane: { pane_id: string }
    }>([
      'workspace',
      'create',
      '--cwd',
      this.project,
      '--label',
      label,
      '--no-focus',
      '--env',
      `PI_CODING_AGENT_DIR=${this.agentDir}`,
    ])
    this.tabs.push(created.tab.tab_id)
    return {
      workspaceId: created.workspace.workspace_id,
      tabId: created.tab.tab_id,
      paneId: created.root_pane.pane_id,
    }
  }

  startPi(paneId: string, sessionFile: string): void {
    herdr([
      'agent',
      'start',
      `settle-test-${Math.random().toString(16).slice(2, 8)}`,
      '--kind',
      'pi',
      '--pane',
      paneId,
      '--timeout',
      '60000',
      '--',
      '--session',
      sessionFile,
    ])
  }

  shelf(): ShelfEvent[] {
    return readShelf(this.agentDir)
  }

  log(): LogEntry[] {
    const file = logFile(this.agentDir)
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as LogEntry)
  }

  settled(label: string): SettledTab | undefined {
    const event = this.shelf().find(entry => entry.type === 'settled' && entry.label === label)
    return event?.type === 'settled' ? event : undefined
  }

  cleanup(): void {
    for (const tabId of this.tabs) {
      if (tabExists(tabId)) herdr(['tab', 'close', tabId])
    }
    rmSync(this.root, { recursive: true, force: true })
  }
}

test(
  'settles a tab idle for more than seven days and reopens it from the shelf view',
  { skip, timeout: 180_000 },
  async () => {
    const fixture = new Fixture()
    const label = `settle-idle-${process.pid}`
    try {
      const file = fixture.session('idle', Date.now() - 8 * DAY_MS)
      const { tabId, paneId } = fixture.tab(label)
      fixture.startPi(paneId, file)

      await waitFor('the idle tab to close', 60_000, () => !tabExists(tabId))
      const settled = fixture.settled(label)
      assert.equal(settled?.reason, 'inactive')
      assert.deepEqual(
        settled?.sessions.map(session => session.file),
        [file],
      )
      const check = fixture.log().find(entry => entry.op === 'check' && entry.tabId === tabId)
      assert.equal(check?.outcome, 'settled')
      assert.equal(check?.reason, 'inactive')
      assert.equal(check?.shelfId, settled?.id)
      assert.equal(check?.session, file)
      assert.ok(
        check?.commands.some(command => command.argv.join(' ').includes(`tab get ${tabId}`)),
        'the check did not record its herdr commands',
      )

      const shelf = fixture.tab(`settle-shelf-${process.pid}`)
      herdr([
        'pane',
        'run',
        shelf.paneId,
        `node "${path.join(import.meta.dirname, 'herdr', 'shelf-view.ts')}"`,
      ])
      herdr(['pane', 'wait-output', shelf.paneId, '--match', label, '--timeout', '20000'])
      herdr(['pane', 'send-keys', shelf.paneId, 'Enter'])

      const reopened = await waitFor('the reopened pi', 90_000, () =>
        panes().find(pane => pane.agent === 'pi' && pane.agent_session?.value === file),
      )
      fixture.tabs.push(reopened.tab_id)
      if (process.env.HERDR_TAB_ID) herdr(['tab', 'focus', process.env.HERDR_TAB_ID])
      await waitFor('the reopened event', 30_000, () =>
        fixture.shelf().some(event => event.type === 'reopened' && event.id === settled?.id),
      )
      const reopenLog = await waitFor('the reopen log entry', 10_000, () =>
        fixture.log().find(entry => entry.op === 'reopen' && entry.shelfId === settled?.id),
      )
      assert.equal(reopenLog.outcome, 'reopened')

      await new Promise(resolve => setTimeout(resolve, 35_000))
      assert.ok(tabExists(reopened.tab_id), 'the reopened tab was settled again')
      assert.equal(fixture.shelf().filter(event => event.type === 'settled').length, 1)
    } finally {
      fixture.cleanup()
    }
  },
)

test(
  'reopens a tab into a recreated workspace after settling closed its workspace',
  { skip, timeout: 180_000 },
  async () => {
    const fixture = new Fixture()
    const workspaceLabel = `settle-ws-${process.pid}`
    try {
      const file = fixture.session('workspace', Date.now() - 8 * DAY_MS)
      const original = fixture.workspace(workspaceLabel)
      herdr(['tab', 'rename', original.tabId, `settle-ws-tab-${process.pid}`])
      fixture.startPi(original.paneId, file)

      await waitFor('the only tab to close', 60_000, () => !tabExists(original.tabId))
      const workspaces = () =>
        herdr<{ workspaces: Array<{ workspace_id: string; label: string }> }>(['workspace', 'list'])
          .workspaces
      assert.equal(
        workspaces().some(workspace => workspace.label === workspaceLabel),
        false,
        'the workspace stayed open',
      )
      assert.equal(fixture.settled(`settle-ws-tab-${process.pid}`)?.workspaceLabel, workspaceLabel)

      const shelf = fixture.tab(`settle-ws-shelf-${process.pid}`)
      herdr([
        'pane',
        'run',
        shelf.paneId,
        `node "${path.join(import.meta.dirname, 'herdr', 'shelf-view.ts')}"`,
      ])
      herdr([
        'pane',
        'wait-output',
        shelf.paneId,
        '--match',
        `settle-ws-tab-${process.pid}`,
        '--timeout',
        '20000',
      ])
      herdr(['pane', 'send-keys', shelf.paneId, 'Enter'])

      const recreated = await waitFor('the recreated workspace', 60_000, () =>
        workspaces().find(workspace => workspace.label === workspaceLabel),
      )
      const reopened = await waitFor('the reopened pi', 60_000, () =>
        herdr<{ panes: Pane[] }>([
          'pane',
          'list',
          '--workspace',
          recreated.workspace_id,
        ]).panes.find(pane => pane.agent === 'pi' && pane.agent_session?.value === file),
      )
      fixture.tabs.push(reopened.tab_id)
      if (process.env.HERDR_TAB_ID) herdr(['tab', 'focus', process.env.HERDR_TAB_ID])
      const tabs = herdr<{ tabs: Array<{ label: string }> }>([
        'tab',
        'list',
        '--workspace',
        recreated.workspace_id,
      ]).tabs
      assert.deepEqual(
        tabs.map(tab => tab.label),
        [`settle-ws-tab-${process.pid}`],
      )
    } finally {
      fixture.cleanup()
    }
  },
)

test(
  'keeps an idle tab open while another pane runs a command',
  { skip, timeout: 120_000 },
  async () => {
    const fixture = new Fixture()
    try {
      const file = fixture.session('busy', Date.now() - 8 * DAY_MS)
      const { tabId, paneId } = fixture.tab(`settle-busy-${process.pid}`)
      const split = herdr<{ pane: { pane_id: string } }>([
        'pane',
        'split',
        paneId,
        '--direction',
        'right',
        '--cwd',
        fixture.project,
        '--no-focus',
      ])
      herdr(['pane', 'run', split.pane.pane_id, `node -e "setTimeout(() => {}, 600000)"`])
      fixture.startPi(paneId, file)

      const skipped = await waitFor('a skipped check', 60_000, () =>
        fixture.shelf().find(event => event.type === 'skipped' && event.tabId === tabId),
      )
      assert.equal(skipped.type === 'skipped' && skipped.reason, 'inactive')
      assert.match(
        skipped.type === 'skipped' ? skipped.blockers.join('\n') : '',
        new RegExp(`is running in ${split.pane.pane_id}`),
      )
      const check = await waitFor('the skipped check log entry', 10_000, () =>
        fixture.log().find(entry => entry.op === 'check' && entry.tabId === tabId),
      )
      assert.equal(check.outcome, 'skipped')
      assert.match(
        check.blockers?.join('\n') ?? '',
        new RegExp(`is running in ${split.pane.pane_id}`),
      )
      const processInfo = check.commands.find(command =>
        command.argv.join(' ').includes(`process-info --pane ${split.pane.pane_id}`),
      )
      assert.equal(processInfo?.code, 0)
      assert.ok(processInfo.t >= 0 && processInfo.ms >= 0)
      assert.ok(tabExists(tabId))
      assert.equal(
        fixture.shelf().some(event => event.type === 'settled'),
        false,
      )
    } finally {
      fixture.cleanup()
    }
  },
)

test(
  'settles the tab a pi pane was moved into, not its launch tab',
  { skip, timeout: 120_000 },
  async () => {
    const fixture = new Fixture()
    try {
      const file = fixture.session('moved', Date.now() - 8 * DAY_MS)
      const launch = fixture.tab(`settle-launch-${process.pid}`)
      herdr([
        'pane',
        'split',
        launch.paneId,
        '--direction',
        'right',
        '--cwd',
        fixture.project,
        '--no-focus',
      ])
      fixture.startPi(launch.paneId, file)
      const moved = herdr<{ move_result: { pane: { tab_id: string } } }>([
        'pane',
        'move',
        launch.paneId,
        '--new-tab',
        '--label',
        `settle-moved-${process.pid}`,
        '--no-focus',
      ])
      const movedTabId = moved.move_result.pane.tab_id
      fixture.tabs.push(movedTabId)

      await waitFor('the moved tab to close', 60_000, () => !tabExists(movedTabId))
      assert.ok(tabExists(launch.tabId), 'the launch tab was closed')
      const settled = fixture.settled(`settle-moved-${process.pid}`)
      assert.equal(settled?.tabId, movedTabId)
      assert.deepEqual(
        settled?.sessions.map(session => session.file),
        [file],
      )
    } finally {
      fixture.cleanup()
    }
  },
)

test(
  'closes subagent panes idle for 14 hours and keeps fresh ones',
  { skip, timeout: 120_000 },
  async () => {
    const fixture = new Fixture()
    try {
      const subagents = fixture.tab(`settle-subagents-${process.pid}`, ['PI_SIMPLE_SUBAGENT=1'])
      const fresh = herdr<{ pane: { pane_id: string } }>([
        'pane',
        'split',
        subagents.paneId,
        '--direction',
        'right',
        '--cwd',
        fixture.project,
        '--no-focus',
        '--env',
        `PI_CODING_AGENT_DIR=${fixture.agentDir}`,
        '--env',
        'PI_SIMPLE_SUBAGENT=1',
      ]).pane.pane_id
      const oldFile = fixture.session('subagent-old', Date.now() - 60_000)
      const freshFile = fixture.session('subagent-fresh', Date.now() - 60_000)
      for (const [pane, file, name] of [
        [subagents.paneId, oldFile, 'old'],
        [fresh, freshFile, 'fresh'],
      ] as const) {
        fixture.startPi(pane, file)
        herdr([
          'pane',
          'report-metadata',
          pane,
          '--source',
          'herdr-settle-test',
          '--token',
          `simple_subagent=${name}`,
        ])
        await waitFor('the subagent session to be reported', 30_000, () =>
          panes().some(entry => entry.pane_id === pane && entry.agent_session?.value === file),
        )
      }
      const stale = new Date(Date.now() - 15 * 60 * 60 * 1000)
      utimesSync(oldFile, stale, stale)

      const sweeper = fixture.tab(`settle-sweeper-${process.pid}`)
      fixture.startPi(sweeper.paneId, fixture.session('sweeper', Date.now() - 60_000))

      await waitFor('the idle subagent pane to close', 60_000, () =>
        panes().every(entry => entry.pane_id !== subagents.paneId),
      )
      assert.ok(
        panes().some(entry => entry.pane_id === fresh),
        'the fresh subagent pane was closed',
      )
      assert.ok(tabExists(sweeper.tabId))
    } finally {
      fixture.cleanup()
    }
  },
)

test('settles a tab from the Herdr tab action', { skip, timeout: 120_000 }, async () => {
  const fixture = new Fixture()
  const label = `settle-action-${process.pid}`
  try {
    const file = fixture.session('action', Date.now() - 60_000)
    const { tabId, paneId } = fixture.tab(label)
    fixture.startPi(paneId, file)
    await waitFor('the pi session to be reported', 30_000, () =>
      panes().some(pane => pane.pane_id === paneId && pane.agent_session?.value === file),
    )

    execFileSync(process.execPath, [path.join(import.meta.dirname, 'herdr', 'settle-tab.ts')], {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: fixture.agentDir,
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ tab_id: tabId }),
      },
    })

    assert.equal(tabExists(tabId), false)
    const settled = fixture.settled(label)
    assert.equal(settled?.reason, 'manual')
    assert.deepEqual(
      settled?.sessions.map(session => session.file),
      [file],
    )
    const action = fixture.log().filter(entry => entry.op === 'settle-action')
    assert.equal(action.length, 1)
    assert.equal(action[0].outcome, 'settled')
    assert.equal(action[0].shelfId, settled?.id)
  } finally {
    fixture.cleanup()
  }
})

function socketRequest(method: string, params: object): Promise<{ error?: { message?: string } }> {
  const socketPath = process.env.HERDR_SOCKET_PATH!
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${socketPath}` : socketPath
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () =>
      socket.write(`${JSON.stringify({ id: 'settle-test', method, params })}\n`),
    )
    socket.on('data', chunk => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      socket.end()
      resolve(JSON.parse(buffer.slice(0, newline)))
    })
    socket.on('error', reject)
  })
}

const pluginLinked = (() => {
  if (skip) return false
  const listed = spawnSync(
    herdrCommand,
    ['plugin', 'list', '--plugin', 'local.herdr-settle', '--json'],
    {
      encoding: 'utf8',
    },
  )
  return listed.status === 0 && /"enabled"\s*:\s*true/.test(listed.stdout)
})()

test(
  'settles a tab when Herdr invokes the Settle tab plugin action',
  {
    skip: skip || (!pluginLinked && 'requires the linked local.herdr-settle plugin'),
    timeout: 120_000,
  },
  async () => {
    const fixture = new Fixture()
    const label = `settle-plugin-${process.pid}`
    const serverShelf = defaultAgentDir()
    try {
      const file = fixture.session('plugin', Date.now() - 60_000)
      const { tabId, paneId } = fixture.tab(label)
      fixture.startPi(paneId, file)
      await waitFor('the pi session to be reported', 30_000, () =>
        panes().some(pane => pane.pane_id === paneId && pane.agent_session?.value === file),
      )

      const response = await socketRequest('plugin.action.invoke', {
        action_id: 'local.herdr-settle.settle',
        context: { tab_id: tabId, workspace_id: workspaceId, invocation_source: 'context_menu' },
      })
      assert.equal(response.error, undefined, response.error?.message)

      await waitFor('the plugin action to close the tab', 30_000, () => !tabExists(tabId))
      const settled = await waitFor('the settled record', 10_000, () =>
        readShelf(serverShelf).find(
          (event): event is Extract<ShelfEvent, { type: 'settled' }> =>
            event.type === 'settled' && event.label === label,
        ),
      )
      appendShelf({ type: 'removed', id: settled.id, at: new Date().toISOString() }, serverShelf)
      assert.equal(settled.reason, 'manual')
      assert.deepEqual(
        settled.sessions.map(session => session.file),
        [file],
      )
    } finally {
      fixture.cleanup()
    }
  },
)

const glabInstalled = spawnSync('glab', ['--version'], { stdio: 'ignore' }).status === 0

test(
  'logs the failing glab command when the merge request lookup fails',
  { skip: skip || (!glabInstalled && 'requires glab'), timeout: 120_000 },
  async () => {
    const fixture = new Fixture()
    try {
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: fixture.project, encoding: 'utf8' })
      git('init', '-q')
      git('remote', 'add', 'origin', 'git@gitlab.invalid:group/project.git')
      git('checkout', '-q', '-b', 'feature')
      const file = fixture.session('lookup', Date.now() - 60_000)
      const { tabId, paneId } = fixture.tab(`settle-lookup-${process.pid}`)
      fixture.startPi(paneId, file)

      const check = await waitFor('the check log entry', 60_000, () =>
        fixture.log().find(entry => entry.op === 'check' && entry.session === file),
      )
      assert.equal(check.outcome, 'kept')
      assert.match(check.lookupError ?? '', /gitlab\.invalid/)
      const glab = check.commands.find(command => command.argv[0] === 'glab')
      assert.ok(glab, 'the check did not record the glab command')
      assert.notEqual(glab.code, 0)
      assert.match(glab.output ?? '', /gitlab\.invalid/)
      assert.ok(check.commands.some(command => command.argv[0] === 'git'))
      assert.ok(tabExists(tabId))
    } finally {
      fixture.cleanup()
    }
  },
)

const gitlabRemote = process.env.HERDR_SETTLE_TEST_GITLAB_REMOTE

test(
  'settles a tab whose GitLab merge request merged after the last message',
  {
    skip:
      skip ||
      (!gitlabRemote && 'set HERDR_SETTLE_TEST_GITLAB_REMOTE to a GitLab remote with merged MRs'),
    timeout: 120_000,
  },
  async () => {
    const fixture = new Fixture()
    const label = `settle-mr-${process.pid}`
    try {
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: fixture.project, encoding: 'utf8' })
      git('init', '-q')
      git('remote', 'add', 'origin', gitlabRemote!)
      const merged = JSON.parse(
        execFileSync('glab', ['mr', 'list', '--merged', '-F', 'json', '--per-page', '20'], {
          cwd: fixture.project,
          encoding: 'utf8',
        }),
      ) as Array<{ source_branch: string; merged_at: string; web_url: string }>
      const request = merged.find(
        entry => entry.merged_at && !['main', 'master'].includes(entry.source_branch),
      )
      assert.ok(request, 'no merged merge request to test against')
      git('checkout', '-q', '-b', request.source_branch)

      const file = fixture.session('mr', Date.parse(request.merged_at) - 60 * 60 * 1000)
      const { tabId, paneId } = fixture.tab(label)
      fixture.startPi(paneId, file)

      await waitFor('the merged tab to close', 60_000, () => !tabExists(tabId))
      const settled = fixture.settled(label)
      assert.equal(settled?.reason, 'mr-merged')
      assert.equal(settled?.mr?.url, request.web_url)
    } finally {
      fixture.cleanup()
    }
  },
)
