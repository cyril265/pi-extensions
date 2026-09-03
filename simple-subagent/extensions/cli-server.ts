import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { SubagentJobResult } from './jobs.ts'
import type { RegisteredSubagentTools } from './tools.ts'
import type { ThinkingLevel } from './types.ts'

const ENDPOINT_ENV = 'PI_SIMPLE_SUBAGENT_ENDPOINT'
const TOKEN_ENV = 'PI_SIMPLE_SUBAGENT_TOKEN'
const NODE_ENV = 'PI_SIMPLE_SUBAGENT_NODE'
type CliThinkingLevel = Exclude<ThinkingLevel, 'off' | 'minimal'>
const thinkingLevels = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max'])

function getCliPrompt(modelAliases: Record<string, string>): string {
  const aliases = Object.keys(modelAliases)
  const modelUsage = aliases.length > 0
    ? `Use \`--model ALIAS_OR_PROVIDER/MODEL\` to override the parent model. Available aliases: ${aliases.map(alias => `\`${alias}\``).join(', ')}.`
    : 'Use `--model PROVIDER/MODEL` to override the parent model.'

  return `Subagents: \`subagent dispatch\` and \`subagent run\` each read one self-contained prompt from stdin and start one agent. The child does not inherit this conversation. Use \`subagent dispatch --name NAME --thinking LEVEL\` for asynchronous work; its result arrives automatically. Use \`subagent run --name NAME --thinking LEVEL\` to wait and receive the response on stdout. Use shell background jobs for parallel agents. \`LEVEL\` is \`low\`, \`medium\`, \`high\`, \`xhigh\`, or \`max\`. Use \`--cwd PATH\` for another working directory. ${modelUsage} Use \`--session-key KEY\` to name or resume a child session. Cancel a running job with \`subagent cancel JOB_ID\`.`
}

type DispatchParams = {
  name: string
  prompt: string
  thinking: CliThinkingLevel
  cwd: string
  overrideModel?: string
  sessionKey?: string
}

type CliRequest =
  | { version: 1; token: string; method: 'dispatch'; params: DispatchParams }
  | { version: 1; token: string; method: 'run'; params: DispatchParams }
  | { version: 1; token: string; method: 'cancel'; params: { jobId: string } }

type CliResponse =
  | { type: 'started'; jobId: string; sessionKey: string }
  | { type: 'result'; output: string; isError: boolean }
  | { type: 'cancelled'; jobId: string }
  | { type: 'error'; message: string }

type CliBridge = {
  attach(runtime: RegisteredSubagentTools): void
  registerClosureWait(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(record: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(record).every(key => keys.includes(key))
}

function isCliThinkingLevel(value: unknown): value is CliThinkingLevel {
  return typeof value === 'string' && thinkingLevels.has(value)
}

function parseDispatchParams(value: unknown): DispatchParams {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'name',
    'prompt',
    'thinking',
    'cwd',
    'overrideModel',
    'sessionKey',
  ])) {
    throw new Error('Invalid dispatch parameters')
  }
  if (typeof value.name !== 'string' || !value.name.trim()) throw new Error('name is required')
  if (typeof value.prompt !== 'string' || !value.prompt.trim()) throw new Error('prompt is required')
  if (!isCliThinkingLevel(value.thinking)) {
    throw new Error('thinking must be low, medium, high, xhigh, or max')
  }
  if (typeof value.cwd !== 'string' || !isAbsolute(value.cwd)) {
    throw new Error('cwd must be an absolute path')
  }
  if (value.overrideModel !== undefined && (typeof value.overrideModel !== 'string' || !value.overrideModel.trim())) {
    throw new Error('model must not be empty')
  }
  if (value.sessionKey !== undefined && (typeof value.sessionKey !== 'string' || !value.sessionKey.trim())) {
    throw new Error('session key must not be empty')
  }
  return {
    name: value.name,
    prompt: value.prompt,
    thinking: value.thinking,
    cwd: value.cwd,
    ...(value.overrideModel === undefined ? {} : { overrideModel: value.overrideModel }),
    ...(value.sessionKey === undefined ? {} : { sessionKey: value.sessionKey }),
  }
}

function parseRequest(line: string, expectedToken: string): CliRequest {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value) || !hasOnlyKeys(value, ['version', 'token', 'method', 'params'])) {
    throw new Error('Invalid request')
  }
  if (value.version !== 1) throw new Error('Unsupported protocol version')
  if (typeof value.token !== 'string' || value.token !== expectedToken) {
    throw new Error('Authentication failed')
  }
  if (value.method === 'dispatch' || value.method === 'run') {
    return {
      version: 1,
      token: value.token,
      method: value.method,
      params: parseDispatchParams(value.params),
    }
  }
  if (value.method === 'cancel') {
    if (
      !isRecord(value.params) ||
      !hasOnlyKeys(value.params, ['jobId']) ||
      typeof value.params.jobId !== 'string' ||
      !value.params.jobId
    ) {
      throw new Error('jobId is required')
    }
    return { version: 1, token: value.token, method: 'cancel', params: { jobId: value.params.jobId } }
  }
  throw new Error('Unknown method')
}

function send(socket: Socket, response: CliResponse): void {
  socket.write(`${JSON.stringify(response)}\n`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readCliRunOutput(result: SubagentJobResult): Promise<string> {
  const outputPath = result.details.agents[0]?.outputPath
  if (outputPath) return readFile(outputPath, 'utf8')
  if (result.isError) return result.text
  throw new Error('Successful subagent job has no output path')
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      server.off('error', onError)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('CLI server did not bind a TCP port'))
        return
      }
      resolve(address.port)
    })
  })
}

function close(server: Server): Promise<Error | undefined> {
  return new Promise(resolve => {
    server.close(error => resolve(error ?? undefined))
  })
}

function addBinToPath(): void {
  const binDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin')
  const entries = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  if (!entries.includes(binDirectory)) process.env.PATH = [binDirectory, ...entries].join(delimiter)
}

export function registerCliBridge(
  pi: ExtensionAPI,
  modelAliases: Record<string, string>,
): CliBridge {
  let runtime: RegisteredSubagentTools | undefined
  let server: Server | undefined
  let context: ExtensionContext | undefined
  let token: string | undefined
  let endpoint: string | undefined
  let closure: Promise<Error | undefined> | undefined
  const sockets = new Set<Socket>()

  const clearEnvironment = () => {
    if (endpoint && process.env[ENDPOINT_ENV] === endpoint) delete process.env[ENDPOINT_ENV]
    if (token && process.env[TOKEN_ENV] === token) delete process.env[TOKEN_ENV]
    if (process.env[NODE_ENV] === process.execPath) delete process.env[NODE_ENV]
  }

  const stopServer = (activeServer: Server) => {
    clearEnvironment()
    closure ??= close(activeServer)
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    if (server === activeServer) server = undefined
    context = undefined
  }

  const handleRequest = async (socket: Socket, request: CliRequest) => {
    if (!runtime || !context) throw new Error('CLI bridge is not ready')

    if (request.method === 'cancel') {
      if (!runtime.cancel(request.params.jobId)) {
        throw new Error(`No running subagent job ${request.params.jobId}`)
      }
      send(socket, { type: 'cancelled', jobId: request.params.jobId })
      socket.end()
      return
    }

    const job = runtime.dispatchIsolated([request.params], 'cli', context)
    const agent = job.agents[0]
    const started: CliResponse = { type: 'started', jobId: job.id, sessionKey: agent.sessionKey }
    if (request.method === 'dispatch') {
      send(socket, started)
      socket.end()
      return
    }

    const controller = new AbortController()
    let joined = false
    socket.once('close', () => {
      if (!joined) controller.abort()
    })
    const resultPromise = runtime.join(job.id, controller.signal)
    send(socket, started)
    const result = await resultPromise
    joined = true
    if (!result) throw new Error(`Job ${job.id} has no undelivered result`)
    const output = await readCliRunOutput(result)
    send(socket, { type: 'result', output, isError: result.isError })
    socket.end()
  }

  pi.on('session_start', async (_event, ctx) => {
    delete process.env[ENDPOINT_ENV]
    delete process.env[TOKEN_ENV]
    delete process.env[NODE_ENV]

    const nextToken = randomBytes(32).toString('base64url')
    const nextServer = createServer(socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('error', () => {})
      let input = ''
      let handled = false
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        if (handled) return
        input += chunk
        const newline = input.indexOf('\n')
        if (newline < 0) return
        handled = true
        let request: CliRequest
        try {
          request = parseRequest(input.slice(0, newline), nextToken)
        } catch (error) {
          send(socket, { type: 'error', message: errorMessage(error) })
          socket.end()
          return
        }
        void handleRequest(socket, request).catch(error => {
          if (socket.destroyed) return
          send(socket, { type: 'error', message: errorMessage(error) })
          socket.end()
        })
      })
    })

    let port: number
    try {
      port = await listen(nextServer)
    } catch (error) {
      nextServer.close()
      throw error
    }

    const nextEndpoint = `tcp://127.0.0.1:${port}`
    server = nextServer
    context = ctx
    token = nextToken
    endpoint = nextEndpoint
    process.env[ENDPOINT_ENV] = nextEndpoint
    process.env[TOKEN_ENV] = nextToken
    process.env[NODE_ENV] = process.execPath
    addBinToPath()
    nextServer.on('error', error => {
      if (server !== nextServer) return
      ctx.ui.notify(`simple-subagent CLI server failed: ${error.message}`, 'error')
      stopServer(nextServer)
    })
  })

  pi.on('before_agent_start', event => {
    if (!server) return
    return { systemPrompt: `${event.systemPrompt}\n\n${getCliPrompt(modelAliases)}` }
  })

  pi.on('session_shutdown', () => {
    clearEnvironment()
    if (server) stopServer(server)
  })

  return {
    attach(nextRuntime) {
      runtime = nextRuntime
    },
    registerClosureWait() {
      pi.on('session_shutdown', async () => {
        const error = await closure
        closure = undefined
        if (error) throw error
      })
    },
  }
}
