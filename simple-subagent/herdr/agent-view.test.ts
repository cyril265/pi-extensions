import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { hideSubagents } from './agent-view.ts'

type Request = {
  id: string
  method: string
  params: Record<string, unknown>
}

type Response = {
  result?: {
    type: 'agent_view'
    active: boolean
    source?: string
  }
  error?: object
}

const pluginId = 'local.simple-subagent'
const pluginSource = `plugin:${pluginId}`

async function withFakeHerdr(
  respond: (request: Request) => Response,
  run: (socketPath: string, requests: Request[]) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'simple-subagent-agent-view-'))
  const socketPath = path.join(directory, 'herdr.sock')
  const requests: Request[] = []
  const server = createServer(socket => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        const request = JSON.parse(line) as Request
        requests.push(request)
        socket.write(`${JSON.stringify({ id: request.id, ...respond(request) })}\n`)
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })

  try {
    await run(socketPath, requests)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true })
  }
}

test('hide installs the simple-subagent filter directly', async () => {
  await withFakeHerdr(
    () => ({
      result: { type: 'agent_view', active: true, source: pluginSource },
    }),
    async (socketPath, requests) => {
      await hideSubagents(socketPath, pluginId)
      assert.deepEqual(requests, [
        {
          id: requests[0].id,
          method: 'agent.view.set',
          params: {
            source: pluginSource,
            label: 'subagents hidden',
            filter: {
              op: 'not',
              filter: { op: 'exists', field: { token: 'simple_subagent' } },
            },
          },
        },
      ])
    },
  )
})

test('hide fails when Herdr rejects the projection', async () => {
  await withFakeHerdr(
    () => ({ error: { code: 'plugin_not_found', message: 'plugin not found' } }),
    async socketPath => {
      await assert.rejects(
        hideSubagents(socketPath, pluginId),
        new RegExp(
          `plugin not found\\. Run: herdr plugin link ${path.resolve(import.meta.dirname, '..')} && herdr integration install pi`,
        ),
      )
    },
  )
})

test('hide fails when Herdr does not activate the projection', async () => {
  await withFakeHerdr(
    () => ({
      result: { type: 'agent_view', active: true, source: 'plugin:another-plugin' },
    }),
    async socketPath => {
      await assert.rejects(
        hideSubagents(socketPath, pluginId),
        /did not activate the simple-subagent Agents view\. Run: herdr plugin link/,
      )
    },
  )
})
