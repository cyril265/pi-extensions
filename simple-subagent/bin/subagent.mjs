#!/usr/bin/env node
import { connect } from 'node:net'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

const thinkingLevels = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

function usageError(message) {
  const error = new Error(message)
  error.exitCode = 2
  return error
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw usageError(`${name} is required`)
  return value
}

function parseAgentCommand(command, args) {
  let parsed
  try {
    parsed = parseArgs({
      args,
      options: {
        name: { type: 'string' },
        thinking: { type: 'string' },
        cwd: { type: 'string' },
        model: { type: 'string' },
        'session-key': { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    })
  } catch (error) {
    throw usageError(error.message)
  }

  const name = requiredString(parsed.values.name, '--name')
  const thinking = requiredString(parsed.values.thinking, '--thinking')
  if (!thinkingLevels.has(thinking)) {
    throw usageError('--thinking must be low, medium, high, xhigh, or max')
  }
  const cwd = resolve(parsed.values.cwd ?? process.cwd())
  const overrideModel = parsed.values.model ?? (
    process.env.PI_PROVIDER && process.env.PI_MODEL
      ? `${process.env.PI_PROVIDER}/${process.env.PI_MODEL}`
      : undefined
  )
  if (overrideModel !== undefined) requiredString(overrideModel, '--model')
  if (parsed.values['session-key'] !== undefined) {
    requiredString(parsed.values['session-key'], '--session-key')
  }

  return {
    command,
    params: {
      name,
      thinking,
      cwd,
      ...(overrideModel === undefined ? {} : { overrideModel }),
      ...(parsed.values['session-key'] === undefined
        ? {}
        : { sessionKey: parsed.values['session-key'] }),
    },
  }
}

function parseCommand(argv) {
  const [command, ...args] = argv
  if (command === 'dispatch' || command === 'run') return parseAgentCommand(command, args)
  if (command === 'cancel') {
    let parsed
    try {
      parsed = parseArgs({ args, options: {}, allowPositionals: true, strict: true })
    } catch (error) {
      throw usageError(error.message)
    }
    if (parsed.positionals.length !== 1) throw usageError('Usage: subagent cancel <jobId>')
    return {
      command: 'cancel',
      params: { jobId: requiredString(parsed.positionals[0], 'jobId') },
    }
  }
  throw usageError('Usage: subagent <dispatch|run|cancel>')
}

async function readPrompt() {
  let prompt = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) prompt += chunk
  if (!prompt.trim()) throw usageError('Prompt stdin is empty')
  return prompt
}

function connectionSettings() {
  const endpoint = process.env.PI_SIMPLE_SUBAGENT_ENDPOINT
  const token = process.env.PI_SIMPLE_SUBAGENT_TOKEN
  if (!endpoint || !token) throw new Error('subagent is available only inside a live Pi session')
  let url
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error('PI_SIMPLE_SUBAGENT_ENDPOINT is invalid')
  }
  if (url.protocol !== 'tcp:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '') {
    throw new Error('PI_SIMPLE_SUBAGENT_ENDPOINT is invalid')
  }
  return { port: Number(url.port), token }
}

function request(settings, message, onResponse) {
  return new Promise((resolveRequest, reject) => {
    const socket = connect({ host: '127.0.0.1', port: settings.port })
    let buffer = ''
    let settled = false
    const fail = error => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error)
    }
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(`${JSON.stringify({
      version: 1,
      token: settings.token,
      method: message.command,
      params: message.params,
    })}\n`))
    socket.on('data', chunk => {
      buffer += chunk
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let response
        try {
          response = JSON.parse(line)
        } catch {
          fail(new Error('CLI server returned invalid JSON'))
          return
        }
        try {
          if (onResponse(response)) {
            settled = true
            socket.end()
            resolveRequest()
            return
          }
        } catch (error) {
          fail(error)
          return
        }
      }
    })
    socket.once('error', fail)
    socket.once('close', () => {
      if (!settled) fail(new Error('CLI server closed the connection before replying'))
    })
  })
}

function isStarted(response) {
  return response && response.type === 'started' && typeof response.jobId === 'string' && typeof response.sessionKey === 'string'
}

function throwServerError(response) {
  if (response && response.type === 'error' && typeof response.message === 'string') {
    throw new Error(response.message)
  }
}

async function main() {
  const command = parseCommand(process.argv.slice(2))
  if (command.command !== 'cancel') command.params.prompt = await readPrompt()
  const settings = connectionSettings()

  if (command.command === 'dispatch') {
    await request(settings, command, response => {
      throwServerError(response)
      if (!isStarted(response)) throw new Error('CLI server returned an invalid response')
      process.stdout.write(`jobId: ${response.jobId}\nsessionKey: ${response.sessionKey}\n`)
      return true
    })
    return
  }

  if (command.command === 'cancel') {
    await request(settings, command, response => {
      throwServerError(response)
      if (!response || response.type !== 'cancelled' || response.jobId !== command.params.jobId) {
        throw new Error('CLI server returned an invalid response')
      }
      return true
    })
    return
  }

  let started = false
  let failed = false
  await request(settings, command, response => {
    throwServerError(response)
    if (!started) {
      if (!isStarted(response)) throw new Error('CLI server returned an invalid response')
      started = true
      process.stderr.write(`jobId: ${response.jobId}\nsessionKey: ${response.sessionKey}\n`)
      return false
    }
    if (!response || response.type !== 'result' || typeof response.output !== 'string' || typeof response.isError !== 'boolean') {
      throw new Error('CLI server returned an invalid response')
    }
    process.stdout.write(response.output)
    failed = response.isError
    return true
  })
  if (failed) process.exitCode = 1
}

try {
  await main()
} catch (error) {
  process.stderr.write(`subagent: ${error.message}\n`)
  process.exitCode = error.exitCode === 2 ? 2 : 1
}
