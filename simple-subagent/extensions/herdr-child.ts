import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Message } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  cloneToolArgs,
  dedupeToolDisplayItems,
  getFinalOutput,
  getToolDisplayItems,
} from './tool-events.ts'
import type { SubagentRunResult, ToolDisplayItem } from './types.ts'
import { addAssistantUsage, createUsageStats, getAssistantContextTokens } from './usage.ts'

const HERDR_RESULT_PATH_ENV = 'PI_SIMPLE_SUBAGENT_HERDR_RESULT_PATH'
const HERDR_EVENT_PATH_ENV = 'PI_SIMPLE_SUBAGENT_HERDR_EVENT_PATH'
const HERDR_ABORT_PATH_ENV = 'PI_SIMPLE_SUBAGENT_HERDR_ABORT_PATH'
const HERDR_PROMPT_PATH_ENV = 'PI_SIMPLE_SUBAGENT_HERDR_PROMPT_PATH'
const HERDR_START_PATH_ENV = 'PI_SIMPLE_SUBAGENT_HERDR_START_PATH'

type HerdrBridgeResult = { ok: true; result: SubagentRunResult } | { ok: false; error: string }

function writeAtomic(filePath: string, value: HerdrBridgeResult): void {
  if (fs.existsSync(filePath)) return
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { flag: 'wx' })
  try {
    fs.renameSync(temporaryPath, filePath)
  } catch (error) {
    fs.unlinkSync(temporaryPath)
    if (!fs.existsSync(filePath)) throw error
  }
}

function getRunResult(messages: Message[], liveTools: ToolDisplayItem[]): SubagentRunResult {
  const usage = createUsageStats()
  let firstTurnUsage: SubagentRunResult['firstTurnUsage'] | undefined
  let contextTokens: number | undefined

  for (const message of messages) {
    if (message.role !== 'assistant') continue
    if (!firstTurnUsage) {
      firstTurnUsage = {
        input: message.usage.input,
        output: message.usage.output,
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
      }
    }
    contextTokens = getAssistantContextTokens(message) ?? contextTokens
    addAssistantUsage(usage, message)
  }

  if (!firstTurnUsage) throw new Error('Subagent produced no assistant usage')
  const finalOutput = getFinalOutput(messages).trim()
  const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant')
  const failed =
    lastAssistant?.role === 'assistant' &&
    (lastAssistant.stopReason === 'error' || lastAssistant.stopReason === 'aborted')

  return {
    text: finalOutput || '(no output)',
    exitCode: failed ? 1 : 0,
    tools: dedupeToolDisplayItems([...liveTools, ...getToolDisplayItems(messages)]),
    usage,
    contextTokens,
    firstTurnUsage,
  }
}

export function registerHerdrChildBridge(pi: ExtensionAPI): void {
  const resultPath = process.env[HERDR_RESULT_PATH_ENV]
  const eventPath = process.env[HERDR_EVENT_PATH_ENV]
  const abortPath = process.env[HERDR_ABORT_PATH_ENV]
  const promptPath = process.env[HERDR_PROMPT_PATH_ENV]
  const startPath = process.env[HERDR_START_PATH_ENV]
  if (!(resultPath && eventPath && abortPath && promptPath && startPath)) return

  let messages: Message[] | undefined
  const liveTools: ToolDisplayItem[] = []
  let abortTimer: NodeJS.Timeout | undefined
  let startTimer: NodeJS.Timeout | undefined

  pi.on('session_start', (_event, ctx) => {
    abortTimer = setInterval(() => {
      if (!fs.existsSync(abortPath)) return
      if (ctx.isIdle()) return
      clearInterval(abortTimer)
      abortTimer = undefined
      ctx.abort()
    }, 100)

    // Stay idle until the runner signals that `herdr agent start` reported the
    // managed agent as ready; dispatching earlier makes Herdr's readiness
    // check race the first turn and time out.
    startTimer = setInterval(() => {
      if (fs.existsSync(abortPath)) {
        clearInterval(startTimer)
        startTimer = undefined
        return
      }
      if (!fs.existsSync(startPath)) return
      clearInterval(startTimer)
      startTimer = undefined
      pi.sendUserMessage(fs.readFileSync(promptPath, 'utf8'))
    }, 100)
  })

  pi.on('tool_execution_start', event => {
    const tool = { name: event.toolName, args: cloneToolArgs(event.args) }
    liveTools.push(tool)
    fs.appendFileSync(eventPath, `${JSON.stringify({ type: 'tool', tool })}\n`)
  })

  pi.on('agent_end', event => {
    messages = event.messages.filter(
      (message): message is Message =>
        message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult',
    )
  })

  pi.on('agent_settled', () => {
    if (abortTimer) {
      clearInterval(abortTimer)
      abortTimer = undefined
    }
    if (!messages) return
    try {
      writeAtomic(resultPath, { ok: true, result: getRunResult(messages, liveTools) })
    } catch (error) {
      writeAtomic(resultPath, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  pi.on('session_shutdown', () => {
    if (abortTimer) clearInterval(abortTimer)
    if (startTimer) clearInterval(startTimer)
    writeAtomic(resultPath, { ok: false, error: 'Subagent session closed before completion' })
  })
}
