import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { type LogEntry, logFile } from './settle.ts'

const settleUrl = pathToFileURL(path.join(import.meta.dirname, 'settle.ts')).href

function node(
  script: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
      stdio: 'ignore',
      windowsHide: true,
      env,
    })
    child.on('error', reject)
    child.on('exit', resolve)
  })
}

function lines(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line))
}

test('keeps the rotated history and every entry when 60 processes rotate the log at once', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'herdr-settle-log-'))
  try {
    const file = logFile(dir)
    const old = path.join(path.dirname(file), 'log.old.jsonl')
    mkdirSync(path.dirname(file), { recursive: true })
    const seed = `${JSON.stringify({ seed: true, pad: 'x'.repeat(1000) })}\n`
    const seeded = Math.ceil((10 * 1024 * 1024) / seed.length)
    writeFileSync(file, seed.repeat(seeded))

    const startAt = Date.now() + 2000
    const script = `
      const { logged } = await import(${JSON.stringify(settleUrl)})
      while (Date.now() < ${startAt}) await new Promise(resolve => setTimeout(resolve, 1))
      await logged({ op: 'check', session: process.argv[1] }, async () => {}, ${JSON.stringify(dir)})
    `
    const writers = Array.from({ length: 60 }, (_, index) => `writer-${index}`)
    const codes = await Promise.all(writers.map(writer => node(script, [writer])))
    assert.deepEqual(new Set(codes), new Set([0]))

    const entries = [...lines(old), ...lines(file)]
    assert.equal(entries.filter(entry => entry.seed).length, seeded)
    assert.deepEqual(
      entries
        .filter(entry => entry.op === 'check')
        .map(entry => entry.session)
        .sort(),
      writers.sort(),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('logs an operation cut short by process.exit, redacting URL credentials and clipping output', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'herdr-settle-log-'))
  try {
    const remote = 'https://oauth2:glpat-secret-token@gitlab.example.com/group/project.git'
    const failing = 'console.error(process.argv[1] + " " + "x".repeat(12000)); process.exit(3)'
    const script = `
      const { logged, run } = await import(${JSON.stringify(settleUrl)})
      await logged({ op: 'reopen', tabId: 'w1:t1' }, async () => {
        await run(process.execPath, ['-e', ${JSON.stringify(failing)}, ${JSON.stringify(remote)}])
        setTimeout(() => process.exit(130), 20)
        await new Promise(() => {})
      }, ${JSON.stringify(dir)})
    `
    assert.equal(await node(script), 130)

    const file = logFile(dir)
    assert.equal(readFileSync(file, 'utf8').includes('glpat-secret-token'), false)
    const entries = lines(file) as unknown as LogEntry[]
    assert.equal(entries.length, 1)
    const [entry] = entries
    assert.equal(entry.op, 'reopen')
    assert.equal(entry.outcome, 'interrupted')
    const [command] = entry.commands
    assert.equal(command.code, 3)
    assert.equal(command.argv.at(-1), 'https://***@gitlab.example.com/group/project.git')
    assert.match(
      command.output ?? '',
      /^https:\/\/\*\*\*@gitlab\.example\.com\S* x+…\[\+\d+ chars\]$/,
    )
    assert.ok((command.output ?? '').length < 2100)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const glabInstalled = spawnSync('glab', ['--version'], { stdio: 'ignore' }).status === 0

test(
  'runs one glab at a time when 12 processes look up merge requests at once',
  { skip: !glabInstalled && 'requires glab', timeout: 120_000 },
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'herdr-settle-glab-'))
    try {
      const project = path.join(dir, 'project')
      mkdirSync(project)
      const git = (...args: string[]) => execFileSync('git', args, { cwd: project })
      git('init', '-q')
      git('remote', 'add', 'origin', 'git@gitlab.invalid:group/project.git')
      git('checkout', '-q', '-b', 'feature')
      const glabConfig = path.join(dir, 'glab-config')
      mkdirSync(glabConfig)

      const startAt = Date.now() + 2000
      const script = `
        const { branchMergeRequest, logged } = await import(${JSON.stringify(settleUrl)})
        while (Date.now() < ${startAt}) await new Promise(resolve => setTimeout(resolve, 1))
        await logged({ op: 'check', session: process.argv[1] }, async entry => {
          await branchMergeRequest(${JSON.stringify(project)}).catch(error => {
            entry.lookupError = error.message
          })
        }, ${JSON.stringify(dir)})
      `
      const env = { ...process.env }
      env.GLAB_CONFIG_DIR = glabConfig
      const checks = Array.from({ length: 12 }, (_, index) => `check-${index}`)
      const codes = await Promise.all(checks.map(check => node(script, [check], env)))
      assert.deepEqual(new Set(codes), new Set([0]))

      const entries = lines(logFile(dir)) as unknown as LogEntry[]
      assert.deepEqual(entries.map(entry => entry.session).sort(), checks.sort())
      const calls = entries.flatMap(entry => {
        assert.match(entry.lookupError ?? '', /gitlab\.invalid/)
        return entry.commands
          .filter(command => command.argv[0] === 'glab')
          .map(command => {
            const start = Date.parse(entry.at) + command.t
            return { start, end: start + command.ms }
          })
      })
      assert.equal(calls.length, checks.length)
      calls.sort((a, b) => a.start - b.start)
      for (let index = 1; index < calls.length; index++) {
        assert.ok(
          calls[index].start >= calls[index - 1].end,
          `glab call ${index} started ${calls[index - 1].end - calls[index].start} ms before the previous one ended`,
        )
      }
      assert.equal(existsSync(path.join(dir, 'herdr-settle', 'glab.lock')), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
