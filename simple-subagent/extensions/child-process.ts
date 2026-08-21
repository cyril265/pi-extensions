import { spawn } from 'node:child_process'
import * as path from 'node:path'
import type { Message } from '@earendil-works/pi-ai'
import { getPackageDir } from '@earendil-works/pi-coding-agent'
import {
  dedupeToolDisplayItems,
  getEventToolDisplayItem,
  getFinalOutput,
  getToolDisplayItems,
} from './tool-events.ts'
import type { PiJsonEvent, SubagentRunResult, ThinkingLevel, ToolDisplayItem } from './types.ts'
import { addAssistantUsage, createUsageStats, getAssistantContextTokens } from './usage.ts'

const SIMPLE_SUBAGENT_PROCESS_ENV = 'PI_SIMPLE_SUBAGENT'
const SIMPLE_SUBAGENT_CACHE_KEY_ENV = 'PI_SIMPLE_SUBAGENT_CACHE_KEY'
const SIMPLE_SUBAGENT_FORK_TOOL_ENV = 'PI_SIMPLE_SUBAGENT_FORK_TOOL'

function getPromptArgument(prompt: string): string {
  return prompt.startsWith('-') ? `\n${prompt}` : prompt
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const execName = path.basename(process.execPath).toLowerCase()
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
  if (!isGenericRuntime) {
    return { command: process.execPath, args }
  }

  return {
    command: process.execPath,
    args: [path.join(getPackageDir(), 'dist', 'cli.js'), ...args],
  }
}

export function getProcessExitCode(code: number | null): number {
  return code ?? 1
}

async function runPiJsonProcess(
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  onEvent: (event: PiJsonEvent) => void,
  extraEnv?: Record<string, string>,
): Promise<{ exitCode: number; stderr: string; aborted: boolean }> {
  return await new Promise(resolve => {
    const invocation = getPiInvocation(args)
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      env: { ...process.env, [SIMPLE_SUBAGENT_PROCESS_ENV]: '1', ...extraEnv },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    let buffer = ''
    let aborted = false
    let settled = false

    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
      void resolve({ exitCode, stderr, aborted })
    }

    const processLine = (line: string) => {
      if (!line.trim()) return
      try {
        onEvent(JSON.parse(line) as PiJsonEvent)
      } catch {
        // ignore malformed lines
      }
    }

    const abortHandler = () => {
      aborted = true
      proc.kill('SIGTERM')
      setTimeout(() => {
        if (!settled) proc.kill('SIGKILL')
      }, 5000).unref()
    }

    proc.stdout.on('data', data => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) processLine(line)
    })

    proc.stderr.on('data', data => {
      stderr += data.toString()
    })

    proc.on('error', error => {
      stderr += `${stderr ? '\n' : ''}${error.message}`
      finish(1)
    })

    proc.on('close', (code, terminationSignal) => {
      if (buffer.trim()) processLine(buffer)
      if (terminationSignal) {
        stderr += `${stderr ? '\n' : ''}Subagent process terminated by ${terminationSignal}`
      }
      finish(getProcessExitCode(code))
    })

    if (signal) {
      if (signal.aborted) abortHandler()
      else signal.addEventListener('abort', abortHandler, { once: true })
    }
  })
}

export async function runSubAgent(
  model: string,
  thinking: ThinkingLevel,
  prompt: string,
  cwd: string,
  sessionPath: string,
  promptCacheKey: string | undefined,
  signal: AbortSignal | undefined,
  onTool: ((tool: ToolDisplayItem) => void) | undefined,
): Promise<SubagentRunResult> {
  const usage = createUsageStats()
  let firstTurnUsage: SubagentRunResult['firstTurnUsage'] | undefined
  let contextTokens: number | undefined
  const messages: Message[] = []
  const tools: ToolDisplayItem[] = []
  const args = [
    '--mode',
    'json',
    '-p',
    '--session',
    sessionPath,
    '--model',
    model,
    '--thinking',
    thinking,
    getPromptArgument(prompt),
  ]

  const result = await runPiJsonProcess(
    args,
    cwd,
    signal,
    event => {
      const tool = getEventToolDisplayItem(event)
      if (tool) {
        tools.push(tool)
        onTool?.(tool)
      }

      if (event.type !== 'message_end' || !event.message) return
      const message = event.message as Message
      messages.push(message)
      if (message.role === 'assistant' && !firstTurnUsage) {
        firstTurnUsage = {
          input: message.usage.input,
          output: message.usage.output,
          cacheRead: message.usage.cacheRead,
          cacheWrite: message.usage.cacheWrite,
        }
      }
      contextTokens = getAssistantContextTokens(message) ?? contextTokens
      addAssistantUsage(usage, message)
    },
    promptCacheKey
      ? {
          [SIMPLE_SUBAGENT_CACHE_KEY_ENV]: promptCacheKey,
          [SIMPLE_SUBAGENT_FORK_TOOL_ENV]: '1',
        }
      : undefined,
  )

  if (result.aborted) {
    throw new Error('Subagent was aborted')
  }

  const finalOutput = getFinalOutput(messages).trim()
  if (!firstTurnUsage) {
    throw new Error(result.stderr.trim() || 'Subagent produced no assistant usage')
  }

  return {
    text: finalOutput || result.stderr.trim() || '(no output)',
    exitCode: result.exitCode,
    tools: dedupeToolDisplayItems([...tools, ...getToolDisplayItems(messages)]),
    usage,
    contextTokens,
    firstTurnUsage,
  }
}
