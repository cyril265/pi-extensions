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

export type PromptRun = {
  events: unknown[]
  toolCalls: ToolCall[]
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

function parseEvents(output: string): unknown[] {
  return output
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      const event: unknown = JSON.parse(line)
      return event
    })
}

function parseToolCalls(events: unknown[]): ToolCall[] {
  return events
    .filter(isToolExecutionStart)
    .map(event => ({ toolName: event.toolName, args: event.args }))
}

function getEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (name.startsWith('PI_SIMPLE_SUBAGENT')) delete env[name]
  }
  for (const name of [
    'HERDR_BIN_PATH',
    'HERDR_ENV',
    'HERDR_PANE_ID',
    'HERDR_SOCKET_PATH',
    'HERDR_TAB_ID',
    'HERDR_WORKSPACE_ID',
  ]) {
    delete env[name]
  }
  return env
}

function invokePi(
  cwd: string,
  prompt: string,
  session: { kind: 'ephemeral' } | { kind: 'persisted'; path: string },
  blockTools: boolean,
  mode: 'json' | 'print',
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const sessionArgs = session.kind === 'persisted'
      ? ['--session', session.path]
      : ['--no-session']
    const extensionArgs = blockTools
      ? ['-e', extensionPath, '-e', blockerPath]
      : ['-e', extensionPath]
    const child = spawn(
      piPath,
      [
        ...(mode === 'json' ? ['--mode', 'json'] : ['-p']),
        ...sessionArgs,
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-context-files',
        '--model',
        model,
        '--thinking',
        thinking,
        '--tools',
        'read,write,edit,bash,grep,find,ls,agentWorkflowScript,runSubAgents,joinSubAgents',
        ...extensionArgs,
        prompt,
      ],
      {
        cwd,
        env: getEnvironment(),
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
        resolve({ stdout, stderr })
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

async function runPi(
  cwd: string,
  prompt: string,
  session: { kind: 'ephemeral' } | { kind: 'persisted'; path: string },
  blockTools: boolean,
): Promise<PromptRun> {
  const { stdout } = await invokePi(cwd, prompt, session, blockTools, 'json')
  const events = parseEvents(stdout)
  return { events, toolCalls: parseToolCalls(events) }
}

export async function runPrompt(cwd: string, prompt: string): Promise<ToolCall[]> {
  const result = await runPi(cwd, prompt, { kind: 'ephemeral' }, true)
  return result.toolCalls
}

export function runLifecycle(cwd: string, sessionPath: string, prompt: string): Promise<PromptRun> {
  return runPi(cwd, prompt, { kind: 'persisted', path: sessionPath }, false)
}

export async function runPrintLifecycle(
  cwd: string,
  sessionPath: string,
  prompt: string,
): Promise<string> {
  const result = await invokePi(
    cwd,
    prompt,
    { kind: 'persisted', path: sessionPath },
    false,
    'print',
  )
  return result.stdout
}
