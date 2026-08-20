import { formatWithOptions } from 'node:util'
import vm from 'node:vm'
import { parentPort, workerData } from 'node:worker_threads'

const TOOL_NAMES = [
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'find',
  'ls',
  'runSubAgents',
  'collectSubagents',
]

if (!parentPort) throw new Error('nodeScript worker requires a parent port')
if (!workerData || typeof workerData.code !== 'string') {
  throw new Error('nodeScript worker requires JavaScript source')
}

const pending = new Map()
const consoleLines = []
let nextCallId = 1

function serializeError(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    return {
      name: typeof error.name === 'string' ? error.name : 'Error',
      message: error.message,
      stack: typeof error.stack === 'string' ? error.stack : undefined,
    }
  }
  return { name: 'Error', message: String(error) }
}

function deserializeError(error) {
  const restored = new Error(error.message)
  restored.name = error.name || 'Error'
  if (error.stack) restored.stack = error.stack
  return restored
}

function callTool(tool, args) {
  const id = `call-${nextCallId++}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      parentPort.postMessage({ type: 'call', id, tool, args })
    } catch (error) {
      pending.delete(id)
      reject(error)
    }
  })
}

const tools = Object.freeze(
  Object.fromEntries(
    TOOL_NAMES.map(name => {
      const call = args => callTool(name, args)
      Object.freeze(call)
      return [name, call]
    }),
  ),
)

const capture = (...args) => {
  consoleLines.push(formatWithOptions({ colors: false, depth: 8 }, ...args))
}
const capturedConsole = Object.freeze({
  log: capture,
  info: capture,
  warn: capture,
  error: capture,
  debug: capture,
})

parentPort.on('message', message => {
  if (!message || typeof message !== 'object') return
  const call = pending.get(message.id)
  if (!call) return
  pending.delete(message.id)
  if (message.type === 'resolve') call.resolve(message.value)
  else if (message.type === 'reject') call.reject(deserializeError(message.error))
})

function formatReturnValue(value) {
  if (typeof value === 'string') return { returnOutput: value, returnType: 'string' }
  const json = JSON.stringify(value, null, 2)
  if (json === undefined) {
    throw new Error('nodeScript must return a string or JSON-serializable value')
  }
  return { returnOutput: json, returnType: 'json' }
}

async function run() {
  try {
    const context = vm.createContext({ tools, console: capturedConsole })
    const script = new vm.Script(
      `(async function nodeScriptMain(tools, console) {\n"use strict";\n${workerData.code}\n})(tools, console)`,
      { filename: 'nodeScript.js' },
    )
    const value = await script.runInContext(context)
    if (pending.size > 0) {
      parentPort.postMessage({
        type: 'unresolved',
        count: pending.size,
        consoleOutput: consoleLines.join('\n'),
      })
      return
    }
    parentPort.postMessage({
      type: 'complete',
      consoleOutput: consoleLines.join('\n'),
      ...formatReturnValue(value),
    })
  } catch (error) {
    parentPort.postMessage({
      type: 'failed',
      error: serializeError(error),
      consoleOutput: consoleLines.join('\n'),
    })
  }
}

void run()
