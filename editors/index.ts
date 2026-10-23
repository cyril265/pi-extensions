import { spawn } from 'node:child_process'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const editors = [
  { command: 'rider', name: 'Rider', windowsExecutable: 'rider64.exe' },
  { command: 'zed', name: 'Zed', windowsExecutable: 'zed.exe' },
] as const

function launchDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })

    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export default function editorsExtension(pi: ExtensionAPI) {
  for (const editor of editors) {
    pi.registerCommand(editor.command, {
      description: `Open the current working directory in ${editor.name}`,
      handler: async (_args, ctx) => {
        try {
          if (process.platform === 'darwin') {
            const result = await pi.exec('/usr/bin/open', ['-a', editor.name, ctx.cwd])
            if (result.code !== 0) {
              throw new Error(result.stderr.trim() || `open exited with code ${result.code}`)
            }
          } else {
            const command = process.platform === 'win32' ? editor.windowsExecutable : editor.command
            await launchDetached(command, [ctx.cwd])
          }

          ctx.ui.notify(`Opened ${ctx.cwd} in ${editor.name}`, 'info')
        } catch (error: unknown) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
        }
      },
    })
  }
}
