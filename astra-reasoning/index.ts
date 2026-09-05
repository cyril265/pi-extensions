import { randomUUID } from 'node:crypto'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { type Api, clampThinkingLevel, type Model } from '@earendil-works/pi-ai'
import {
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent'

const messageType = 'astra-reasoning-update'
type ThinkingLevel = ReturnType<ExtensionAPI['getThinkingLevel']>
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type Update = {
  provider: string
  model: string
  previousEffort: Effort
  effort: Effort
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEffort(value: unknown): value is Effort {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  )
}

function readUpdate(value: unknown): Update {
  if (
    !isRecord(value) ||
    typeof value.provider !== 'string' ||
    typeof value.model !== 'string' ||
    !isEffort(value.previousEffort) ||
    !isEffort(value.effort)
  ) {
    throw new Error('Invalid persisted Astra reasoning update')
  }
  return {
    provider: value.provider,
    model: value.model,
    previousEffort: value.previousEffort,
    effort: value.effort,
  }
}

function isAstra(model: Model<Api> | undefined): model is Model<Api> {
  return model?.api === 'openai-codex-responses' && model.id.split('/').at(-1) === 'gpt-6-astra'
}

function effortFor(model: Model<Api>, level: ThinkingLevel): Effort {
  const clamped = clampThinkingLevel(model, level)
  const effort = model.thinkingLevelMap?.[clamped] ?? clamped
  if (!isEffort(effort)) throw new Error(`Unsupported Astra reasoning effort: ${effort}`)
  return effort
}

function updatesFor(messages: AgentMessage[], model: Model<Api>): Update[] {
  return messages.flatMap(message => {
    if (message.role !== 'custom' || message.customType !== messageType) return []
    const update = readUpdate(message.details)
    return update.provider === model.provider && update.model === model.id ? [update] : []
  })
}

export default function astraReasoning(pi: ExtensionAPI) {
  const carriers = new Map<string, Update>()

  function recordChange(ctx: ExtensionContext, previousLevel?: ThinkingLevel) {
    const model = ctx.model
    if (!isAstra(model)) return
    const updates = updatesFor(buildSessionContext(ctx.sessionManager.getBranch()).messages, model)
    const effort = effortFor(model, pi.getThinkingLevel())
    // Selector events also cover changes queued while an assistant is streaming.
    const previousEffort =
      previousLevel === undefined ? updates.at(-1)?.effort : effortFor(model, previousLevel)
    if (previousEffort === undefined || previousEffort === effort) return
    pi.sendMessage<Update>(
      {
        customType: messageType,
        content: `Reasoning effort: ${effort}`,
        display: false,
        details: { provider: model.provider, model: model.id, previousEffort, effort },
      },
      { triggerTurn: false },
    )
  }

  pi.on('thinking_level_select', (event, ctx) => recordChange(ctx, event.previousLevel))
  // Reconcile restored branches and returning to Astra after using another model.
  pi.on('before_agent_start', (_event, ctx) => recordChange(ctx))

  pi.on('context', (event, ctx) => {
    carriers.clear()
    try {
      const messages = event.messages.flatMap(message => {
        if (message.role !== 'custom' || message.customType !== messageType) return [message]
        if (!isAstra(ctx.model)) return []
        const update = readUpdate(message.details)
        if (update.provider !== ctx.model.provider || update.model !== ctx.model.id) return []
        // Pi serializes custom messages as user text. Replace this private carrier
        // with a protocol item at the request boundary, never a prompt instruction.
        const marker = randomUUID()
        carriers.set(marker, update)
        return [{ ...message, content: marker }]
      })
      return { messages }
    } catch (error) {
      ctx.abort()
      throw error
    }
  })

  pi.on('before_provider_request', (event, ctx) => {
    if (!isAstra(ctx.model) || carriers.size === 0) return
    const body = event.payload
    if (!isRecord(body) || body.model !== ctx.model.id || !Array.isArray(body.input)) return

    try {
      let initialEffort: Effort | undefined
      let matched = 0
      const input: unknown[] = []
      for (const item of body.input) {
        const content =
          isRecord(item) &&
          item.role === 'user' &&
          Array.isArray(item.content) &&
          item.content.length === 1
            ? item.content[0]
            : undefined
        const update =
          isRecord(content) && content.type === 'input_text' && typeof content.text === 'string'
            ? carriers.get(content.text)
            : undefined
        if (!update) {
          input.push(item)
          continue
        }
        initialEffort ??= update.previousEffort
        matched++
        const previous = input.at(-1)
        // Several selector presses before the next response are one native update.
        if (isRecord(previous) && previous.type === 'configuration_update') input.pop()
        input.push({ type: 'configuration_update', reasoning: { effort: update.effort } })
      }
      // Auxiliary requests such as Pi's summarizer contain no carriers.
      if (matched === 0) return
      if (matched !== carriers.size)
        throw new Error('Astra reasoning updates were lost during request serialization')
      if (!isRecord(body.reasoning)) throw new Error('Astra request is missing reasoning settings')
      if (
        body.truncation === 'auto' ||
        (Array.isArray(body.context_management) && body.context_management.length > 0)
      ) {
        throw new Error(
          'Astra reasoning updates do not support server-side automatic truncation or compaction',
        )
      }
      return { ...body, input, reasoning: { ...body.reasoning, effort: initialEffort } }
    } catch (error) {
      // Pi logs hook errors and otherwise sends the unmodified payload.
      ctx.abort()
      throw error
    }
  })
}
