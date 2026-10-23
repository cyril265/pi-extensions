import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Message, ModelsSimpleStreamOptions } from '@earendil-works/pi-ai'
import {
  buildSessionContext,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  ExtensionRunner,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent'

type CompactionPreparation = SessionBeforeCompactEvent['preparation']

export type SelfCompactionDetails = {
  method: 'self-compaction'
  readFiles: string[]
  modifiedFiles: string[]
  source: 'projection' | 'session'
}

type Snapshot = {
  sessionId: string
  capturedAt: number
  messages: AgentMessage[]
}

const PROMPT_OVERHEAD_TOKENS = 2000

const CONTEXT_RUNNER: unique symbol = Symbol.for('pi-self-compaction.context-runner')
const CREATE_CONTEXT_WRAPPED: unique symbol = Symbol.for('pi-self-compaction.create-context')

type RunnerContext = ExtensionContext & { [CONTEXT_RUNNER]?: ExtensionRunner }

export default function selfCompaction(pi: ExtensionAPI) {
  recordContextRunners()
  let snapshot: Snapshot | undefined

  const reset = () => {
    snapshot = undefined
  }
  pi.on('session_start', reset)
  pi.on('session_tree', reset)
  pi.on('session_compact', reset)

  pi.on('context_with_system', (event, ctx) => {
    snapshot = {
      sessionId: ctx.sessionManager.getSessionId(),
      capturedAt: Date.now(),
      messages: event.messages.slice(),
    }
  })

  pi.on('session_before_compact', async (event, ctx) => {
    if (event.reason === 'overflow') return
    const model = ctx.model
    if (!model) return

    const { preparation } = event
    const sessionId = ctx.sessionManager.getSessionId()
    const { messages, source } = sessionMessages(event.branchEntries, snapshot, sessionId)
    const minSummaryTokens = Math.min(
      Math.floor(0.8 * preparation.settings.reserveTokens),
      model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
    )
    if (
      preparation.tokensBefore + PROMPT_OVERHEAD_TOKENS + minSummaryTokens >
      model.contextWindow
    ) {
      notify(
        ctx,
        'Self-compaction skipped: context too full to ask the session model; using default compaction.',
      )
      return
    }

    const request: Message[] = [
      ...convertToLlm(messages),
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: compactionPrompt(event),
          },
        ],
        timestamp: Date.now(),
      },
    ]

    const settings = pi.getSettings() as {
      thinkingBudgets?: ModelsSimpleStreamOptions['thinkingBudgets']
      transport?: string
    }
    const options: ModelsSimpleStreamOptions = {
      ...(settings.thinkingBudgets ? { thinkingBudgets: settings.thinkingBudgets } : {}),
      ...(settings.transport
        ? { transport: settings.transport as ModelsSimpleStreamOptions['transport'] }
        : {}),
      ...providerHooks((ctx as RunnerContext)[CONTEXT_RUNNER]),
      signal: event.signal,
      sessionId,
    }
    const thinkingLevel = ctx.thinkingLevel
    if (model.reasoning && thinkingLevel && thinkingLevel !== 'off')
      options.reasoning = thinkingLevel

    try {
      const response = await ctx.modelRegistry
        .streamSimple(model, { messages: request }, options)
        .result()
      if (event.signal.aborted) return
      if (response.stopReason === 'error' || response.stopReason === 'aborted') {
        throw new Error(response.errorMessage ?? `model stopped with ${response.stopReason}`)
      }
      if (response.stopReason === 'length') {
        throw new Error('the summary hit the output limit and is incomplete')
      }
      if (response.content.some(block => block.type === 'toolCall')) {
        throw new Error('the model tried to call a tool')
      }
      const text = response.content
        .flatMap(block => (block.type === 'text' ? [block.text] : []))
        .join('\n')
        .trim()
      if (!text) throw new Error('the model returned an empty summary')

      const { readFiles, modifiedFiles } = fileLists(preparation, event.branchEntries)
      const details: SelfCompactionDetails = {
        method: 'self-compaction',
        readFiles,
        modifiedFiles,
        source,
      }
      return {
        compaction: {
          summary: text + formatFileOperations(readFiles, modifiedFiles),
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage: response.usage,
          details,
        },
      }
    } catch (error) {
      if (event.signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      notify(ctx, `Self-compaction failed (${message}); using default compaction.`)
      return
    }
  })
}

function sessionMessages(
  entries: SessionEntry[],
  captured: Snapshot | undefined,
  sessionId: string,
): { messages: AgentMessage[]; source: SelfCompactionDetails['source'] } {
  const current = buildSessionContext(entries, entries.at(-1)?.id ?? null).messages
  if (!captured || captured.sessionId !== sessionId) return { messages: current, source: 'session' }
  const { capturedAt } = captured
  const capturedRoles = new Set(
    captured.messages.filter(message => message.timestamp === capturedAt).map(m => m.role),
  )
  const appended = current.filter(
    message =>
      message.role !== 'system' &&
      (message.timestamp > capturedAt ||
        (message.timestamp === capturedAt && !capturedRoles.has(message.role))),
  )
  const latestSystem = current.findLast(message => message.role === 'system')
  const systemChanged = latestSystem !== undefined && latestSystem.timestamp > captured.capturedAt
  return {
    messages: [...captured.messages, ...(systemChanged ? [latestSystem] : []), ...appended],
    source: 'projection',
  }
}

function recordContextRunners() {
  const prototype = ExtensionRunner.prototype as ExtensionRunner & {
    [CREATE_CONTEXT_WRAPPED]?: true
  }
  if (prototype[CREATE_CONTEXT_WRAPPED]) return
  const createContext = prototype.createContext
  prototype.createContext = function (this: ExtensionRunner) {
    const ctx = createContext.call(this)
    Object.defineProperty(ctx, CONTEXT_RUNNER, { value: this })
    return ctx
  }
  Object.defineProperty(prototype, CREATE_CONTEXT_WRAPPED, { value: true })
}

function providerHooks(
  runner: ExtensionRunner | undefined,
): Pick<ModelsSimpleStreamOptions, 'onPayload' | 'transformHeaders'> {
  if (!runner) return {}
  return {
    onPayload: payload =>
      runner.hasHandlers('before_provider_request')
        ? runner.emitBeforeProviderRequest(payload)
        : payload,
    transformHeaders: headers =>
      runner.hasHandlers('before_provider_headers')
        ? runner.emitBeforeProviderHeaders(headers)
        : headers,
  }
}

function compactionPrompt(event: SessionBeforeCompactEvent): string {
  const focus = event.customInstructions ? `\n\nFocus: ${event.customInstructions}` : ''
  return `Your context is being compacted. Write a handoff message to yourself: after this, you will only see this handoff and the most recent messages. Earlier summaries are dropped too. Do not call tools.${focus}`
}

function fileLists(preparation: CompactionPreparation, entries: SessionEntry[]) {
  const read = new Set(preparation.fileOps.read)
  const modified = new Set([...preparation.fileOps.edited, ...preparation.fileOps.written])
  const previous = entries.findLast(entry => entry.type === 'compaction')
  if (
    previous?.type === 'compaction' &&
    previous.fromHook &&
    isSelfCompactionDetails(previous.details)
  ) {
    for (const file of previous.details.readFiles) read.add(file)
    for (const file of previous.details.modifiedFiles) modified.add(file)
  }
  return {
    readFiles: [...read].filter(file => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
  }
}

function isSelfCompactionDetails(value: unknown): value is SelfCompactionDetails {
  if (typeof value !== 'object' || value === null) return false
  const details = value as Partial<SelfCompactionDetails>
  return (
    details.method === 'self-compaction' &&
    Array.isArray(details.readFiles) &&
    Array.isArray(details.modifiedFiles)
  )
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = []
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join('\n')}\n</read-files>`)
  if (modifiedFiles.length > 0)
    sections.push(`<modified-files>\n${modifiedFiles.join('\n')}\n</modified-files>`)
  return sections.length > 0 ? `\n\n${sections.join('\n\n')}` : ''
}

function notify(ctx: ExtensionContext, message: string) {
  if (ctx.hasUI) ctx.ui.notify(message, 'warning')
}
