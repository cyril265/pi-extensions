import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { copyToClipboard } from '@earendil-works/pi-coding-agent'

export type ClipboardCopyResult =
  | { mode: 'plain'; reason: 'html-unsupported' | 'html-write-failed' }
  | { mode: 'rich' }

export async function copyPlainWithHtml(plain: string, html: string): Promise<ClipboardCopyResult> {
  if (platform() !== 'darwin') {
    await copyToClipboard(plain)
    return { mode: 'plain', reason: 'html-unsupported' }
  }

  try {
    await copyToMacPasteboard(plain, html)
    return { mode: 'rich' }
  } catch {
    await copyToClipboard(plain)
    return { mode: 'plain', reason: 'html-write-failed' }
  }
}

async function copyToMacPasteboard(plain: string, html: string): Promise<void> {
  await runOsascript(
    `
ObjC.import('AppKit')
ObjC.import('Foundation')

const inputData = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
const input = $.NSString.alloc.initWithDataEncoding(inputData, $.NSUTF8StringEncoding).js
const payload = JSON.parse(input)

const pasteboard = $.NSPasteboard.generalPasteboard
pasteboard.clearContents

if (!pasteboard.setStringForType($(payload.plain), $.NSPasteboardTypeString)) {
  throw new Error('Failed to write plain text to pasteboard')
}

if (!pasteboard.setStringForType($(payload.html), $.NSPasteboardTypeHTML)) {
  throw new Error('Failed to write HTML to pasteboard')
}
`,
    JSON.stringify({ plain, html }),
  )
}

async function runOsascript(script: string, input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('osascript', ['-l', 'JavaScript', '-e', script], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''

    child.stderr.on('data', (chunk: unknown) => {
      stderr += String(chunk)
    })

    child.on('error', reject)
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(stderr.trim() || `osascript exited with code ${code}`))
    })

    child.stdin.end(input)
  })
}
