import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const parameters = Type.Object({
  command: Type.String({
    description:
      'Exact one-line shell command to place into the terminal input field. Do not include a trailing newline.',
  }),
  explanation: Type.Optional(
    Type.String({
      description:
        'Optional concise explanation to print before the command is placed into the terminal input field.',
    }),
  ),
})

export default function respondCommandExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'respond_command',
    label: 'Respond Command',
    description:
      'Final response tool for pic. Prints an optional explanation and places a one-line shell command into the terminal input field without pressing Enter.',
    promptSnippet: 'Finalize pic command mode with a shell command and optional explanation',
    promptGuidelines: [
      'Use respond_command for every final response in pic command mode instead of answering normally.',
      'respond_command.command must be exactly one shell command line and must not contain a newline.',
      'respond_command.explanation is optional; omit it unless a short clarification is useful.',
      'After calling respond_command successfully, do not produce additional assistant text.',
    ],
    parameters,
    async execute(_toolCallId, params) {
      if (params.command.length === 0) {
        throw new Error('command must not be empty')
      }

      if (params.command.includes('\n') || params.command.includes('\r')) {
        throw new Error('command must not contain a newline')
      }

      if (params.command.includes('\0')) {
        throw new Error('command must not contain a NUL byte')
      }

      const filePath = process.env.PIQ_COMMAND_RESPONSE_FILE
      if (filePath === undefined || filePath.length === 0) {
        throw new Error('PIQ_COMMAND_RESPONSE_FILE is not set')
      }

      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(
        filePath,
        JSON.stringify({ command: params.command, explanation: params.explanation }),
        'utf8',
      )

      return {
        content: [
          {
            type: 'text' as const,
            text: 'Command response recorded. The command will be placed into the terminal input field without being executed.',
          },
        ],
        details: { commandChars: Array.from(params.command).length },
        terminate: true,
      }
    },
  })
}
