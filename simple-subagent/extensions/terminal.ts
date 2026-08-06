import { spawnSync } from 'node:child_process'
import type { ThinkingLevel } from './types.ts'

const SIMPLE_SUBAGENT_PROCESS_ENV = 'PI_SIMPLE_SUBAGENT'
const SIMPLE_SUBAGENT_CACHE_KEY_ENV = 'PI_SIMPLE_SUBAGENT_CACHE_KEY'

type ForkContext = {
  sessionPath: string
  promptCacheKey: string
}

type HerdrResponse = {
  result?: {
    pane?: { pane_id?: string }
    root_pane?: { pane_id?: string }
    tab?: { tab_id?: string }
  }
  error?: { code?: string; message?: string }
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

function getPromptArgument(prompt: string): string {
  return prompt.startsWith('-') ? `\n${prompt}` : prompt
}

function buildPiShellCommand(
  prompt: string,
  model: string,
  thinking: ThinkingLevel,
  sessionDirectory: string,
  forkContext?: ForkContext,
): string {
  return [
    `${SIMPLE_SUBAGENT_PROCESS_ENV}=1`,
    ...(forkContext
      ? [`${SIMPLE_SUBAGENT_CACHE_KEY_ENV}=${shellQuote(forkContext.promptCacheKey)}`]
      : []),
    ...[
      'pi',
      '--session-dir',
      sessionDirectory,
      ...(forkContext ? ['--fork', forkContext.sessionPath] : []),
      '--model',
      model,
      '--thinking',
      thinking,
      getPromptArgument(prompt),
    ].map(shellQuote),
  ].join(' ')
}

function openCmuxSplit(
  prompt: string,
  model: string,
  thinking: ThinkingLevel,
  cwd: string,
  sessionDirectory: string,
  forkContext?: ForkContext,
) {
  const splitResult = spawnSync('cmux', ['--json', 'new-split', 'right'], {
    cwd,
    encoding: 'utf-8',
  })
  if (splitResult.status !== 0) {
    throw new Error(
      splitResult.stderr.trim() || splitResult.stdout.trim() || 'cmux new-split failed',
    )
  }

  const splitOutput = splitResult.stdout.trim()
  const splitResponse = splitOutput
    ? (JSON.parse(splitOutput) as Record<string, unknown>)
    : undefined
  // biome-ignore lint/complexity/useLiteralKeys: cmux's response key is snake_case.
  const surfaceRef = splitResponse?.['surface_ref']
  if (typeof surfaceRef !== 'string' || !surfaceRef) {
    throw new Error('cmux new-split did not return surface_ref')
  }

  const piCommand = buildPiShellCommand(prompt, model, thinking, sessionDirectory, forkContext)
  const command = `cd ${shellQuote(cwd)} && ${piCommand}`
  const sendResult = spawnSync('cmux', ['send', '--surface', surfaceRef, `${command}\n`], {
    cwd,
    encoding: 'utf-8',
  })
  if (sendResult.status !== 0) {
    throw new Error(sendResult.stderr.trim() || sendResult.stdout.trim() || 'cmux send failed')
  }
}

function openTmuxSplit(
  prompt: string,
  model: string,
  thinking: ThinkingLevel,
  cwd: string,
  sessionDirectory: string,
  forkContext?: ForkContext,
) {
  const command = buildPiShellCommand(prompt, model, thinking, sessionDirectory, forkContext)
  const splitResult = spawnSync('tmux', ['split-window', '-h', '-c', cwd, command], {
    cwd,
    encoding: 'utf-8',
  })
  if (splitResult.status !== 0) {
    throw new Error(
      splitResult.stderr.trim() || splitResult.stdout.trim() || 'tmux split-window failed',
    )
  }
}

function parseHerdrResponse(output: string | null | undefined): HerdrResponse | undefined {
  const value = output?.trim()
  if (!value) return undefined
  try {
    return JSON.parse(value) as HerdrResponse
  } catch {
    return undefined
  }
}

function runHerdrCommand(args: string[], cwd: string): HerdrResponse {
  const command = process.env.HERDR_BIN_PATH || 'herdr'
  const result = spawnSync(command, args, { cwd, encoding: 'utf-8' })
  const response = parseHerdrResponse(result.stdout) || parseHerdrResponse(result.stderr)
  if (result.status !== 0 || response?.error) {
    const reason =
      response?.error?.message ||
      response?.error?.code ||
      result.error?.message ||
      result.stderr?.trim() ||
      result.stdout?.trim() ||
      'unknown error'
    throw new Error(`herdr ${args[0]} ${args[1]} failed: ${reason}`)
  }
  return response || {}
}

export function isHerdrTerminal() {
  return (
    process.env.HERDR_ENV === '1' && !!process.env.HERDR_PANE_ID && !!process.env.HERDR_WORKSPACE_ID
  )
}

export function openHerdrForkTab(
  model: string,
  thinking: ThinkingLevel,
  cwd: string,
  sessionPath: string,
) {
  const workspaceId = process.env.HERDR_WORKSPACE_ID
  if (!workspaceId) throw new Error('HERDR_WORKSPACE_ID is not set')
  const createResponse = runHerdrCommand(
    ['tab', 'create', '--workspace', workspaceId, '--cwd', cwd, '--focus'],
    cwd,
  )
  const paneId = createResponse.result?.root_pane?.pane_id
  if (!paneId) throw new Error('herdr tab create did not return a root pane ID')

  const tabId = createResponse.result?.tab?.tab_id
  const command = ['pi', '--fork', sessionPath, '--model', model, '--thinking', thinking]
    .map(shellQuote)
    .join(' ')
  try {
    runHerdrCommand(['pane', 'run', paneId, command], cwd)
  } catch (error) {
    if (tabId) {
      try {
        runHerdrCommand(['tab', 'close', tabId], cwd)
      } catch {}
    }
    throw error
  }
}

function openHerdrSplit(
  prompt: string,
  model: string,
  thinking: ThinkingLevel,
  cwd: string,
  sessionDirectory: string,
  forkContext?: ForkContext,
) {
  const splitResponse = runHerdrCommand(
    ['pane', 'split', '--current', '--direction', 'right', '--cwd', cwd, '--focus'],
    cwd,
  )
  const paneId = splitResponse.result?.pane?.pane_id
  if (!paneId) throw new Error('herdr pane split did not return a pane ID')

  const command = buildPiShellCommand(prompt, model, thinking, sessionDirectory, forkContext)
  try {
    runHerdrCommand(['pane', 'run', paneId, command], cwd)
  } catch (error) {
    try {
      runHerdrCommand(['pane', 'close', paneId], cwd)
    } catch {
      // Preserve the launch error when cleanup also fails.
    }
    throw error
  }
}

export function isWarpTerminal() {
  return process.platform === 'darwin' && process.env.TERM_PROGRAM === 'WarpTerminal'
}

export function canOpenMuxSplit() {
  return (
    isHerdrTerminal() ||
    !!process.env.CMUX_WORKSPACE_ID ||
    !!process.env.CMUX_SURFACE_ID ||
    !!process.env.TMUX ||
    isWarpTerminal()
  )
}

function appleScriptQuote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function openWarpSplit(
  prompt: string,
  model: string,
  thinking: ThinkingLevel,
  cwd: string,
  sessionDirectory: string,
  forkContext?: ForkContext,
) {
  const piCommand = buildPiShellCommand(prompt, model, thinking, sessionDirectory, forkContext)
  const command = `cd ${shellQuote(cwd)} && ${piCommand}`
  const encodedCommand = Buffer.from(command, 'utf-8').toString('base64')
  const script = `
set encodedCommand to ${appleScriptQuote(encodedCommand)}
set subagentCommand to do shell script "printf %s " & quoted form of encodedCommand & " | /usr/bin/base64 -D"
set previousClipboard to the clipboard

try
  tell application "Warp" to activate
  delay 0.2

  tell application "System Events"
    tell process "Warp"
      keystroke "d" using command down
      delay 0.3
      set the clipboard to subagentCommand
      keystroke "v" using command down
      delay 0.5
      key code 36
    end tell
  end tell

  delay 0.2
  set the clipboard to previousClipboard
on error errorMessage number errorNumber
  set the clipboard to previousClipboard
  error errorMessage number errorNumber
end try
`

  const result = spawnSync('osascript', ['-e', script], {
    cwd,
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        'Warp split failed. Grant Accessibility permission to terminal app running pi.',
    )
  }
}

export function openMuxSplit(
  prompt: string,
  model: string,
  thinking: ThinkingLevel,
  cwd: string,
  sessionDirectory: string,
  forkContext?: ForkContext,
) {
  if (isHerdrTerminal()) {
    openHerdrSplit(prompt, model, thinking, cwd, sessionDirectory, forkContext)
    return
  }
  if (process.env.CMUX_WORKSPACE_ID || process.env.CMUX_SURFACE_ID) {
    openCmuxSplit(prompt, model, thinking, cwd, sessionDirectory, forkContext)
    return
  }
  if (process.env.TMUX) {
    openTmuxSplit(prompt, model, thinking, cwd, sessionDirectory, forkContext)
    return
  }
  if (isWarpTerminal()) {
    openWarpSplit(prompt, model, thinking, cwd, sessionDirectory, forkContext)
    return
  }

  throw new Error('Not inside Herdr, cmux, tmux, or Warp')
}
