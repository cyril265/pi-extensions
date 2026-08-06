import { writeFileSync } from 'node:fs'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

const EXTENSION_VERSION = '0.1.0'
const SIMPLE_SUBAGENT_PROCESS_ENV = 'PI_SIMPLE_SUBAGENT'
const WARP_SENTINEL_TITLE = 'warp://cli-agent'

const WARP_AGENT = 'pi'

type WarpAgentEvent =
  | 'session_start'
  | 'prompt_submit'
  | 'tool_complete'
  | 'stop'
  | 'permission_request'
  | 'permission_replied'
  | 'question_asked'
  | 'idle_prompt'

type WarpPayload = {
  v: 1
  agent: string
  event: WarpAgentEvent
  session_id: string
  cwd?: string
  project?: string
  query?: string
  response?: string
  summary?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  plugin_version?: string
}

let sessionId = `pi-${process.pid}-${Date.now()}`
let lastPrompt = 'Pi task'
let pendingPrompt = 'Pi task'
let sessionStarted = false
let agentRunning = false

const WARP_ORIGINAL_SELECT = '__piWarpNotificationsOriginalSelect'
const WARP_WRAPPED_SELECT = '__piWarpNotificationsWrappedSelect'
const SANDBOX_NETWORK_PROMPT = /^🌐 Network blocked: "(.+)" is not in allowedDomains$/
const SANDBOX_WRITE_PROMPT = /^📝 Write blocked: "(.+)" is not in allowWrite$/

type WarpWrappedUI = ExtensionContext['ui'] & {
  [WARP_ORIGINAL_SELECT]?: ExtensionContext['ui']['select']
  [WARP_WRAPPED_SELECT]?: ExtensionContext['ui']['select']
}

type SandboxPrompt = {
  summary: string
  toolName: string
  toolInput: Record<string, unknown>
}

function oscSafe(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/;/g, ',')
    .trim()
}

function getSessionId(ctx?: ExtensionContext): string {
  const sessionFile = ctx?.sessionManager.getSessionFile()
  if (sessionFile) return `pi-${sessionFile}`
  return sessionId
}

function projectName(cwd: string): string | undefined {
  const name = cwd.split(/[\\/]/).filter(Boolean).pop()
  return name || undefined
}

function shouldUseStructuredWarpNotifications(): boolean {
  return (
    process.env.TERM_PROGRAM === 'WarpTerminal' &&
    Boolean(process.env.WARP_CLI_AGENT_PROTOCOL_VERSION)
  )
}

function writeWarpOsc(body: string): void {
  const sequence = `\x1b]777;notify;${WARP_SENTINEL_TITLE};${body}\x07`
  try {
    writeFileSync('/dev/tty', sequence, { flag: 'a' })
  } catch {
    process.stdout.write(sequence)
  }
}

function sendWarpEvent(
  event: WarpAgentEvent,
  fields: Partial<WarpPayload> = {},
  ctx?: ExtensionContext,
): void {
  if (!shouldUseStructuredWarpNotifications()) return

  const cwd = fields.cwd ?? process.cwd()
  const payload: WarpPayload = {
    v: 1,
    agent: WARP_AGENT,
    event,
    session_id: fields.session_id ?? getSessionId(ctx),
    cwd,
    project: fields.project ?? projectName(cwd),
    plugin_version: `pi-warp-notifications-${EXTENSION_VERSION}`,
    ...fields,
  }

  writeWarpOsc(oscSafe(JSON.stringify(payload)))
}

function ensureSessionStarted(ctx?: ExtensionContext): void {
  if (sessionStarted) return
  sessionStarted = true
  sendWarpEvent('session_start', {}, ctx)
}

function sandboxPromptFromSelectTitle(title: string): SandboxPrompt | undefined {
  const networkMatch = title.match(SANDBOX_NETWORK_PROMPT)
  if (networkMatch) {
    const domain = networkMatch[1]
    return {
      summary: `Network blocked: ${domain}`,
      toolName: 'network',
      toolInput: { host: domain, operation: 'connect' },
    }
  }

  const writeMatch = title.match(SANDBOX_WRITE_PROMPT)
  if (writeMatch) {
    const path = writeMatch[1]
    return {
      summary: `Write blocked: ${path}`,
      toolName: 'filesystem',
      toolInput: { path, operation: 'write' },
    }
  }

  return undefined
}

function emitSandboxInputNeeded(prompt: SandboxPrompt, ctx: ExtensionContext): void {
  ensureSessionStarted(ctx)

  // Do not use permission_request here. Older Warp builds store
  // permission_request.summary as title-like text, which can leave the tab
  // titled "Network blocked: ..." after the sandbox dialog closes.
  sendWarpEvent(
    'question_asked',
    {
      summary: prompt.summary,
      tool_name: prompt.toolName,
      tool_input: prompt.toolInput,
    },
    ctx,
  )
}

function emitSandboxInputResolved(prompt: SandboxPrompt, ctx: ExtensionContext): void {
  sendWarpEvent('permission_replied', { tool_name: prompt.toolName }, ctx)
}

function wrapSandboxPermissionPrompts(ctx: ExtensionContext): void {
  const ui = ctx.ui as WarpWrappedUI
  ui[WARP_ORIGINAL_SELECT] ??= ui.select.bind(ui)
  const originalSelect = ui[WARP_ORIGINAL_SELECT]
  if (!originalSelect) throw new Error('Could not preserve the original select handler.')

  const wrappedSelect: ExtensionContext['ui']['select'] = async (title, options, opts) => {
    const prompt = sandboxPromptFromSelectTitle(title)
    if (prompt) emitSandboxInputNeeded(prompt, ctx)

    try {
      return await originalSelect(title, options, opts)
    } finally {
      if (prompt) emitSandboxInputResolved(prompt, ctx)
    }
  }

  ui[WARP_WRAPPED_SELECT] = wrappedSelect
  ui.select = wrappedSelect
}

function restoreSandboxPermissionPrompts(ctx: ExtensionContext): void {
  const ui = ctx.ui as WarpWrappedUI
  if (ui.select === ui[WARP_WRAPPED_SELECT] && ui[WARP_ORIGINAL_SELECT]) {
    ui.select = ui[WARP_ORIGINAL_SELECT]
  }
  delete ui[WARP_WRAPPED_SELECT]
  delete ui[WARP_ORIGINAL_SELECT]
}

export default function (pi: ExtensionAPI) {
  if (process.env[SIMPLE_SUBAGENT_PROCESS_ENV] === '1') return

  pi.on('session_start', async (_event, ctx) => {
    sessionId = `pi-${process.pid}-${Date.now()}`
    sessionStarted = false
    agentRunning = false
    wrapSandboxPermissionPrompts(ctx)
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    restoreSandboxPermissionPrompts(ctx)
  })

  pi.on('before_agent_start', async event => {
    pendingPrompt = event.prompt.trim() || 'Pi task'
  })

  pi.on('agent_start', async (_event, ctx) => {
    ensureSessionStarted(ctx)
    agentRunning = true
    lastPrompt = pendingPrompt
    sendWarpEvent('prompt_submit', { query: lastPrompt }, ctx)
  })

  pi.on('agent_end', async (_event, ctx) => {
    if (!agentRunning) return
    agentRunning = false
    sendWarpEvent(
      'stop',
      {
        query: lastPrompt,
        summary: lastPrompt,
        response: 'Ready for input',
      },
      ctx,
    )
  })

  pi.registerCommand('warpnotify-test', {
    description: "Send a test notification to Warp's agent inbox",
    handler: async (args, ctx) => {
      ensureSessionStarted(ctx)
      const summary = args.trim() || 'Pi Warp notification test'
      sendWarpEvent('stop', { query: summary, summary, response: 'Ready for input' }, ctx)
      ctx.ui.notify('Sent Warp inbox test event', 'info')
    },
  })
}
