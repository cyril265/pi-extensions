#!/usr/bin/env node

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'

type PiqMode = 'normal' | 'command'

type CommandResponse = {
  command: string
  explanation?: string
}

type CommandConfig = {
  name: 'pil' | 'pic' | 'pim'
  model: string
  mode: PiqMode
}

const lowModel = 'openai-codex/gpt-5.5:low'
const mediumModel = 'openai-codex/gpt-5.5:medium'
const commandModel = 'openai-codex/gpt-5.6-sol:medium'
const finalResponsePrompt =
  'Final user-facing response for this shorthand CLI: plain text only, no Markdown formatting, no headings, no bullets, no code fences. Around 350 characters or less. Exception: if the user explicitly asks for code, code formatting is allowed and the response can be longer when needed. Answer directly.'
const commandResponsePrompt =
  'This is pic command mode. Do not answer normally. For the final user-facing result, call respond_command with the exact one-line shell command to place in the terminal input field and an optional concise explanation. The command must not contain a newline. The tool fills the prompt but does not press Enter.'
const thinkingAnimationFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const command = commandFromExecutable(basename(process.argv[1] ?? ''))

if (command === undefined) {
  process.stderr.write('unknown executable name; expected pil, pic, or pim\n')
  process.exit(2)
}

const packageRoot = join(dirname(realpathSync(process.argv[1] ?? '')), '..')
const commandResponseExtensionPath = join(packageRoot, 'extensions', 'respond-command.ts')
const terminalInputInjectorPath = join(packageRoot, 'build', 'tiocsti')
const commandResponseFile =
  process.env.PIQ_COMMAND_RESPONSE_FILE ??
  join(tmpdir(), 'piq', 'command-response', `${process.pid}.json`)
const childEnv = { ...process.env }
childEnv.PIQ_COMMAND_RESPONSE_FILE = commandResponseFile

const stdinIsTty = process.stdin.isTTY === true
const stdinText = await readPipedStdin(stdinIsTty)
const promptArgs = process.argv.slice(2)
const prompt = await buildPrompt(promptArgs, stdinText, command.name, stdinIsTty)

if (prompt.length === 0) {
  process.stderr.write(usageFor(command))
  process.exit(2)
}

const model = command.model
const piqMode = command.mode

const piArgs = ['--mode', 'json', '--model', model, '--no-extensions', '--no-session']

if (piqMode === 'command') {
  piArgs.push(
    '--no-builtin-tools',
    '--extension',
    commandResponseExtensionPath,
    '--tools',
    'respond_command',
  )
}

piArgs.push('--append-system-prompt', systemPromptForMode(piqMode))
piArgs.push(prompt)

let child: ChildProcessWithoutNullStreams
try {
  child = spawn('pi', piArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
  })
} catch (error) {
  process.stderr.write(`failed to start pi: ${errorMessage(error)}\n`)
  process.exit(127)
}

let stdoutBuffer = ''
let stderrBuffer = ''
let assistantPrinted = false
let stdoutEndsWithNewline = true
let bufferedAssistantText = ''
let thinkingAnimationTimer: ReturnType<typeof setInterval> | undefined
let thinkingAnimationFrame = 0
let thinkingAnimationVisible = false

startThinkingAnimation()

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk: string) => {
  stdoutBuffer += chunk

  let newlineIndex = stdoutBuffer.indexOf('\n')
  while (newlineIndex !== -1) {
    const line = stdoutBuffer.slice(0, newlineIndex)
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
    handleJsonLine(line)
    newlineIndex = stdoutBuffer.indexOf('\n')
  }
})

child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk: string) => {
  stderrBuffer += chunk

  let newlineIndex = stderrBuffer.indexOf('\n')
  while (newlineIndex !== -1) {
    const line = stderrBuffer.slice(0, newlineIndex)
    stderrBuffer = stderrBuffer.slice(newlineIndex + 1)
    if (line.length > 0) {
      writeStderrLine(line)
    }
    newlineIndex = stderrBuffer.indexOf('\n')
  }
})

child.on('error', error => {
  stopThinkingAnimation()
  process.stderr.write(`failed to start pi: ${errorMessage(error)}\n`)
  process.exit(127)
})

child.on('close', code => {
  if (stdoutBuffer.length > 0) {
    handleJsonLine(stdoutBuffer)
  }

  if (stderrBuffer.length > 0) {
    clearThinkingAnimation()
    process.stderr.write(stderrBuffer)
    if (!stderrBuffer.endsWith('\n')) {
      process.stderr.write('\n')
    }
  }

  stopThinkingAnimation()

  if (code === 0) {
    const commandResponseResult = readCommandResponse()
    if (commandResponseResult.error !== undefined) {
      process.stderr.write(`${commandResponseResult.error}\n`)
      process.exit(1)
    }

    if (commandResponseResult.response !== undefined) {
      writeCommandExplanation(commandResponseResult.response)

      const injectionError = injectTerminalInput(commandResponseResult.response.command)
      if (injectionError !== undefined) {
        process.stderr.write(`${injectionError}\n`)
        process.exit(1)
      }
    } else {
      flushBufferedAssistantText()
    }
  } else {
    discardCommandResponse()
    flushBufferedAssistantText()
  }

  if (assistantPrinted && !stdoutEndsWithNewline) {
    process.stdout.write('\n')
  }

  process.exit(code ?? 1)
})

async function buildPrompt(
  args: string[],
  pipedText: string,
  commandName: string,
  canPrompt: boolean,
): Promise<string> {
  if (args.length > 0 && pipedText.length > 0) {
    return `${args.join(' ')}\n\n${pipedText}`
  }

  if (args.length > 0) {
    return args.join(' ')
  }

  if (pipedText.length > 0) {
    return pipedText
  }

  if (!canPrompt) {
    return ''
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  })

  try {
    return await rl.question(`${commandName}> `)
  } finally {
    rl.close()
  }
}

async function readPipedStdin(stdinIsTty: boolean): Promise<string> {
  if (stdinIsTty) {
    return ''
  }

  let text = ''
  process.stdin.setEncoding('utf8')

  for await (const chunk of process.stdin) {
    text += String(chunk)
  }

  return text.trimEnd()
}

function handleJsonLine(line: string): void {
  if (line.trim().length === 0) {
    return
  }

  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    writeStderrLine(line)
    return
  }

  if (!isRecord(event) || typeof event.type !== 'string') {
    return
  }

  if (event.type === 'message_update') {
    const messageEvent = event.assistantMessageEvent
    if (
      isRecord(messageEvent) &&
      messageEvent.type === 'text_delta' &&
      typeof messageEvent.delta === 'string'
    ) {
      writeAssistantText(messageEvent.delta)
    }
    return
  }

  if (event.type === 'message_end' && !assistantPrinted) {
    const message = event.message
    if (isRecord(message) && message.role === 'assistant') {
      const text = textFromContent(message.content)
      if (text.length > 0) {
        writeAssistantText(text)
      }
    }
    return
  }

  if (event.type === 'tool_execution_start') {
    return
  }

  if (event.type === 'tool_execution_end') {
    if (event.isError === true && typeof event.toolName === 'string') {
      writeStderrLine(`✗ ${event.toolName}`)
    }
  }
}

function writeAssistantText(text: string): void {
  if (text.length === 0) {
    return
  }

  if (piqMode === 'command') {
    stopThinkingAnimation()
    bufferedAssistantText += text
    return
  }

  writeAssistantTextNow(text)
}

function writeAssistantTextNow(text: string): void {
  if (!assistantPrinted) {
    stopThinkingAnimation()
  }

  assistantPrinted = true
  stdoutEndsWithNewline = text.endsWith('\n')
  process.stdout.write(text)
}

function flushBufferedAssistantText(): void {
  if (bufferedAssistantText.length === 0) {
    return
  }

  const text = bufferedAssistantText
  bufferedAssistantText = ''
  writeAssistantTextNow(text)
}

function startThinkingAnimation(): void {
  if (process.stderr.isTTY !== true) {
    return
  }

  renderThinkingAnimation()
  thinkingAnimationTimer = setInterval(renderThinkingAnimation, 100)
  thinkingAnimationTimer.unref()
}

function renderThinkingAnimation(): void {
  const frame = thinkingAnimationFrames[thinkingAnimationFrame % thinkingAnimationFrames.length]
  thinkingAnimationFrame += 1
  thinkingAnimationVisible = true
  process.stderr.write(`\r\x1b[2Kπ thinking ${frame}`)
}

function clearThinkingAnimation(): void {
  if (thinkingAnimationVisible) {
    process.stderr.write('\r\x1b[2K')
    thinkingAnimationVisible = false
  }
}

function stopThinkingAnimation(): void {
  if (thinkingAnimationTimer !== undefined) {
    clearInterval(thinkingAnimationTimer)
    thinkingAnimationTimer = undefined
  }

  clearThinkingAnimation()
}

function writeStderrLine(line: string): void {
  clearThinkingAnimation()
  process.stderr.write(`${line}\n`)

  if (!assistantPrinted && thinkingAnimationTimer !== undefined) {
    renderThinkingAnimation()
  }
}

function readCommandResponse(): { response?: CommandResponse; error?: string } {
  if (!existsSync(commandResponseFile)) {
    return {}
  }

  try {
    const parsed = JSON.parse(readFileSync(commandResponseFile, 'utf8'))
    if (!isRecord(parsed) || typeof parsed.command !== 'string') {
      return { error: 'invalid respond_command output: command must be a string' }
    }

    if (parsed.explanation !== undefined && typeof parsed.explanation !== 'string') {
      return { error: 'invalid respond_command output: explanation must be a string' }
    }

    if (parsed.command.length === 0) {
      return { error: 'invalid respond_command output: command must not be empty' }
    }

    if (parsed.command.includes('\n') || parsed.command.includes('\r')) {
      return { error: 'invalid respond_command output: command must not contain a newline' }
    }

    if (parsed.command.includes('\0')) {
      return { error: 'invalid respond_command output: command must not contain a NUL byte' }
    }

    return {
      response: {
        command: parsed.command,
        explanation: parsed.explanation,
      },
    }
  } catch (error) {
    return { error: `failed to read respond_command output: ${errorMessage(error)}` }
  } finally {
    discardCommandResponse()
  }
}

function discardCommandResponse(): void {
  if (!existsSync(commandResponseFile)) {
    return
  }

  try {
    unlinkSync(commandResponseFile)
  } catch (error) {
    process.stderr.write(`failed to remove respond_command output: ${errorMessage(error)}\n`)
  }
}

function writeCommandExplanation(response: CommandResponse): void {
  const explanation = response.explanation?.trim()
  if (explanation === undefined || explanation.length === 0) {
    return
  }

  writeAssistantTextNow(`${explanation}\n`)
}

function systemPromptForMode(mode: PiqMode): string {
  if (mode === 'command') {
    return commandResponsePrompt
  }

  return finalResponsePrompt
}

function injectTerminalInput(text: string): string | undefined {
  if (text.includes('\n') || text.includes('\r')) {
    return 'refusing to set terminal input containing a newline'
  }

  if (text.includes('\0')) {
    return 'refusing to set terminal input containing a NUL byte'
  }

  if (!existsSync(terminalInputInjectorPath)) {
    return `terminal input helper missing at ${terminalInputInjectorPath}; run \`npm run build\` (or reinstall) to compile it`
  }

  const result = spawnSync(terminalInputInjectorPath, [text], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  if (result.error !== undefined) {
    return `failed to start terminal input injector: ${result.error.message}`
  }

  if (result.status !== 0) {
    const stderr = result.stderr.trim()
    return stderr.length > 0
      ? `failed to set terminal input: ${stderr}`
      : `failed to set terminal input: injector exited with code ${result.status ?? 'unknown'}`
  }

  return undefined
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content.map(textFromPart).join('')
}

function textFromPart(part: unknown): string {
  if (typeof part === 'string') {
    return part
  }

  if (!isRecord(part)) {
    return ''
  }

  if (typeof part.text === 'string') {
    return part.text
  }

  if (typeof part.content === 'string') {
    return part.content
  }

  return ''
}

function commandFromExecutable(executableName: string): CommandConfig | undefined {
  if (executableName === 'pil' || executableName === 'piq.ts') {
    return { name: 'pil', model: lowModel, mode: 'normal' }
  }

  if (executableName === 'pic') {
    return { name: 'pic', model: commandModel, mode: 'command' }
  }

  if (executableName === 'pim') {
    return { name: 'pim', model: mediumModel, mode: 'normal' }
  }

  return undefined
}

function usageFor(commandConfig: CommandConfig): string {
  return `usage: ${commandConfig.name} <question or command>\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
