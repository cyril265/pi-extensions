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
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { allowList, binDir, serveAskDir } from './index.ts'

let base: string
let root: string
let outside: string
let scratch: string

function has(...parts: string[]): boolean {
  return existsSync(join(base, ...parts))
}

function guardEnv(allowed: string[], askDir = ''): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  env.HOME = outside
  env.PATH = `${binDir}${delimiter}${process.env.PATH}`
  env.PI_SESSION_ID = 'rm-guard-test'
  env.PI_RM_ALLOW = allowList(allowed)
  env.PI_RM_ASK_DIR = askDir
  delete env.UNSET_DIR
  return env
}

function run(command: string, cwd = root, allowed = [root, scratch], env = guardEnv(allowed)) {
  const result = spawnSync('/bin/bash', ['-c', command], { cwd, env, encoding: 'utf8' })
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
  const child = spawn('/bin/bash', ['-c', command], {
    cwd: root,
    env: guardEnv([root, scratch], askDir),
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
  for (const dir of ['root/dir', 'root/sub', 'outside/target/deep', 'outside/other', 'scratch']) {
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
  writeFileSync(join(root, 'clean-out.sh'), 'rm -rf ../outside/target\n')
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

describe('files outside the project', () => {
  it('are deleted without asking, also through a symlinked directory', async () => {
    let asked = 0
    const result = await runAsking('rm -f ../outside/file link-out/child', async () => {
      asked++
      return false
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(asked, 0)
    assert.equal(has('outside/file'), false)
    assert.equal(has('outside/target/child'), false)
    assert.equal(has('outside/target/deep'), true)
  })
})

describe('processes outside agent bash commands', () => {
  it('get plain rm without PI_SESSION_ID, even with the guard on PATH', () => {
    const env = guardEnv([root, scratch])
    delete env.PI_SESSION_ID
    delete env.PI_RM_ALLOW
    assert.equal(run('rm -rf ../outside/target', root, [], env).status, 0)
    assert.equal(has('outside/target'), false)
  })
})

describe('blocked deletions outside the project', () => {
  it('refuses an explicit outside directory', () => {
    expectBlocked('rm -rf ../outside/target')
    assert.equal(has('outside/target/child'), true)
  })

  it('refuses to follow a symlink out via trailing slash or glob', () => {
    expectBlocked('rm -rf link-out/')
    expectBlocked('rm -rf link-out/*')
    assert.equal(has('outside/target/child'), true)
    assert.equal(has('outside/target/deep'), true)
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
    expectBlocked('rm -rf file ../outside/file ../outside/target')
    assert.equal(has('root/file'), true)
    assert.equal(has('outside/file'), true)
    assert.equal(has('outside/target'), true)
  })

  it('reaches rm inside a script the text of the command never shows', () => {
    expectBlocked('bash clean-out.sh')
    assert.equal(has('outside/target'), true)
  })

  it('reports operand, resolved path and allowed directories', () => {
    const result = expectBlocked('rm -rf ../outside/target')
    assert.match(result.stderr, /operand: \.\.\/outside\/target/)
    assert.match(result.stderr, new RegExp(`resolved path: ${outside}/target`))
    assert.match(result.stderr, new RegExp(`allowed directory: ${root}`))
    assert.match(result.stderr, new RegExp(`allowed directory: ${scratch}`))
    assert.match(result.stderr, /ask the user to run it/)
  })
})

describe('asking the user', () => {
  it('deletes when the user allows and shows only the blocked directories', async () => {
    const asked: string[][] = []
    const result = await runAsking(
      'rm -rf file ../outside/file ../outside/target ../outside/other',
      async paths => {
        asked.push(paths)
        return true
      },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(asked, [[join(outside, 'target'), join(outside, 'other')]])
    assert.equal(has('root/file'), false)
    assert.equal(has('outside/file'), false)
    assert.equal(has('outside/target'), false)
    assert.equal(has('outside/other'), false)
  })

  it('blocks when the user declines', async () => {
    const result = await runAsking('rm -rf file ../outside/target', async () => false)
    assert.equal(result.status, 3)
    assert.match(result.stderr, /The user declined this deletion/)
    assert.equal(has('root/file'), true)
    assert.equal(has('outside/target'), true)
  })

  it('does not ask for deletions inside the project', async () => {
    let asked = 0
    const result = await runAsking('rm -rf file dir', async () => {
      asked++
      return false
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(asked, 0)
    assert.equal(has('root/file'), false)
    assert.equal(has('root/dir'), false)
  })

  it('asks once per rm call, also inside a script', async () => {
    let asked = 0
    const result = await runAsking(
      'bash clean-out.sh && rm -rf ../outside/other',
      async () => {
        asked++
        return true
      },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(asked, 2)
    assert.equal(has('outside/target'), false)
    assert.equal(has('outside/other'), false)
  })

  it('passes paths with newlines intact', async () => {
    mkdirSync(join(outside, 'line\nbreak'))
    const asked: string[][] = []
    await runAsking(`rm -rf ../outside/$'line\\nbreak'`, async paths => {
      asked.push(paths)
      return false
    })
    assert.deepEqual(asked, [[join(outside, 'line\nbreak')]])
  })

  it('blocks when the ask dir is removed while waiting, and the late answer is dropped', async () => {
    const askDir = mkdtempSync(join(base, 'ask-'))
    let answer!: (allowed: boolean) => void
    const stop = serveAskDir(askDir, () => new Promise(resolve => (answer = resolve)))
    const pending = spawnGuarded('rm -rf ../outside/target', askDir)
    while (!answer) await new Promise(resolve => setTimeout(resolve, 20))
    stop()
    const result = await pending
    assert.equal(result.status, 3)
    assert.match(result.stderr, /The user declined this deletion/)
    answer(true)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(has('outside/target'), true)
  })

  it('never asks when PI_RM_ASK_DIR is empty, as in a headless session', async () => {
    const askDir = mkdtempSync(join(base, 'ask-'))
    let asked = 0
    const stop = serveAskDir(askDir, async () => {
      asked++
      return true
    })
    const result = run('rm -rf ../outside/target')
    stop()
    assert.equal(result.status, 3, result.stderr)
    assert.equal(asked, 0)
    assert.equal(has('outside/target'), true)
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

  it('fails closed in an agent command when PI_RM_ALLOW is not set', () => {
    const env = guardEnv([root, scratch])
    delete env.PI_RM_ALLOW
    const result = run('rm -f file', root, [], env)
    assert.equal(result.status, 64)
    assert.match(result.stderr, /PI_RM_ALLOW is not set/)
    assert.equal(has('root/file'), true)
  })

  it('rejects a colon or newline in an allowed directory before anything runs', () => {
    assert.throws(() => allowList([root, 'a:b']), /contains ':' or newline/)
    assert.throws(() => allowList([root, 'a\nb']), /contains ':' or newline/)
  })
})
