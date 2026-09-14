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
import { join } from 'node:path'
import { type ExtensionAPI, isToolCallEventType } from '@earendil-works/pi-coding-agent'

const binDir = join(import.meta.dirname, 'bin')

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function guardPrefix(allowed: string[], askDir = ''): string {
  for (const dir of [...allowed, binDir, askDir]) {
    if (/[:\n]/.test(dir)) throw new Error(`rm-guard: directory contains ':' or newline: ${dir}`)
  }
  return `export PI_RM_ALLOW=${quote(allowed.join(':'))} PATH=${quote(binDir)}:"$PATH" PI_RM_ASK_DIR=${quote(askDir)}`
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
    confirm(paths).then(allowed => {
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
  const cleanups = new Map<string, () => void>()
  let dialogs = Promise.resolve(false)

  pi.on('tool_call', (event, ctx) => {
    if (!isToolCallEventType('bash', event)) return
    const allowed = [ctx.cwd, tmpdir(), '/tmp']
    if (!ctx.hasUI) {
      event.input.command = `${guardPrefix(allowed)}\n${event.input.command}`
      return
    }
    const askDir = mkdtempSync(join(tmpdir(), 'pi-rm-ask-'))
    const stop = serveAskDir(askDir, paths => {
      dialogs = dialogs.then(() =>
        ctx.ui.confirm('rm outside the allowed directories', paths.join('\n'), {
          signal: ctx.signal,
        }),
      )
      return dialogs
    })
    cleanups.set(event.toolCallId, stop)
    event.input.command = `${guardPrefix(allowed, askDir)}\n${event.input.command}`
  })

  pi.on('tool_result', event => {
    cleanups.get(event.toolCallId)?.()
    cleanups.delete(event.toolCallId)
  })
  pi.on('turn_end', () => {
    for (const stop of cleanups.values()) stop()
    cleanups.clear()
  })
}
