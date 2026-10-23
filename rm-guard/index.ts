import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export const binDir = join(import.meta.dirname, 'bin')

function bashPath(dir: string): string {
  const drive = /^([A-Za-z]):[\\/]/.exec(dir)
  if (process.platform !== 'win32' || !drive) return dir
  return `/${drive[1].toLowerCase()}/${dir.slice(3).replaceAll('\\', '/')}`
}

export function allowList(dirs: string[]): string {
  const entries = dirs.map(bashPath)
  for (const entry of entries) {
    if (/[:\n]/.test(entry))
      throw new Error(`rm-guard: directory contains ':' or newline: ${entry}`)
  }
  return entries.join(':')
}

function pathKey(): string {
  return Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
}

function prependBinDir(): boolean {
  if (binDir.includes(delimiter))
    throw new Error(`rm-guard: package path contains '${delimiter}': ${binDir}`)
  const key = pathKey()
  const current = process.env[key] ?? ''
  if (current.split(delimiter).includes(binDir)) return false
  process.env[key] = current ? `${binDir}${delimiter}${current}` : binDir
  return true
}

function removeBinDir(): void {
  const key = pathKey()
  const entries = (process.env[key] ?? '').split(delimiter)
  const index = entries.indexOf(binDir)
  if (index === -1) return
  entries.splice(index, 1)
  process.env[key] = entries.join(delimiter)
}

export function serveAskDir(
  dir: string,
  confirm: (paths: string[]) => Promise<boolean>,
): () => void {
  let open = true
  const watcher = watch(dir, (_event, name) => {
    if (!name?.endsWith('.request')) return
    const request = join(dir, name)
    if (!existsSync(request)) return
    const paths = readFileSync(request, 'utf8').split('\0').slice(0, -1)
    rmSync(request)
    const reply = request.replace(/\.request$/, '.reply')
    void confirm(paths).then(allowed => {
      if (!open) return
      writeFileSync(`${reply}.tmp`, allowed ? 'allow' : 'deny')
      renameSync(`${reply}.tmp`, reply)
    })
  })
  return () => {
    open = false
    watcher.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

export default function rmGuard(pi: ExtensionAPI) {
  let stop: (() => void) | undefined

  pi.on('session_start', (_event, ctx) => {
    stop?.()
    const addedBinDir = prependBinDir()
    delete process.env.PI_RM_ALLOW
    process.env.PI_RM_ASK_DIR = ''
    let closeAskDir = () => {}
    stop = () => {
      closeAskDir()
      delete process.env.PI_RM_ALLOW
      delete process.env.PI_RM_ASK_DIR
      if (addedBinDir) removeBinDir()
      stop = undefined
    }
    process.env.PI_RM_ALLOW = allowList([ctx.cwd, tmpdir(), '/tmp'])
    if (!ctx.hasUI) return
    const askDir = mkdtempSync(join(tmpdir(), 'pi-rm-ask-'))
    const ended = new AbortController()
    let dialogs = Promise.resolve(false)
    const close = serveAskDir(askDir, paths => {
      dialogs = dialogs.then(async () => {
        pi.events.emit('herdr:blocked', { active: true, label: 'rm needs confirmation' })
        try {
          return await ctx.ui.confirm('rm outside the allowed directories', paths.join('\n'), {
            signal: ended.signal,
          })
        } catch {
          return false
        } finally {
          pi.events.emit('herdr:blocked', { active: false })
        }
      })
      return dialogs
    })
    closeAskDir = () => {
      ended.abort()
      close()
    }
    process.env.PI_RM_ASK_DIR = askDir
  })

  pi.on('session_shutdown', () => {
    stop?.()
  })
}
