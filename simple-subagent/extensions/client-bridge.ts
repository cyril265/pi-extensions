import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Check, Errors } from 'typebox/value'
import type { SubagentJobResult } from './jobs.ts'
import {
  type IsolatedDispatchRequest,
  isolatedAgentsSchema,
  type RegisteredSubagentTools,
} from './tools.ts'

const ENDPOINT_ENV = 'PI_SIMPLE_SUBAGENT_ENDPOINT'
const TOKEN_ENV = 'PI_SIMPLE_SUBAGENT_TOKEN'
const CLIENT_ENV = 'PI_SIMPLE_SUBAGENT_CLIENT'
const CLIENT_URL = new URL('../client.mjs', import.meta.url).href

type Method = 'dispatch' | 'run'

type ClientRequest = { method: Method; agents: IsolatedDispatchRequest[] }

type ClientResponse =
  | { type: 'dispatch'; result: DispatchResult }
  | { type: 'run'; result: RunResult }
  | { type: 'error'; message: string }

type DispatchResult = {
  jobId: string
  agents: Array<{ name: string; sessionKey: string }>
}

type RunResult = {
  jobId: string
  isError: boolean
  text: string
  agents: Array<
    Omit<SubagentJobResult['details']['agents'][number], 'tools' | 'prompt'> & { output?: string }
  >
}

type ClientBridge = {
  attach(runtime: RegisteredSubagentTools): void
  registerClosureWait(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRequest(line: string, expectedToken: string): ClientRequest {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value)) throw new Error('Invalid request')
  if (value.version !== 1) throw new Error('Unsupported protocol version')
  if (value.token !== expectedToken) throw new Error('Authentication failed')
  if (value.method !== 'dispatch' && value.method !== 'run') throw new Error('Unknown method')
  if (!Check(isolatedAgentsSchema, value.params)) {
    const [error] = Errors(isolatedAgentsSchema, value.params)
    throw new Error(`agents${error.instancePath}: ${error.message}`)
  }
  return { method: value.method, agents: value.params }
}

function send(socket: Socket, response: ClientResponse): void {
  socket.write(`${JSON.stringify(response)}\n`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function toRunResult(jobId: string, result: SubagentJobResult): Promise<RunResult> {
  const agents = await Promise.all(
    result.details.agents.map(async ({ tools, prompt, ...agent }) =>
      agent.outputPath ? { ...agent, output: await readFile(agent.outputPath, 'utf8') } : agent,
    ),
  )
  return { jobId, isError: result.isError, text: result.text, agents }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      server.off('error', onError)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Client bridge did not bind a TCP port'))
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

export function registerClientBridge(pi: ExtensionAPI): ClientBridge {
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
    if (process.env[CLIENT_ENV] === CLIENT_URL) delete process.env[CLIENT_ENV]
  }

  const stopServer = (activeServer: Server) => {
    clearEnvironment()
    closure ??= close(activeServer)
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    if (server === activeServer) server = undefined
    context = undefined
  }

  const handleRequest = async (socket: Socket, { method, agents }: ClientRequest) => {
    if (!runtime || !context) throw new Error('Client bridge is not ready')
    const job = runtime.dispatchIsolated(agents, 'client', context)
    if (method === 'dispatch') {
      const agents = job.agents.map(({ name, sessionKey }) => ({ name, sessionKey }))
      send(socket, { type: 'dispatch', result: { jobId: job.id, agents } })
      socket.end()
      return
    }
    const controller = new AbortController()
    let joined = false
    socket.once('close', () => {
      if (!joined) controller.abort()
    })
    const result = await runtime.join(job.id, controller.signal)
    joined = true
    send(socket, { type: 'run', result: await toRunResult(job.id, result) })
    socket.end()
  }

  pi.on('session_start', async (_event, ctx) => {
    delete process.env[ENDPOINT_ENV]
    delete process.env[TOKEN_ENV]
    delete process.env[CLIENT_ENV]

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
        let request: ClientRequest
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
    process.env[CLIENT_ENV] = CLIENT_URL
    nextServer.on('error', error => {
      if (server !== nextServer) return
      ctx.ui.notify(`simple-subagent client bridge failed: ${error.message}`, 'error')
      stopServer(nextServer)
    })
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
