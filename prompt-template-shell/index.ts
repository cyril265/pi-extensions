import { readFile } from 'node:fs/promises'
import {
  createLocalBashOperations,
  type ExtensionAPI,
  type ExtensionContext,
  parseFrontmatter,
} from '@earendil-works/pi-coding-agent'

const commandTimeoutSeconds = 30

type CommandExecutor = (command: string) => Promise<string>

type TemplateInvocation = {
  name: string
  args: string[]
}

export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: string | undefined

  for (const character of argsString) {
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined
      } else {
        current += character
      }
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (/\s/.test(character)) {
      if (current.length > 0) {
        args.push(current)
        current = ''
      }
    } else {
      current += character
    }
  }

  if (current.length > 0) args.push(current)
  return args
}

export function substituteArgs(content: string, args: string[]): string {
  const allArgs = args.join(' ')

  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
      if (defaultTarget) {
        const value =
          defaultTarget === '@' || defaultTarget === 'ARGUMENTS'
            ? allArgs
            : args[Number.parseInt(defaultTarget, 10) - 1]
        return value || defaultValue
      }

      if (sliceStart) {
        const start = Math.max(Number.parseInt(sliceStart, 10) - 1, 0)
        if (sliceLength) {
          const length = Number.parseInt(sliceLength, 10)
          return args.slice(start, start + length).join(' ')
        }
        return args.slice(start).join(' ')
      }

      if (simple === 'ARGUMENTS' || simple === '@') return allArgs
      return args[Number.parseInt(simple, 10) - 1] ?? ''
    },
  )
}

function parseTemplateInvocation(text: string): TemplateInvocation | undefined {
  const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
  if (!match) return undefined

  return {
    name: match[1],
    args: parseCommandArgs(match[2] ?? ''),
  }
}

function hasDynamicCommands(content: string): boolean {
  return /!`[^`]*`/.test(content)
}

export async function expandTemplate(
  content: string,
  args: string[],
  execute: CommandExecutor,
): Promise<string> {
  const commandPattern = /!`([^`]*)`/g
  const parts: string[] = []
  let cursor = 0
  let match = commandPattern.exec(content)

  while (match) {
    parts.push(substituteArgs(content.slice(cursor, match.index), args))

    const command = substituteArgs(match[1], args)
    if (command.trim().length === 0) throw new Error('Dynamic command cannot be empty')

    parts.push(await execute(command))
    cursor = match.index + match[0].length
    match = commandPattern.exec(content)
  }

  parts.push(substituteArgs(content.slice(cursor), args))
  return parts.join('')
}

function reportError(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, 'error')
  } else {
    console.error(message)
  }
}

export default function promptTemplateShell(pi: ExtensionAPI) {
  const shell = createLocalBashOperations()

  pi.on('input', async (event, ctx) => {
    const invocation = parseTemplateInvocation(event.text)
    if (!invocation) return { action: 'continue' }

    const template = pi
      .getCommands()
      .find(command => command.source === 'prompt' && command.name === invocation.name)
    if (!template) return { action: 'continue' }

    try {
      const source = await readFile(template.sourceInfo.path, 'utf8')
      const { body } = parseFrontmatter(source)
      if (!hasDynamicCommands(body)) return { action: 'continue' }

      const text = await expandTemplate(body, invocation.args, async command => {
        const chunks: Buffer[] = []
        const result = await shell.exec(command, ctx.cwd, {
          signal: ctx.signal,
          timeout: commandTimeoutSeconds,
          onData: data => chunks.push(Buffer.from(data)),
        })
        const output = Buffer.concat(chunks)
          .toString('utf8')
          .replace(/[\r\n]+$/, '')

        if (result.exitCode !== 0) {
          const status = result.exitCode === null ? 'terminated' : `exit code ${result.exitCode}`
          const details = output.length > 0 ? `\n${output}` : ''
          throw new Error(`Command failed (${status}): ${command}${details}`)
        }

        return output
      })

      return { action: 'transform', text }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      reportError(ctx, `Prompt template /${invocation.name}: ${message}`)
      return { action: 'handled' }
    }
  })
}
