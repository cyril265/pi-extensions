import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  detailsFullOutputPath,
  readOptionalFile,
  splitExitCode,
  writeTempText,
} from './tool-output.ts'
import { describeTrim, type TrimOptions, trimOutput, wasTrimmed } from './trim.ts'

export function registerBashTrim(pi: ExtensionAPI, options: TrimOptions): void {
  pi.on('tool_result', async event => {
    if (event.toolName !== 'bash') return

    const textBlock = event.content.find(block => block.type === 'text')
    if (textBlock?.type !== 'text') return

    const { body, exitCodeLine } = splitExitCode(textBlock.text)
    const savedPath =
      detailsFullOutputPath(event.details) ?? body.match(/Full output: (.+?)\]$/)?.[1]
    const savedOutput = savedPath ? await readOptionalFile(savedPath) : undefined
    const fullOutput = savedOutput || body.replace(/\n\n\[Showing (?:lines|last) .+?\]$/, '')
    if (!fullOutput || fullOutput === '(no output)') return

    const result = trimOutput(fullOutput, options)
    if (!wasTrimmed(result)) return

    const fullPath =
      savedOutput && savedPath
        ? savedPath
        : await writeTempText('pi-bash-trim', 'full.log', fullOutput)
    const header = `[Trimmed: ${describeTrim(result)}. Full output: ${fullPath}]`
    return {
      content: [{ type: 'text', text: `${header}\n${result.text}${exitCodeLine}` }],
      details: { fullOutputPath: fullPath },
    }
  })
}
