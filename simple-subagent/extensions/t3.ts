import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { SimpleSubagentConfig } from './config.ts'

const URL_ENV = 'T3_MCP_URL'
const TOKEN_ENV = 'T3_MCP_BEARER_TOKEN'
const PROTOCOL_VERSION = '2025-06-18'
const REQUEST_TIMEOUT_MS = 15_000

type JsonRpcResponse = {
  id?: number
  result?: unknown
  error?: { message?: string }
}

type McpToolResult = {
  content?: Array<{ type?: string; text?: string }>
  structuredContent?: unknown
  isError?: boolean
}

function environmentValue(name: string): string | undefined {
  const value = process.env[name]
  return value && value.length > 0 ? value : undefined
}

export function registerT3Delegation(pi: ExtensionAPI, config: SimpleSubagentConfig): boolean {
  if (!environmentValue(URL_ENV) || !environmentValue(TOKEN_ENV)) return false

  delete process.env.PI_SIMPLE_SUBAGENT_CLIENT
  delete process.env.PI_SIMPLE_SUBAGENT_ENDPOINT
  delete process.env.PI_SIMPLE_SUBAGENT_TOKEN

  pi.on('before_agent_start', event => {
    const aliases = Object.entries(config.modelAliases).map(
      ([alias, model]) => `${alias}: ${model}`,
    )
    event.systemPromptOptions.sections.t3_delegation = [
      'This Pi session runs inside T3 Code. For subagents, use mcp__t3-code__delegate_task so each child has a T3 thread the user can open.',
      'Before selecting a model, call mcp__t3-code__orchestrator_capabilities. Resolve requested model names and aliases to a provider instance and model from that catalog.',
      ...(aliases.length ? ['Local model aliases for catalog lookup:', ...aliases] : []),
      'Simple-subagent tools and its Node client are unavailable here. If a requested model is absent from the T3 catalog, report that rather than starting a separate Pi process.',
    ].join('\n')
  })
  return true
}

function parseResponse(body: string, contentType: string): JsonRpcResponse {
  if (!contentType.includes('text/event-stream')) return JSON.parse(body)

  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    const value = line.slice(5).trim()
    if (!value) continue
    const response = JSON.parse(value) as JsonRpcResponse
    if (
      response.id !== undefined ||
      response.result !== undefined ||
      response.error !== undefined
    ) {
      return response
    }
  }
  throw new Error('T3 MCP response contained no JSON-RPC result')
}

function toolError(result: McpToolResult): string {
  const text = result.content?.find(part => part.type === 'text')?.text
  return text || 'T3 MCP tool failed'
}

function threadIdFrom(result: McpToolResult): string {
  if (
    typeof result.structuredContent === 'object' &&
    result.structuredContent !== null &&
    'threadId' in result.structuredContent &&
    typeof result.structuredContent.threadId === 'string'
  ) {
    return result.structuredContent.threadId
  }

  const text = result.content?.find(part => part.type === 'text')?.text
  if (text) {
    const parsed: unknown = JSON.parse(text)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'threadId' in parsed &&
      typeof parsed.threadId === 'string'
    ) {
      return parsed.threadId
    }
  }
  throw new Error('T3 thread configuration returned no threadId')
}

class T3McpClient {
  private nextId = 1
  private sessionId: string | undefined
  private readonly endpoint: string
  private readonly token: string
  private readonly signal: AbortSignal

  constructor(endpoint: string, token: string, signal: AbortSignal) {
    this.endpoint = endpoint
    this.token = token
    this.signal = signal
  }

  async connect(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'simple-subagent', version: '1.0.0' },
    })
    await this.notify('notifications/initialized', {})
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.request('tools/call', { name, arguments: args })
    if (typeof result !== 'object' || result === null) {
      throw new Error(`T3 MCP tool ${name} returned no result`)
    }
    const toolResult = result as McpToolResult
    if (toolResult.isError) throw new Error(toolError(toolResult))
    return toolResult
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      authorization: this.token.startsWith('Bearer ') ? this.token : `Bearer ${this.token}`,
      'content-type': 'application/json',
      'mcp-protocol-version': PROTOCOL_VERSION,
    }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    return headers
  }

  private async post(payload: Record<string, unknown>): Promise<Response> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: this.signal,
    })
    this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId
    if (!response.ok) throw new Error(`T3 MCP request failed with status ${response.status}`)
    return response
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const response = await this.post({ jsonrpc: '2.0', id, method, params })
    const body = await response.text()
    if (!body) throw new Error(`T3 MCP ${method} returned an empty response`)
    const parsed = parseResponse(body, response.headers.get('content-type') ?? '')
    if (parsed.error) throw new Error(parsed.error.message ?? `T3 MCP ${method} failed`)
    return parsed.result
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, params })
  }
}

export async function sendT3ThreadMessage(message: string): Promise<boolean> {
  const endpoint = environmentValue(URL_ENV)
  const token = environmentValue(TOKEN_ENV)
  if (!endpoint && !token) return false
  if (!endpoint || !token) {
    throw new Error(`${URL_ENV} and ${TOKEN_ENV} must both be set`)
  }

  const client = new T3McpClient(endpoint, token, AbortSignal.timeout(REQUEST_TIMEOUT_MS))
  await client.connect()
  const configuration = await client.callTool('t3_thread_configuration', {})
  await client.callTool('t3_thread_send', {
    threadId: threadIdFrom(configuration),
    message,
    mode: 'auto',
  })
  return true
}
