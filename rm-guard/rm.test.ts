import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { guardPrefix, serveAskDir } from './index.ts'

let base: string
let root: string
let outside: string
let scratch: string

function has(...parts: string[]): boolean {
  return existsSync(join(base, ...parts))
}

function run(command: string, cwd = root, allowed = [root, scratch]) {
  const env = { ...process.env, HOME: outside }
  delete env.UNSET_DIR
  const result = spawnSync('/bin/bash', ['-c', `${guardPrefix(allowed)}\n${command}`], {
    cwd,
    env,
    encoding: 'utf8',
  })
  return { status: result.status, stderr: result.stderr, stdout: result.stdout }
}

function expectBlocked(command: string, cwd = root) {
  const result = run(command, cwd)
  assert.equal(result.status, 3, result.stderr)
  assert.match(result.stderr, /pi-rm: blocked deletion outside the allowed directories/)
  assert.match(result.stderr, /No files were deleted/)
  return result
}

function spawnGuarded(command: string, askDir = '') {
  const child = spawn('/bin/bash', ['-c', `${guardPrefix([root, scratch], askDir)}\n${command}`], {
    cwd: root,
    env: { ...process.env, HOME: outside },
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk))
  return new Promise<{ status: number | null; stderr: string }>(resolve =>
    child.on('close', status => resolve({ status, stderr })),
  )
}

async function runAsking(command: string, confirm: (paths: string[]) => Promise<boolean>) {
  const askDir = mkdtempSync(join(base, 'ask-'))
  const stop = serveAskDir(askDir, confirm)
  const result = await spawnGuarded(command, askDir)
  stop()
  assert.equal(existsSync(askDir), false)
  return result
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'rm-guard-test-')))
  root = join(base, 'root')
  outside = join(base, 'outside')
  scratch = join(base, 'scratch')
  for (const dir of ['root/dir', 'root/sub', 'outside/target', 'scratch']) {
    mkdirSync(join(base, dir), { recursive: true })
  }
  for (const file of [
    'root/file',
    'root/dir/child',
    'root/sub/child',
    'root/-dash',
    'root/space file',
    'root/line\nbreak',
    'outside/file',
    'outside/target/child',
  ]) {
    writeFileSync(join(base, file), 'x')
  }
  symlinkSync(join(root, 'dir'), join(root, 'link-in'))
  symlinkSync(join(outside, 'target'), join(root, 'link-out'))
  symlinkSync(join(root, 'nowhere'), join(root, 'dangling'))
  writeFileSync(join(root, 'clean-in.sh'), 'rm -f file\n')
  writeFileSync(join(root, 'clean-out.sh'), 'rm -f ../outside/file\n')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('allowed deletions inside the project', () => {
  it('deletes a file and a directory', () => {
    assert.equal(run('rm -f file && rm -rf dir').status, 0)
    assert.equal(has('root/file'), false)
    assert.equal(has('root/dir'), false)
  })

  it('deletes a directory with a trailing slash', () => {
    assert.equal(run('rm -rf dir/').status, 0)
    assert.equal(has('root/dir'), false)
  })

  it('removes a symlink without touching its target, inside or outside', () => {
    assert.equal(run('rm link-in link-out').status, 0)
    assert.equal(has('root/link-in'), false)
    assert.equal(has('root/link-out'), false)
    assert.equal(has('root/dir/child'), true)
    assert.equal(has('outside/target/child'), true)
  })

  it('removes a dangling symlink', () => {
    assert.equal(run('rm -f dangling').status, 0)
    assert.equal(existsSync(join(root, 'dangling')), false)
    assert.equal(run('ls dangling').status, 1)
  })

  it('handles relative paths after cd inside the project', () => {
    assert.equal(run('cd sub && rm -f child').status, 0)
    assert.equal(has('root/sub/child'), false)
  })

  it('handles --, names with spaces and newlines, and missing files with -f', () => {
    assert.equal(run(`rm -f -- -dash 'space file' $'line\\nbreak' missing`).status, 0)
    assert.equal(has('root/-dash'), false)
    assert.equal(has('root/space file'), false)
    assert.equal(has('root/line\nbreak'), false)
  })

  it('allows cleanup under the user temp dir and /tmp with the production roots', () => {
    const allowed = [root, tmpdir(), '/tmp']
    const result = run('T=$(mktemp -d) && touch "$T/f" && rm -rf "$T" && echo "$T"', root, allowed)
    assert.equal(result.status, 0, result.stderr)
    assert.notEqual(result.stdout.trim(), '')
    assert.equal(existsSync(result.stdout.trim()), false)
    const inTmp = mkdtempSync('/tmp/rm-guard-test-')
    assert.equal(run(`rm -rf '${inTmp}'`, root, allowed).status, 0)
    assert.equal(existsSync(inTmp), false)
  })

  it('works through a script, command, xargs and sh -c', () => {
    assert.equal(run('bash clean-in.sh').status, 0)
    assert.equal(has('root/file'), false)
    assert.equal(run('command rm -f -- -dash').status, 0)
    assert.equal(has('root/-dash'), false)
    assert.equal(run("printf 'sub/child' | xargs rm -f").status, 0)
    assert.equal(has('root/sub/child'), false)
    assert.equal(run("sh -c 'rm -rf dir'").status, 0)
    assert.equal(has('root/dir'), false)
  })
})

describe('blocked deletions outside the project', () => {
  it('refuses an explicit outside path', () => {
    expectBlocked('rm -f ../outside/file')
    assert.equal(has('outside/file'), true)
  })

  it('refuses to follow a symlink out via trailing slash or glob', () => {
    expectBlocked('rm -rf link-out/')
    expectBlocked('rm -rf link-out/*')
    assert.equal(has('outside/target/child'), true)
  })

  it('refuses the project root itself', () => {
    expectBlocked('rm -rf .')
    expectBlocked(`rm -rf '${root}'`)
    expectBlocked('rm -rf ..', join(root, 'sub'))
    assert.equal(has('root/file'), true)
  })

  it('refuses the Reddit case: unset variable expanding to a glob of absolute paths', () => {
    expectBlocked(`rm -rf "$UNSET_DIR"'${outside}'/*`)
    assert.equal(has('outside/file'), true)
    assert.equal(has('outside/target/child'), true)
  })

  it('refuses the OpenAI case: rm -rf "$HOME" and bare cd landing in $HOME', () => {
    expectBlocked('rm -rf "$HOME"')
    expectBlocked('cd $UNSET_DIR && rm -rf *')
    assert.equal(has('outside/file'), true)
    assert.equal(has('outside/target/child'), true)
  })

  it('refuses a project root nested inside another allowed root, and its parents', () => {
    const project = join(scratch, 'proj')
    mkdirSync(project)
    writeFileSync(join(project, 'file'), 'x')
    writeFileSync(join(scratch, 'other'), 'x')
    const allowed = [project, scratch]
    assert.equal(run('rm -f file', project, allowed).status, 0)
    assert.equal(run('rm -f ../other', project, allowed).status, 0)
    assert.equal(run('rm -rf .', project, allowed).status, 3)
    assert.equal(run('rm -rf ..', project, allowed).status, 3)
    assert.equal(run(`rm -rf '${project}'`, project, allowed).status, 3)
    assert.equal(run(`rm -rf '${scratch}'`, project, allowed).status, 3)
    assert.equal(has('scratch/proj'), true)
  })

  it('validates every operand before deleting any', () => {
    expectBlocked('rm -f file ../outside/file')
    assert.equal(has('root/file'), true)
    assert.equal(has('outside/file'), true)
  })

  it('reaches rm inside a script the text of the command never shows', () => {
    expectBlocked('bash clean-out.sh')
    assert.equal(has('outside/file'), true)
  })

  it('reports operand, resolved path and allowed directories', () => {
    const result = expectBlocked('rm -f ../outside/file')
    assert.match(result.stderr, /operand: \.\.\/outside\/file/)
    assert.match(result.stderr, new RegExp(`resolved path: ${outside}/file`))
    assert.match(result.stderr, new RegExp(`allowed directory: ${root}`))
    assert.match(result.stderr, new RegExp(`allowed directory: ${scratch}`))
    assert.match(result.stderr, /ask the user to run it/)
  })
})

describe('asking the user', () => {
  it('deletes when the user allows and shows only the blocked paths', async () => {
    const asked: string[][] = []
    const result = await runAsking('rm -f file ../outside/file ../outside/target/child', async paths => {
      asked.push(paths)
      return true
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(asked, [[join(outside, 'file'), join(outside, 'target', 'child')]])
    assert.equal(has('root/file'), false)
    assert.equal(has('outside/file'), false)
    assert.equal(has('outside/target/child'), false)
  })

  it('blocks when the user declines', async () => {
    const result = await runAsking('rm -f file ../outside/file', async () => false)
    assert.equal(result.status, 3)
    assert.match(result.stderr, /The user declined this deletion/)
    assert.equal(has('root/file'), true)
    assert.equal(has('outside/file'), true)
  })

  it('does not ask for deletions inside the project', async () => {
    let asked = 0
    const result = await runAsking('rm -f file', async () => {
      asked++
      return false
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(asked, 0)
    assert.equal(has('root/file'), false)
  })

  it('asks once per rm call, also inside a script', async () => {
    let asked = 0
    const result = await runAsking('bash clean-out.sh && rm -f ../outside/target/child', async () => {
      asked++
      return true
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(asked, 2)
    assert.equal(has('outside/file'), false)
    assert.equal(has('outside/target/child'), false)
  })

  it('passes paths with newlines intact', async () => {
    writeFileSync(join(outside, 'line\nbreak'), 'x')
    const asked: string[][] = []
    await runAsking(`rm -f ../outside/$'line\\nbreak'`, async paths => {
      asked.push(paths)
      return false
    })
    assert.deepEqual(asked, [[join(outside, 'line\nbreak')]])
  })

  it('blocks when the ask dir is removed while waiting, and the late answer is dropped', async () => {
    const askDir = mkdtempSync(join(base, 'ask-'))
    let answer!: (allowed: boolean) => void
    const stop = serveAskDir(askDir, () => new Promise(resolve => (answer = resolve)))
    const pending = spawnGuarded('rm -f ../outside/file', askDir)
    while (!answer) await new Promise(resolve => setTimeout(resolve, 20))
    stop()
    const result = await pending
    assert.equal(result.status, 3)
    assert.match(result.stderr, /The user declined this deletion/)
    answer(true)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(has('outside/file'), true)
  })

  it('never asks in a headless session even when PI_RM_ASK_DIR is inherited', async () => {
    const askDir = mkdtempSync(join(base, 'ask-'))
    let asked = 0
    const stop = serveAskDir(askDir, async () => {
      asked++
      return true
    })
    const child = spawnSync('/bin/bash', ['-c', `${guardPrefix([root, scratch])}\nrm -f ../outside/file`], {
      cwd: root,
      env: { ...process.env, PI_RM_ASK_DIR: askDir },
      encoding: 'utf8',
      timeout: 5000,
    })
    stop()
    assert.equal(child.status, 3, child.stderr)
    assert.equal(asked, 0)
    assert.equal(has('outside/file'), true)
  })
})

describe('guard configuration', () => {
  it('fails closed when the root is /', () => {
    const result = run('rm -f file', root, ['/', scratch])
    assert.equal(result.status, 64)
    assert.match(result.stderr, /an allowed directory must not be \//)
    assert.equal(has('root/file'), true)
  })

  it('fails closed when an allowed directory does not exist', () => {
    const result = run('rm -f file', root, [root, join(base, 'missing')])
    assert.equal(result.status, 64)
    assert.match(result.stderr, /allowed directory is not accessible/)
    assert.equal(has('root/file'), true)
  })

  it('rejects a colon or newline in an allowed directory before anything runs', () => {
    assert.throws(() => guardPrefix([root, 'a:b']), /contains ':' or newline/)
    assert.throws(() => guardPrefix([root, 'a\nb']), /contains ':' or newline/)
  })
})
