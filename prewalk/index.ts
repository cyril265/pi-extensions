import * as path from 'node:path'
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import { executeSubagents, renderSubagentDetails } from '../simple-subagent/index.ts'
import { loadConfig, type PrewalkConfig, saveConfig, THINKING_LEVELS } from './config.ts'
import {
  buildExecutorPrompt,
  buildNudge,
  buildTemplate,
  buildVerifyMessage,
  NUDGE_MESSAGE_TYPE,
  RESULT_MESSAGE_TYPE,
  TEMPLATE_MESSAGE_TYPE,
} from './template.ts'

const SIMPLE_SUBAGENT_PROCESS_ENV = 'PI_SIMPLE_SUBAGENT'
const DISPATCH_PROGRESS_WIDGET = 'prewalk-dispatch-progress'
const DISPATCH_TOOL_NAME = 'dispatch_executor'

type PendingDispatch = {
  toolCallId: string
  instructions?: string
  sessionKey?: string
  executor: PrewalkConfig['executor']
}

function getConfigPath(): string {
  return path.join(getAgentDir(), 'prewalk.json')
}

function findConfiguredModel(ctx: ExtensionContext, spec: string): void {
  const slash = spec.indexOf('/')
  const provider = spec.slice(0, slash)
  const id = spec.slice(slash + 1)
  const model = ctx.modelRegistry
    .getAvailable()
    .find(candidate => candidate.provider === provider && candidate.id === id)
  if (!model) throw new Error(`Model "${spec}" is not available`)
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`No configured credentials for "${spec}"`)
  }
}

export default function (pi: ExtensionAPI) {
  const isSubagentProcess = process.env[SIMPLE_SUBAGENT_PROCESS_ENV] === '1'

  if (isSubagentProcess) {
    // Executor forks inherit the parent transcript; hide the prewalk plumbing from them.
    pi.on('context', event => ({
      messages: event.messages.flatMap(message => {
        const inspected = message as {
          role?: string
          customType?: string
          toolName?: string
          content?: unknown
        }
        if (
          inspected.role === 'custom' &&
          (inspected.customType === TEMPLATE_MESSAGE_TYPE ||
            inspected.customType === RESULT_MESSAGE_TYPE ||
            inspected.customType === NUDGE_MESSAGE_TYPE)
        ) {
          return []
        }
        if (inspected.role === 'toolResult' && inspected.toolName === DISPATCH_TOOL_NAME) return []
        if (inspected.role === 'assistant' && Array.isArray(inspected.content)) {
          const content = inspected.content.filter(part => {
            const toolCall = part as { type?: unknown; name?: unknown }
            return !(toolCall.type === 'toolCall' && toolCall.name === DISPATCH_TOOL_NAME)
          })
          if (content.length !== inspected.content.length) {
            return content.length === 0 ? [] : [{ ...message, content } as typeof message]
          }
        }
        return [message]
      }),
    }))
    return
  }

  let pendingDispatch: PendingDispatch | undefined
  let dispatching = false
  let editGateArmed = false

  const dispatchParameters = Type.Object({
    instructions: Type.Optional(
      Type.String({
        description:
          'Only deltas the plan does not contain: discoveries made during the first edit, scope corrections, or rework directions on a re-dispatch. Omit otherwise — the plan already written in the conversation is the instruction. Never restate the plan. Write them as direct task notes addressed to whoever continues the work — never mention the planner or this workflow.',
      }),
    ),
    sessionKey: Type.Optional(
      Type.String({
        description:
          'Only to continue a previous dispatch session; use the sessionKey from its report',
      }),
    ),
  })
  const dispatchTool: ToolDefinition<typeof dispatchParameters, undefined> = {
    name: DISPATCH_TOOL_NAME,
    label: 'Dispatch Executor',
    description:
      'Use only as part of the Prewalk workflow (the user started it with /prewalk). Hand the remaining implementation to the configured continuation agent. It resumes this session in the same working tree and returns a report as a follow-up message. Omit instructions in the normal case — the plan already written in the conversation is the instruction. Provide instructions only for deltas the plan does not contain, or rework directions when re-dispatching with a sessionKey. Call it once after the plan is written and the first edit landed. Never substitute other subagent tools for this one.',
    parameters: dispatchParameters,
    renderCall(args, theme) {
      return new Text(
        theme.fg('accent', `dispatch executor${args.instructions ? `: ${args.instructions}` : ''}`),
        0,
        0,
      )
    },
    async execute(toolCallId, params) {
      if (pendingDispatch || dispatching) throw new Error('A dispatch is already in flight')
      editGateArmed = false
      const config = loadConfig(getConfigPath())
      if (!config) {
        throw new Error(`No prewalk config at ${getConfigPath()}; the user must run /prewalk-config`)
      }
      pendingDispatch = {
        toolCallId,
        instructions: params.instructions,
        sessionKey: params.sessionKey,
        executor: config.executor,
      }
      return {
        content: [
          {
            type: 'text',
            text: `Dispatch scheduled: ${config.executor.model} (thinking ${config.executor.thinking}). The report will arrive as a follow-up message.`,
          },
        ],
        details: undefined,
        terminate: true,
      }
    },
  }

  let dispatchToolRegistered = false
  const registerDispatchTool = () => {
    if (dispatchToolRegistered) return
    pi.registerTool(dispatchTool)
    dispatchToolRegistered = true
  }

  pi.on('session_start', (_event, ctx) => {
    const prewalkWasStarted = ctx.sessionManager
      .getEntries()
      .some(entry => entry.type === 'custom_message' && entry.customType === TEMPLATE_MESSAGE_TYPE)
    if (prewalkWasStarted) registerDispatchTool()
  })

  pi.registerCommand('prewalk-config', {
    description: 'Show or set the prewalk executor. Usage: /prewalk-config [provider/model thinking]',
    handler: async (args, ctx) => {
      try {
        const input = args.trim()
        if (!input) {
          const config = loadConfig(getConfigPath())
          ctx.ui.notify(
            config
              ? `Prewalk executor: ${config.executor.model} (thinking ${config.executor.thinking}) — ${getConfigPath()}`
              : `No prewalk config at ${getConfigPath()}. Usage: /prewalk-config <provider/model> <thinking>`,
            'info',
          )
          return
        }
        const parts = input.split(/\s+/)
        if (parts.length !== 2 || !parts[0].includes('/')) {
          ctx.ui.notify('Usage: /prewalk-config <provider/model> <thinking>', 'warning')
          return
        }
        const [spec, thinking] = parts
        if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) {
          ctx.ui.notify(`"${thinking}" is not a thinking level (${THINKING_LEVELS.join('|')})`, 'warning')
          return
        }
        findConfiguredModel(ctx, spec)
        saveConfig(getConfigPath(), {
          executor: { model: spec, thinking: thinking as PrewalkConfig['executor']['thinking'] },
        })
        ctx.ui.notify(`Prewalk executor set: ${spec} (thinking ${thinking})`, 'info')
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      }
    },
  })

  pi.registerCommand('prewalk', {
    description:
      'Start the prewalk workflow: plan and first edit here, executor fork finishes. Usage: /prewalk [task]',
    handler: async (args, ctx) => {
      try {
        const config = loadConfig(getConfigPath())
        if (!config) {
          ctx.ui.notify(
            `No prewalk config at ${getConfigPath()}. Run /prewalk-config <provider/model> <thinking> first.`,
            'warning',
          )
          return
        }
        findConfiguredModel(ctx, config.executor.model)
        registerDispatchTool()
        pi.sendMessage(
          {
            customType: TEMPLATE_MESSAGE_TYPE,
            content: buildTemplate(args.trim(), pi.getActiveTools().includes('todo')),
            display: true,
          },
          { triggerTurn: true },
        )
        editGateArmed = true
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      }
    },
  })

  pi.on('tool_execution_end', async event => {
    if (!editGateArmed || pendingDispatch || dispatching) return
    if ((event.toolName !== 'edit' && event.toolName !== 'write') || event.isError) return
    editGateArmed = false
    pi.sendMessage(
      { customType: NUDGE_MESSAGE_TYPE, content: buildNudge(), display: true },
      { deliverAs: 'steer' },
    )
  })

  pi.on('turn_end', async (_event, ctx) => {
    if (!pendingDispatch || dispatching) return
    dispatching = true
    const job = pendingDispatch
    pendingDispatch = undefined
    const signal = ctx.signal

    try {
      const result = await executeSubagents(
        pi,
        true,
        {},
        job.toolCallId,
        [
          {
            name: 'executor',
            prompt: buildExecutorPrompt(job.instructions),
            sessionKey: job.sessionKey,
            forkParent: true,
            forkOverride: { model: job.executor.model, thinking: job.executor.thinking },
          },
        ],
        signal,
        update => {
          const details = update.details
          if (!details || ctx.mode !== 'tui') return
          ctx.ui.setWidget(
            DISPATCH_PROGRESS_WIDGET,
            (_tui, theme) =>
              new Text(renderSubagentDetails(details, false, theme, 'dispatch_executor'), 0, 0),
          )
        },
        ctx,
      )
      if (signal?.aborted) return
      const reportText = result.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map(part => part.text)
        .join('\n')
      pi.sendMessage(
        {
          customType: RESULT_MESSAGE_TYPE,
          content: buildVerifyMessage(reportText, result.isError === true),
          display: true,
        },
        { deliverAs: 'followUp', triggerTurn: true },
      )
    } catch (error) {
      if (signal?.aborted) return
      pi.sendMessage(
        {
          customType: RESULT_MESSAGE_TYPE,
          content: `Dispatch failed: ${error instanceof Error ? error.message : String(error)}. Decide whether to dispatch again or finish the implementation yourself.`,
          display: true,
        },
        { deliverAs: 'followUp', triggerTurn: true },
      )
    } finally {
      if (ctx.mode === 'tui') ctx.ui.setWidget(DISPATCH_PROGRESS_WIDGET, undefined)
      dispatching = false
    }
  })
}
