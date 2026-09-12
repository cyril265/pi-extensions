import { connect } from 'node:net'

/**
 * @typedef {object} Agent
 * @property {string} name
 * @property {string} prompt
 * @property {string} cwd absolute path
 * @property {'low'|'medium'|'high'|'xhigh'|'max'} thinking
 * @property {string} [overrideModel] configured alias or provider/model; omit to inherit the parent model
 * @property {string} [sessionKey] reuse to continue a child session; omit to generate one
 */

/**
 * @typedef {object} AgentResult
 * @property {string} name
 * @property {string} sessionKey
 * @property {'done'|'failed'|'interrupted'} status
 * @property {string} [output] the agent's final response; absent when no result was recorded
 * @property {number} [exitCode]
 * @property {string} [sessionId]
 * @property {string} [sessionPath] resume with `pi --session <sessionPath>`
 * @property {string} [outputPath]
 * @property {string} [effectiveModel]
 * @property {{ input: number, output: number, cacheRead: number, cacheWrite: number, cost: number, turns: number }} [usage]
 */

/**
 * @typedef {object} RunResult
 * @property {string} jobId
 * @property {boolean} isError true when any agent failed or was interrupted; always check it
 * @property {string} text the same report the runSubAgents tool would deliver, including failure reasons
 * @property {AgentResult[]} agents in the order of the request
 */

/**
 * @typedef {object} DispatchResult
 * @property {string} jobId
 * @property {Array<{ name: string, sessionKey: string }>} agents
 */

/**
 * Start isolated subagents and return immediately, like the runSubAgents tool.
 * The result is delivered to the parent conversation as a message when every
 * agent finishes.
 *
 * @param {Agent[]} agents
 * @returns {Promise<DispatchResult>}
 */
export async function dispatch(agents) {
  return request('dispatch', agents)
}

/**
 * Start isolated subagents and wait for all of them.
 *
 * The same `cwd + sessionKey` cannot run twice in parallel; sequential reuse
 * works. Rejects on connection, authentication, or validation errors; a failed
 * agent is reported through `isError`, not by rejecting.
 *
 * @param {Agent[]} agents
 * @returns {Promise<RunResult>}
 */
export async function run(agents) {
  return request('run', agents)
}

function request(method, agents) {
  const endpoint = process.env.PI_SIMPLE_SUBAGENT_ENDPOINT
  const token = process.env.PI_SIMPLE_SUBAGENT_TOKEN
  if (!endpoint || !token) {
    throw new Error('simple-subagent client is available only inside a live Pi session')
  }
  const url = new URL(endpoint)
  if (url.protocol !== 'tcp:' || url.hostname !== '127.0.0.1' || !url.port) {
    throw new Error('PI_SIMPLE_SUBAGENT_ENDPOINT is invalid')
  }

  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: Number(url.port) })
    let buffer = ''
    let settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true
      socket.destroy()
      error ? reject(error) : resolve(result)
    }
    socket.setEncoding('utf8')
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ version: 1, token, method, params: agents })}\n`)
    })
    socket.on('data', chunk => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      let response
      try {
        response = JSON.parse(buffer.slice(0, newline))
      } catch {
        finish(new Error('simple-subagent returned invalid JSON'))
        return
      }
      if (response.type === 'error') finish(new Error(response.message))
      else if (response.type === method) finish(undefined, response.result)
      else finish(new Error('simple-subagent returned an unexpected response'))
    })
    socket.once('error', finish)
    socket.once('close', () => finish(new Error('simple-subagent closed the connection before replying')))
  })
}
