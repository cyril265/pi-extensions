import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import type { SimpleSubagentConfig } from './config.ts'
import { formatResultText, renderAgentsOverview, renderSubagentDetails } from './display.ts'
import { executeSubagents } from './execute-subagents.ts'
import { resolveSubagentSessionKey } from './sessions.ts'
import type { SubagentRequest, SubagentResultDetails, ThinkingLevel } from './types.ts'

const SIMPLE_SUBAGENT_FORK_TOOL_ENV = 'PI_SIMPLE_SUBAGENT_FORK_TOOL'
const FORK_PROGRESS_WIDGET = 'simple-subagent-fork-progress'
const SUBAGENT_TOOL_NAMES = new Set(['runSubAgents', 'runSubAgentsWithContext'])
type SubagentToolActivationApi = {
  getActiveTools(): string[]
  getAllTools(): Array<{ name: string }>
  setActiveTools(names: string[]): void
}
type PendingForkJob = {
  toolCallId: string
  agents: Array<{ name: string; prompt: string; sessionKey: string }>
}
type ForkedSubagentResultsDetails = {
  jobs: SubagentResultDetails[]
}

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map(part => part.text)
    .join('\n')
}

// When a provider path advertises no schema for this tool (for example Anthropic OAuth payload
// filtering hiding it from the model), tool-call parameters arrive as raw JSON strings. Parse
// them back into the declared shape before validation.
export function parseStringifiedAgents<T extends { agents?: unknown }>(args: unknown): T {
  if (
    typeof args === 'object' &&
    args !== null &&
    'agents' in args &&
    typeof (args as { agents: unknown }).agents === 'string'
  ) {
    return { ...args, agents: JSON.parse((args as { agents: string }).agents) } as T
  }
  return args as T
}

export function shouldLockSubagentTools(
  isSubagentProcess: boolean,
  sessionStartReason: 'startup' | 'reload' | 'new' | 'resume' | 'fork',
): boolean {
  return isSubagentProcess && sessionStartReason === 'startup'
}

export function setSubagentToolsActive(
  pi: SubagentToolActivationApi,
  active: boolean,
): void {
  const current = pi.getActiveTools()
  const next = active
    ? [
        ...new Set([
          ...current,
          ...pi
            .getAllTools()
            .map(tool => tool.name)
            .filter(name => SUBAGENT_TOOL_NAMES.has(name)),
        ]),
      ]
    : current.filter(name => !SUBAGENT_TOOL_NAMES.has(name))
  pi.setActiveTools(next)
}

export function registerSubagentTools(
  pi: ExtensionAPI,
  isSubagentProcess: boolean,
  config: SimpleSubagentConfig,
) {
  const pendingForkJobs: PendingForkJob[] = []
  let processingForkJobs = false
  let subagentToolsUnlocked = !isSubagentProcess
  const runSubAgentsParameters = Type.Object({
    agents: Type.Array(
      Type.Object({
        thinking: StringEnum(['low', 'medium', 'high', 'xhigh', 'max'] as const),
        name: Type.String(),
        prompt: Type.String(),
        cwd: Type.String(),
        overrideModel: Type.Optional(Type.String()),
        sessionKey: Type.Optional(Type.String()),
      }),
    ),
  })
  const runSubAgentsTool: ToolDefinition<
    typeof runSubAgentsParameters,
    SubagentResultDetails | undefined
  > = {
    name: 'runSubAgents',
    label: 'Run Subagents',
    description: `
        Run isolated subagents & returns result file paths. Use only when requested. A subagent has no knowledge of the parent context, so provide complete instructions.
        sessionKey: Optional reusable session name. If omitted, a durable name-based key with an 8-character mixed-case alphanumeric suffix is generated and returned. Reuse a key only for follow-up work that benefits from its existing context, and use distinct keys for agents in the same call.
        overrideModel: supply only if requested. ${Object.keys(config.modelAliases).length > 0 ? `options ${Object.keys(config.modelAliases).join(', ')}` : 'use provider/model'}
        thinking: low|medium|high|xhigh|max
        `,
    parameters: runSubAgentsParameters,
    prepareArguments: parseStringifiedAgents,
    renderCall(args, theme) {
      return new Text(
        renderAgentsOverview(
          args.agents.map(agent => ({
            ...agent,
            suppliedModel: agent.overrideModel,
          })),
          theme,
        ),
        0,
        0,
      )
    },
    renderResult(result, { expanded }, theme) {
      const content = result.content[0]
      const text = content?.type === 'text' ? content.text : '(no output)'
      const details = result.details

      if (details?.agents?.length) {
        return new Text(renderSubagentDetails(details, expanded, theme), 0, 0)
      }

      return new Text(`\n${theme.fg('muted', 'results:')}\n${formatResultText(text, theme)}`, 0, 0)
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeSubagents(
        pi,
        subagentToolsUnlocked,
        config.modelAliases,
        toolCallId,
        params.agents as SubagentRequest[],
        signal,
        onUpdate,
        ctx,
      )
    },
  }

  pi.registerTool(runSubAgentsTool)

  const runSubAgentsWithContextParameters = Type.Object({
    agents: Type.Array(
      Type.Object({
        name: Type.String(),
        prompt: Type.String(),
        sessionKey: Type.Optional(Type.String()),
      }),
    ),
  })
  const runSubAgentsWithContextTool: ToolDefinition<
    typeof runSubAgentsWithContextParameters,
    SubagentResultDetails | undefined
  > = {
    ...runSubAgentsTool,
    name: 'runSubAgentsWithContext',
    label: 'Run Subagents With Context',
    description: `
      Fork the parent context into parallel subagents and return result file paths. Use only when requested.
      Each child inherits and locks the parent's cwd, provider/model, and thinking level.
      sessionKey: Optional reusable fork name. If omitted, a durable name-based key with an 8-character mixed-case alphanumeric suffix is generated and returned.
    `,
    parameters: runSubAgentsWithContextParameters,
    renderCall(args, theme) {
      return new Text(
        renderAgentsOverview(
          args.agents.map(agent => ({
            ...agent,
            thinking: pi.getThinkingLevel() as ThinkingLevel,
            forkParent: true,
          })),
          theme,
          false,
          'runSubAgentsWithContext',
        ),
        0,
        0,
      )
    },
    renderResult(result, { expanded }, theme) {
      const content = result.content[0]
      const text = content?.type === 'text' ? content.text : '(no output)'
      const details = result.details

      if (details?.agents.length) {
        return new Text(renderSubagentDetails(details, expanded, theme), 0, 0)
      }

      return new Text(`\n${theme.fg('muted', 'results:')}\n${formatResultText(text, theme)}`, 0, 0)
    },
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (!subagentToolsUnlocked) {
        throw new Error('Subagent tools are locked during the parent-assigned run')
      }
      if (params.agents.length === 0) throw new Error('No agents')
      const agents = params.agents.map(agent => ({
        ...agent,
        sessionKey: resolveSubagentSessionKey(ctx.cwd, agent.name, agent.sessionKey),
      }))
      pendingForkJobs.push({
        toolCallId,
        agents,
      })
      return {
        content: [
          {
            type: 'text',
            text: [
              'Forked subagents scheduled.',
              ...agents.map(agent => `${agent.name} sessionKey: ${agent.sessionKey}`),
            ].join('\n'),
          },
        ],
        details: undefined,
        terminate: true,
      }
    },
  }

  pi.registerMessageRenderer('forked-subagent-results', (message, { expanded }, theme) => {
    const details = message.details as ForkedSubagentResultsDetails | undefined
    if (!details?.jobs.length) {
      const content =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .filter(part => part.type === 'text')
              .map(part => part.text)
              .join('\n')
      return new Text(content, 0, 0)
    }
    return new Text(
      details.jobs
        .map(job => renderSubagentDetails(job, expanded, theme, 'runSubAgentsWithContext'))
        .join('\n\n'),
      0,
      0,
    )
  })

  let forkToolRegistered = false
  pi.on('session_start', (event, _ctx) => {
    if (!forkToolRegistered) {
      const enabledByParent = process.env[SIMPLE_SUBAGENT_FORK_TOOL_ENV] === '1'
      if (enabledByParent || config.enableForkTool) {
        pi.registerTool(runSubAgentsWithContextTool)
        forkToolRegistered = true
      }
    }

    if (!isSubagentProcess) return
    subagentToolsUnlocked = !shouldLockSubagentTools(isSubagentProcess, event.reason)
    setSubagentToolsActive(pi, subagentToolsUnlocked)
  })

  pi.on('agent_settled', () => {
    if (!isSubagentProcess || subagentToolsUnlocked) return
    subagentToolsUnlocked = true
    setSubagentToolsActive(pi, true)
  })

  pi.on('turn_end', async (_event, ctx) => {
    if (processingForkJobs || pendingForkJobs.length === 0) return
    processingForkJobs = true
    const signal = ctx.signal
    const jobs = pendingForkJobs.splice(0)
    const messages: string[] = []
    const resultDetails: SubagentResultDetails[] = []

    try {
      for (const job of jobs) {
        if (signal?.aborted) break
        let latestDetails: SubagentResultDetails | undefined
        try {
          const result = await executeSubagents(
            pi,
            subagentToolsUnlocked,
            config.modelAliases,
            job.toolCallId,
            job.agents.map(agent => ({ ...agent, forkParent: true })),
            signal,
            update => {
              const details = update.details
              if (!details) return
              latestDetails = details
              if (ctx.mode !== 'tui') return
              ctx.ui.setWidget(
                FORK_PROGRESS_WIDGET,
                (_tui, theme) =>
                  new Text(
                    renderSubagentDetails(details, false, theme, 'runSubAgentsWithContext'),
                    0,
                    0,
                  ),
              )
            },
            ctx,
          )
          messages.push(getResultText(result))
        } catch (error) {
          if (signal?.aborted) break
          messages.push(
            `Forked subagents failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        if (latestDetails) resultDetails.push(latestDetails)
      }

      if (signal?.aborted) return
      pi.sendMessage(
        {
          customType: 'forked-subagent-results',
          content: `Forked subagent results:\n\n${messages.join('\n\n')}`,
          display: true,
          details: { jobs: resultDetails } satisfies ForkedSubagentResultsDetails,
        },
        { deliverAs: 'followUp', triggerTurn: true },
      )
    } finally {
      if (ctx.mode === 'tui') ctx.ui.setWidget(FORK_PROGRESS_WIDGET, undefined)
      processingForkJobs = false
    }
  })
}
