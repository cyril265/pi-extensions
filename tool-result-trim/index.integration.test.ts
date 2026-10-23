import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { after, before, test } from 'node:test'

type ToolRun = {
  toolName: string
  args: Record<string, unknown>
  text: string
  details: Record<string, unknown> | undefined
}

type PiLauncher = {
  name: string
  command: string
  args: string[]
}

const isWindows = process.platform === 'win32'
const model = 'openai-codex/gpt-5.6-luna:minimal'
const extensionPath = import.meta.dirname
let cwd: string

before(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'tool-result-trim-'))
  await writeFile(
    join(cwd, 'print-log.mjs'),
    [
      'const count = Number(process.argv[2])',
      "const body = 'compiled module '.repeat(15)",
      'for (let step = 1; step <= count; step++) {',
      "  console.log('build step ' + step + ': ' + body + 'ok')",
      '}',
      'if (count > 100) {',
      "  console.log('operation completed successfully')",
      "  console.log('operation completed successfully')",
      "  console.log('operation completed successfully ERROR disk full')",
      "  console.log('operation completed successfully ERROR disk full')",
      '}',
    ].join('\n'),
  )
  await mkdir(join(cwd, 'reports'))
  for (let index = 1; index <= 300; index += 1) {
    const name = `quarterly-${String(index).padStart(4, '0')}-${'x'.repeat(index % 7)}-final.txt`
    await writeFile(join(cwd, 'reports', name), '')
  }
})

after(async () => {
  await rm(cwd, { recursive: true, force: true })
})

function findOnPath(names: string[]): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of names) {
      const candidate = join(directory, name)
      if (directory && existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function piLaunchers(): PiLauncher[] {
  const pi = findOnPath(isWindows ? ['pi.cmd', 'pi.exe'] : ['pi'])
  assert.ok(pi, 'pi is not on PATH')
  const cli = pi.endsWith('.cmd')
    ? join(
        dirname(pi),
        'node_modules',
        '@earendil-works',
        'pi-coding-agent',
        'dist',
        'bundle',
        'cli.js',
      )
    : realpathSync(pi)
  if (!cli.endsWith('.js')) return [{ name: 'pi', command: pi, args: [] }]

  const launchers = [{ name: 'node', command: process.execPath, args: [cli] }]
  const bun = findOnPath(isWindows ? ['bun.exe'] : ['bun'])
  if (bun) launchers.push({ name: 'bun', command: bun, args: [cli] })
  return launchers
}

async function runPrompt(launcher: PiLauncher, tools: string, message: string): Promise<ToolRun[]> {
  const child = spawn(
    launcher.command,
    [
      ...launcher.args,
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
      tools,
      '-e',
      extensionPath,
    ],
    { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const events: Array<Record<string, unknown>> = []
  let stderr = ''
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      events.push(JSON.parse(line))
    } catch {}
  })
  child.stderr.on('data', chunk => {
    stderr += chunk
  })
  const exited = new Promise<void>(resolve => child.on('exit', () => resolve()))

  try {
    child.stdin.write(`${JSON.stringify({ id: 'prompt', type: 'prompt', message })}\n`)
    const started = Date.now()
    while (!events.some(event => event.type === 'agent_end')) {
      if (Date.now() - started > 150_000) throw new Error(`pi did not finish. stderr: ${stderr}`)
      if (child.exitCode !== null) throw new Error(`pi exited early. stderr: ${stderr}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  } finally {
    child.stdin.end()
    child.kill()
    await exited
  }

  const argsById = new Map<string, Record<string, unknown>>()
  for (const event of events) {
    if (event.type === 'tool_execution_start') {
      argsById.set(String(event.toolCallId), event.args as Record<string, unknown>)
    }
  }

  return events.flatMap(event => {
    const message = event.message as Record<string, unknown> | undefined
    if (event.type !== 'message_end' || message?.role !== 'toolResult') return []
    const content = message.content as Array<{ type: string; text?: string }>
    return [
      {
        toolName: String(message.toolName),
        args: argsById.get(String(message.toolCallId)) ?? {},
        text: content.map(block => block.text ?? '').join('\n'),
        details: message.details as Record<string, unknown> | undefined,
      },
    ]
  })
}

function headerPath(text: string, label: 'Full output' | 'Full text'): string {
  const path = text.split('\n')[0]?.match(new RegExp(`${label}: (.+?)\\]$`))?.[1]
  assert.ok(path, `missing "${label}" path in header: ${text.slice(0, 200)}`)
  return path
}

for (const launcher of piLaunchers()) {
  test(
    `${launcher.name}: bash short output passes through, long output is trimmed with the full output on disk`,
    {
      timeout: 180_000,
    },
    async () => {
      const runs = await runPrompt(
        launcher,
        'bash',
        [
          'Use the bash tool to run these two commands, one tool call each, exactly as written:',
          'node print-log.mjs 3',
          'node print-log.mjs 3000',
          'Then reply with the single word done.',
        ].join('\n'),
      )

      const short = runs.find(
        run =>
          String(run.args.command).includes('print-log.mjs 3') &&
          !String(run.args.command).includes('3000'),
      )
      const long = runs.find(run => String(run.args.command).includes('print-log.mjs 3000'))
      assert.ok(
        short && long,
        `expected both bash runs, got: ${runs.map(run => run.args.command).join(', ')}`,
      )

      assert.doesNotMatch(short.text, /\[Trimmed:/)
      assert.match(short.text, /build step 3: compiled module/)

      assert.match(
        long.text,
        /^\[Trimmed: \d+ repetitive lines collapsed, long lines shortened with \[\.\.\.\]\. Full output: /,
      )
      assert.match(long.text, /\[× \d+ similar: build step \*: compiled module/)
      assert.match(long.text, /operation completed successfully ERROR disk full/)
      assert.ok(long.text.length < 8000, `trimmed bash result is ${long.text.length} chars`)

      const fullPath = headerPath(long.text, 'Full output')
      assert.equal(long.details?.fullOutputPath, fullPath)
      const full = await readFile(fullPath, 'utf-8')
      assert.match(full, /build step 1500: compiled module/)
      assert.match(full, /build step 3000: compiled module/)
    },
  )

  test(
    `${launcher.name}: long find output is trimmed and the untrimmed text is saved`,
    {
      timeout: 180_000,
    },
    async () => {
      const runs = await runPrompt(
        launcher,
        'find',
        'Use the find tool once with pattern "*.txt" and path "reports". Then reply with the single word done.',
      )

      const find = runs.find(run => run.toolName === 'find')
      assert.ok(find, `expected a find result, got: ${runs.map(run => run.toolName).join(', ')}`)
      assert.match(find.text, /^\[Tool result trimmed: .*\. Full text: /)
      assert.ok(find.text.length < 9000, `trimmed find result is ${find.text.length} chars`)

      const full = await readFile(headerPath(find.text, 'Full text'), 'utf-8')
      for (const index of ['0001', '0150', '0300']) {
        assert.match(full, new RegExp(`quarterly-${index}-x*-final\\.txt`))
      }
    },
  )
}
