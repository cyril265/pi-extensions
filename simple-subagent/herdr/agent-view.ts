import { createConnection } from 'node:net'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

type AgentViewResult = {
  type: 'agent_view'
  active: boolean
  source?: string
}

type ApiResponse = {
  id: string
  result?: AgentViewResult
  error?: { code?: string; message?: string }
}

let requestSequence = 0
const pluginPath = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const setupGuidance = `Run: herdr plugin link ${pluginPath} && herdr integration install pi`

async function requestAgentView(
  socketPath: string,
  method: string,
  params: object,
): Promise<AgentViewResult> {
  const id = `simple-subagent:agent-view:${process.pid}:${requestSequence++}`
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    let settled = false

    const rejectOnce = (error: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error)
    }

    socket.setEncoding('utf8')
    socket.setTimeout(5000, () => rejectOnce(new Error('Timed out waiting for Herdr')))
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`)
    })
    socket.on('data', chunk => {
      buffer += chunk
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue

        let response: ApiResponse
        try {
          response = JSON.parse(line) as ApiResponse
        } catch {
          rejectOnce(new Error('Herdr returned malformed JSON'))
          return
        }
        if (response.id !== id) continue
        if (response.error) {
          rejectOnce(
            new Error(
              response.error.message || response.error.code || 'Herdr rejected the request',
            ),
          )
          return
        }
        if (response.result?.type !== 'agent_view') {
          rejectOnce(new Error('Herdr returned an unexpected response'))
          return
        }

        settled = true
        socket.end()
        resolve(response.result)
        return
      }
    })
    socket.on('error', error => rejectOnce(error))
    socket.on('end', () => {
      if (!settled) rejectOnce(new Error('Herdr closed the socket before responding'))
    })
  })
}

export async function hideSubagents(socketPath: string, pluginId: string): Promise<void> {
  const source = `plugin:${pluginId}`
  try {
    const result = await requestAgentView(socketPath, 'agent.view.set', {
      source,
      label: 'subagents hidden',
      filter: {
        op: 'not',
        filter: {
          op: 'exists',
          field: { token: 'simple_subagent' },
        },
      },
    })
    if (!(result.active && result.source === source)) {
      throw new Error('Herdr did not activate the simple-subagent Agents view')
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${reason}. ${setupGuidance}`)
  }
}
