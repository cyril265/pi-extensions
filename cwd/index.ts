import { realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type ExtensionAPI, SessionManager } from '@earendil-works/pi-coding-agent'

const ACTIVE_LEAF_ENTRY_TYPE = 'pi-cwd:active-leaf'

function expandHome(path: string): string {
  if (path === '~') {
    return homedir()
  }

  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2))
  }

  return path
}

export function resolveTargetPath(path: string, cwd: string): string {
  const expanded = expandHome(path)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
}

export function warpWorkingDirectorySequence(cwd: string, host = hostname()): string {
  const url = pathToFileURL(cwd)
  url.hostname = host
  return `\x1b]7;${url.href}\x07`
}

export function warpTabTitleSequence(cwd: string): string {
  const title = Array.from(basename(cwd) || cwd, character => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f) ? ' ' : character
  }).join('')
  return `\x1b]0;${title}\x07`
}

function updateWarpWorkingDirectory(cwd: string): void {
  if (process.env.TERM_PROGRAM === 'WarpTerminal') {
    process.stdout.write(`${warpWorkingDirectorySequence(cwd)}${warpTabTitleSequence(cwd)}`)
  }
}

async function requireDirectory(path: string): Promise<string> {
  const info = await stat(path)
  if (!info.isDirectory()) {
    throw new Error(`Not a directory: ${path}`)
  }
  return realpath(path)
}

function defaultSessionDirectoryName(cwd: string): string {
  const safePath = resolve(cwd)
    .replace(/^[/\\]/, '')
    .replace(/[/\\:]/g, '-')
  return `--${safePath}--`
}

function targetSessionDirectory(currentSessionDir: string, currentCwd: string, targetCwd: string) {
  if (basename(currentSessionDir) !== defaultSessionDirectoryName(currentCwd)) {
    return currentSessionDir
  }

  return join(dirname(currentSessionDir), defaultSessionDirectoryName(targetCwd))
}

async function materializeSessionInTarget(
  sourceSession: Pick<SessionManager, 'getEntries'>,
  targetCwd: string,
  targetSessionDir: string,
): Promise<SessionManager> {
  const targetSession = SessionManager.create(targetCwd, targetSessionDir)
  const targetSessionFile = targetSession.getSessionFile()
  if (!targetSessionFile) {
    throw new Error('Failed to create the target session')
  }

  const entries = [targetSession.getHeader(), ...sourceSession.getEntries()]
  await writeFile(
    targetSessionFile,
    `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
    { flag: 'wx' },
  )
  return SessionManager.open(targetSessionFile, targetSessionDir)
}

export default function cwdExtension(pi: ExtensionAPI) {
  pi.registerCommand('cwd', {
    description: 'Continue the current session in another working directory',
    handler: async (args, ctx) => {
      const input = args.trim()
      if (!input) {
        ctx.ui.notify('Usage: /cwd <directory>', 'error')
        return
      }

      await ctx.waitForIdle()

      const sourceSessionFile = ctx.sessionManager.getSessionFile()
      if (!sourceSessionFile) {
        ctx.ui.notify('/cwd is unavailable with --no-session', 'error')
        return
      }

      let sourceSessionExists = true
      try {
        await stat(sourceSessionFile)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          sourceSessionExists = false
        } else {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
          return
        }
      }

      let targetCwd: string
      try {
        targetCwd = await requireDirectory(resolveTargetPath(input, ctx.cwd))
      } catch (error: unknown) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
        return
      }

      if (targetCwd === (await realpath(ctx.cwd))) {
        ctx.ui.notify(`Already using ${targetCwd}`, 'info')
        return
      }

      const sourceLeafId = ctx.sessionManager.getLeafId()
      const targetSessionDir = targetSessionDirectory(
        ctx.sessionManager.getSessionDir(),
        ctx.cwd,
        targetCwd,
      )

      let targetSessionFile: string
      try {
        const targetSession = sourceSessionExists
          ? SessionManager.forkFrom(sourceSessionFile, targetCwd, targetSessionDir)
          : await materializeSessionInTarget(
              ctx.sessionManager,
              targetCwd,
              targetSessionDir,
            )
        if (sourceLeafId) {
          targetSession.branch(sourceLeafId)
        } else {
          targetSession.resetLeaf()
        }
        targetSession.appendCustomEntry(ACTIVE_LEAF_ENTRY_TYPE)

        const createdSessionFile = targetSession.getSessionFile()
        if (!createdSessionFile) {
          throw new Error('Failed to create the target session')
        }
        targetSessionFile = createdSessionFile
      } catch (error: unknown) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
        return
      }

      const result = await ctx.switchSession(targetSessionFile, {
        withSession: async replacementCtx => {
          process.chdir(replacementCtx.cwd)
          if (replacementCtx.mode === 'tui') {
            updateWarpWorkingDirectory(replacementCtx.cwd)
          }
          replacementCtx.ui.notify(`Working directory: ${replacementCtx.cwd}`, 'info')
        },
      })

      if (result.cancelled) {
        await unlink(targetSessionFile)
        ctx.ui.notify('Working-directory change cancelled', 'info')
      }
    },
  })
}
