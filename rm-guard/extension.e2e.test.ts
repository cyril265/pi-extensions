import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { after, before, test } from 'node:test'

type Event = Record<string, unknown>
type AssistantMessage = {
  role?: string
  content?: Array<{ type: string; name?: string; arguments?: { command?: string } }>
}
type ToolResult = { details?: { yielded?: boolean } }
type BashResponse = { data?: { exitCode?: number } }

const model = 'openai-codex/gpt-5.6-luna:minimal'
const packageDir = import.meta.dirname
const cli = join(packageDir, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js')
const backgroundTerminals = join(packageDir, 'node_modules/@tian.zuo/pi-background-terminals')
let base: string
let root: string
let outside: string
let scratch: string

before(() => {
  mkdirSync(join(packageDir, '.tmp'), { recursive: true })
  base = realpathSync(mkdtempSync(join(packageDir, '.tmp', 'e2e-')))
  root = join(base, 'root')
  outside = join(base, 'outside')
  scratch = join(base, 'tmp')
  for (const dir of [root, outside, scratch]) mkdirSync(dir)
})

after(() => {
  rmSync(base, { recursive: true, force: true })
})

function piEnvironment() {
  const env = { ...process.env }
  env.TMPDIR = scratch
  env.TMP = scratch
  env.TEMP = scratch
  for (const key of ['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_RM_ALLOW', 'PI_RM_ASK_DIR'])
    delete env[key]
  env.PATH = (env.PATH ?? '')
    .split(delimiter)
    .filter(entry => entry !== join(packageDir, 'bin'))
    .join(delimiter)
  return env
}

function startPi(extensions: string[], answer: (request: Event, events: Event[]) => boolean) {
  const child = spawn(
    process.execPath,
    [
      cli,
      '--mode',
      'rpc',
      '--no-session',
      '-ne',
      '-ns',
      '-nc',
      '-np',
      '--model',
      model,
      '--tools',
      'bash',
      ...extensions.flatMap(extension => ['-e', extension]),
    ],
    { cwd: root, env: piEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const events: Event[] = []
  const asked: string[] = []
  let stderr = ''
  const send = (record: Event) => child.stdin.write(`${JSON.stringify(record)}\n`)
  createInterface({ input: child.stdout }).on('line', line => {
    let event: Event
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    events.push(event)
    if (event.type === 'extension_ui_request' && event.method === 'confirm') {
      asked.push(String(event.message))
      send({ type: 'extension_ui_response', id: event.id, confirmed: answer(event, events) })
    }
  })
  child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk))
  const exited = new Promise<void>(resolve => child.on('exit', () => resolve()))

  return {
    events,
    asked,
    send,
    async until(condition: () => boolean, what: string, timeoutMs = 150_000) {
      const started = Date.now()
      while (!condition()) {
        if (child.exitCode !== null)
          throw new Error(`pi exited while waiting for ${what}. stderr: ${stderr}`)
        if (Date.now() - started > timeoutMs)
          throw new Error(`timed out waiting for ${what}. stderr: ${stderr}`)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    },
    async close() {
      child.stdin.end()
      child.kill()
      await exited
    },
  }
}

function bashCommands(events: Event[]): string[] {
  return events.flatMap(event => {
    const message = event.message as AssistantMessage | undefined
    if (event.type !== 'message_end' || message?.role !== 'assistant') return []
    return (message.content ?? [])
      .filter(block => block.type === 'toolCall' && block.name === 'bash')
      .map(block => String(block.arguments?.command))
  })
}

const bashTools = [
  { name: 'built-in bash', extensions: () => [packageDir] },
  { name: 'pi-background-terminals', extensions: () => [packageDir, backgroundTerminals] },
]

for (const { name, extensions } of bashTools) {
  test(`${name}: the shell runs the model's command unchanged and rm of a directory outside the project still asks`, {
    timeout: 180_000,
  }, async () => {
    const target = join(outside, `${name}-dir`)
    mkdirSync(target)
    const pi = startPi(extensions(), () => false)
    try {
      pi.send({
        type: 'prompt',
        message: [
          'Use the bash tool once to run this exact command, unchanged:',
          `printf '%s' "$BASH_EXECUTION_STRING" > executed.txt; rm -rf '../outside/${name}-dir'; echo "rm exit $?"`,
          'Then reply with the single word done.',
        ].join('\n'),
      })
      await pi.until(
        () => pi.events.some(event => event.type === 'agent_end'),
        'the agent to finish',
      )
    } finally {
      await pi.close()
    }
    const commands = bashCommands(pi.events)
    assert.equal(commands.length, 1, `expected one bash call, got: ${commands.join('\n---\n')}`)
    assert.equal(readFileSync(join(root, 'executed.txt'), 'utf8'), commands[0])
    assert.deepEqual(pi.asked, [target])
    assert.equal(existsSync(target), true)
  })
}

test('pi-background-terminals: rm in a command that went to the background asks after the tool call returned', {
  timeout: 180_000,
}, async () => {
  const target = join(outside, 'background-dir')
  mkdirSync(target)
  let askedAfterToolReturned: boolean | undefined
  const pi = startPi([packageDir, backgroundTerminals], (_request, events) => {
    askedAfterToolReturned = events.some(event => event.type === 'tool_execution_end')
    return true
  })
  try {
    pi.send({
      type: 'prompt',
      message: [
        'Call the bash tool once with yield_time_ms set to 1000 and this exact command, unchanged:',
        `sleep 12; rm -rf ../outside/background-dir; echo "rm exit $?" > rm-exit.txt`,
        'Do not wait for it. Reply with the single word done.',
      ].join('\n'),
    })
    await pi.until(() => existsSync(join(root, 'rm-exit.txt')), 'the background rm')
  } finally {
    await pi.close()
  }
  const returned = pi.events.find(event => event.type === 'tool_execution_end')?.result as
    | ToolResult
    | undefined
  assert.equal(returned?.details?.yielded, true, JSON.stringify(returned))
  assert.deepEqual(pi.asked, [target])
  assert.equal(askedAfterToolReturned, true)
  assert.equal(readFileSync(join(root, 'rm-exit.txt'), 'utf8'), 'rm exit 0\n')
  assert.equal(existsSync(target), false)
})

test('commands the user runs with ! are not guarded', { timeout: 60_000 }, async () => {
  const target = join(outside, 'user-dir')
  mkdirSync(target)
  const pi = startPi([packageDir], () => false)
  try {
    pi.send({ id: 'user-bash', type: 'bash', command: 'rm -rf ../outside/user-dir' })
    await pi.until(
      () => pi.events.some(event => event.type === 'response' && event.id === 'user-bash'),
      'the user bash command',
    )
  } finally {
    await pi.close()
  }
  const response = pi.events.find(event => event.type === 'response' && event.id === 'user-bash') as
    | BashResponse
    | undefined
  assert.equal(response?.data?.exitCode, 0, JSON.stringify(response))
  assert.deepEqual(pi.asked, [])
  assert.equal(existsSync(target), false)
})
