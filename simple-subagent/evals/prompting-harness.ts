import { spawn } from 'node:child_process'
import { join } from 'node:path'

const packageRoot = join(import.meta.dirname, '..')
const piPath = join(packageRoot, 'node_modules', '.bin', 'pi')
const extensionPath = join(packageRoot, 'index.ts')
const blockerPath = join(import.meta.dirname, 'block-tool-execution.ts')
const model = 'openai-codex/gpt-5.6-sol'
const thinking = 'medium'

export const attemptsPerScenario = 3

export type ToolCall = {
  toolName: string
  args: unknown
}

type ToolExecutionStart = {
  type: 'tool_execution_start'
  toolName: string
  args: unknown
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isToolExecutionStart(event: unknown): event is ToolExecutionStart {
  return (
    isRecord(event) &&
    event.type === 'tool_execution_start' &&
    typeof event.toolName === 'string' &&
    'args' in event
  )
}

function parseToolCalls(output: string): ToolCall[] {
  return output
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      const event: unknown = JSON.parse(line)
      return event
    })
    .filter(isToolExecutionStart)
    .map(event => ({ toolName: event.toolName, args: event.args }))
}

export function runPrompt(cwd: string, prompt: string): Promise<ToolCall[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      piPath,
      [
        '--mode',
        'json',
        '--no-session',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-context-files',
        '--model',
        model,
        '--thinking',
        thinking,
        '--tools',
        'read,write,edit,bash,grep,find,ls,agentWorkflowScript,runSubAgents',
        '-e',
        extensionPath,
        '-e',
        blockerPath,
        prompt,
      ],
      {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180_000,
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(parseToolCalls(stdout))
        return
      }
      reject(
        new Error(
          `Pi exited with code ${String(code)} and signal ${String(signal)}\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`,
        ),
      )
    })
  })
}
