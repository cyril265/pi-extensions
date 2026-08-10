import { spawnSync } from 'node:child_process'
import type { ThinkingLevel } from './types.ts'

type HerdrResponse = {
  result?: {
    root_pane?: { pane_id?: string }
    tab?: { tab_id?: string }
  }
  error?: { code?: string; message?: string }
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
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
