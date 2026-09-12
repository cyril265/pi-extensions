import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { type Static, Type } from 'typebox'
import type { SimpleSubagentConfig } from './config.ts'
import {
  formatElapsed,
  renderDispatchResult,
  formatResultText,
  renderAgentsOverview,
  renderSubagentWidget,
} from './display.ts'
import { startJob } from './execute-subagents.ts'
import {
  createJobId,
  holdPrintModeJobs,
  JobRegistry,
  type SubagentJob,
  type SubagentJobKind,
  type SubagentJobResult,
} from './jobs.ts'
import { getSubagentSessionPath, resolveSubagentSessionKey } from './sessions.ts'
import type { SubagentResultDetails, ThinkingLevel } from './types.ts'

const SIMPLE_SUBAGENT_FORK_TOOL_ENV = 'PI_SIMPLE_SUBAGENT_FORK_TOOL'
type PendingForkJob = {
  jobId: string
  toolCallId: string
  agents: Array<{ name: string; prompt: string; sessionKey: string; forkParent: true }>
}
type SubagentDispatchDetails = {
  jobId: string
  agents: Array<{ name: string; sessionKey: string }>
}

export const isolatedAgentsSchema = Type.Array(
  Type.Object(
    {
      name: Type.String({ minLength: 1 }),
      prompt: Type.String({ minLength: 1 }),
      cwd: Type.String({ minLength: 1, description: 'Absolute path' }),
      thinking: StringEnum(['low', 'medium', 'high', 'xhigh', 'max'] as const),
      overrideModel: Type.Optional(
        Type.String({
          minLength: 1,
          description: 'Configured alias or provider/model. Omit to inherit the parent model.',
        }),
      ),
      sessionKey: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            'Reuse to continue a child session; omit to generate one. Do not run the same cwd + sessionKey concurrently.',
        }),
      ),
    },
    { additionalProperties: false },
  ),
  { minItems: 1 },
)
export type IsolatedDispatchRequest = Static<typeof isolatedAgentsSchema>[number]

export type RegisteredSubagentTools = {
  dispatchIsolated: (
    requests: IsolatedDispatchRequest[],
    toolCallId: string,
    ctx: ExtensionContext,
  ) => SubagentJob
  join: (jobId: string, signal: AbortSignal | undefined) => Promise<SubagentJobResult>
  listRunning: () => SubagentJob[]
}

function getMessageText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map(part => part.text)
    .join('\n')
}

function createScheduledDetails(
  agents: PendingForkJob['agents'],
  ctx: ExtensionContext,
  thinking: ThinkingLevel,
): SubagentResultDetails {
  const effectiveModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined
  return {
    agents: agents.map(agent => ({
      name: agent.name,
      prompt: agent.prompt,
      cwd: ctx.cwd,
      sessionKey: agent.sessionKey,
      thinking,
      effectiveModel,
      forkParent: true,
      status: 'queued',
      tools: [],
    })),
  }
}

function createForkFailureResult(
  details: SubagentResultDetails,
  error: unknown,
  aborted: boolean,
): SubagentJobResult {
  return {
    text: `Forked subagents failed: ${error instanceof Error ? error.message : String(error)}`,
    details: {
      ...details,
      agents: details.agents.map(agent => ({
        ...agent,
        status: aborted ? 'interrupted' : 'failed',
      })),
    },
    isError: true,
  }
}

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

export function reserveSessionPaths(activePaths: Set<string>, paths: string[]): () => void {
  const reserved = new Set<string>()
  for (const sessionPath of paths) {
    if (activePaths.has(sessionPath) || reserved.has(sessionPath)) {
      throw new Error(`Subagent session is already running: ${sessionPath}`)
    }
    reserved.add(sessionPath)
  }
  for (const sessionPath of reserved) activePaths.add(sessionPath)

  return () => {
    for (const sessionPath of reserved) activePaths.delete(sessionPath)
  }
}

export function registerSubagentTools(
  pi: ExtensionAPI,
  isSubagentProcess: boolean,
  config: SimpleSubagentConfig,
): RegisteredSubagentTools {
  const pendingForkJobs: PendingForkJob[] = []
  const activeSessionPaths = new Set<string>()
  const releaseSessionPaths = new Map<string, () => void>()
  const jobContexts = new Map<string, ExtensionContext>()
  const widgetDetails = new Map<string, SubagentResultDetails>()
  const widgetJobs = new Set<string>()
  const widgetRenders = new Map<string, () => void>()
  let subagentToolsUnlocked = !isSubagentProcess
  const assertSubagentToolsAvailable = () => {
    if (!subagentToolsUnlocked) {
      throw new Error('Subagent tools are unavailable during this run')
    }
  }
  const jobs = new JobRegistry({
    onProgress(job, details) {
      const ctx = jobContexts.get(job.id)
      if (!ctx || ctx.mode !== 'tui') return
      widgetDetails.set(job.id, details)
      if (widgetJobs.has(job.id)) {
        widgetRenders.get(job.id)?.()
        return
      }
      widgetJobs.add(job.id)
      ctx.ui.setWidget(`simple-subagent-${job.id}`, (tui, theme) => {
        const text = new Text('', 0, 0)
        const timer = setInterval(() => tui.requestRender(), 1000)
        timer.unref()
        widgetRenders.set(job.id, () => tui.requestRender())
        return {
          render(width) {
            const latest = widgetDetails.get(job.id)
            if (!latest) return []
            text.setText(
              renderSubagentWidget(
                latest,
                theme,
                job.kind === 'fork' ? 'runSubAgentsWithContext' : 'runSubAgents',
                job.id,
                job.startedAt,
              ),
            )
            return text.render(width)
          },
          invalidate() {
            text.invalidate()
          },
          dispose() {
            clearInterval(timer)
            widgetRenders.delete(job.id)
          },
        }
      })
    },
    onSettled(job) {
      releaseSessionPaths.get(job.id)?.()
      releaseSessionPaths.delete(job.id)
      const ctx = jobContexts.get(job.id)
      if (ctx?.mode === 'tui') ctx.ui.setWidget(`simple-subagent-${job.id}`, undefined)
      widgetDetails.delete(job.id)
      widgetJobs.delete(job.id)
      widgetRenders.delete(job.id)
    },
    onPush(job, result) {
      pi.sendUserMessage(
        `Subagent job ${job.id} finished.\nContinue your current work and use these findings where relevant.\n\n${result.text}`,
        { deliverAs: 'steer' },
      )
    },
    onDelivered(job) {
      jobContexts.delete(job.id)
    },
  })

  const dispatchIsolated = (
    requests: IsolatedDispatchRequest[],
    toolCallId: string,
    ctx: ExtensionContext,
  ): SubagentJob => {
    assertSubagentToolsAvailable()
    if (requests.length === 0) throw new Error('No agents')
    const jobId = createJobId(id => jobs.has(id))
    const agents = requests.map(request => ({
      ...request,
      sessionKey: resolveSubagentSessionKey(request.cwd, request.name, request.sessionKey),
    }))
    try {
      releaseSessionPaths.set(
        jobId,
        reserveSessionPaths(
          activeSessionPaths,
          agents.map(agent => getSubagentSessionPath(agent.cwd, agent.sessionKey)),
        ),
      )
      jobContexts.set(jobId, ctx)
      return startJob(
        pi,
        jobs,
        jobId,
        'isolated',
        subagentToolsUnlocked,
        config.modelAliases,
        toolCallId,
        agents,
        ctx,
      )
    } catch (error) {
      releaseSessionPaths.get(jobId)?.()
      releaseSessionPaths.delete(jobId)
      jobContexts.delete(jobId)
      throw error
    }
  }

  const runSubAgentsParameters = Type.Object({ agents: isolatedAgentsSchema })
  const aliases = Object.keys(config.modelAliases)
  const runSubAgentsTool: ToolDefinition<
    typeof runSubAgentsParameters,
    SubagentDispatchDetails
  > = {
    name: 'runSubAgents',
    label: 'Run Subagents',
    description: `
        Start subagents and return immediately; one result message per call arrives when all its agents finish. Subagents do not see your conversation and cannot delegate. Do other work or end your turn. Do not poll.
        From Node: \`const { dispatch, run } = await import(process.env.PI_SIMPLE_SUBAGENT_CLIENT)\`, same agents array. \`dispatch\` behaves like this tool. When a result must feed further work in the same step, \`await run(agents)\` waits and returns \`{ isError, text, agents: [{ name, output?, ... }] }\`.
        ${aliases.length > 0 ? `overrideModel aliases: ${aliases.join(', ')}` : ''}
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
    renderResult(result, _options, theme) {
      return new Text(
        result.details
          ? renderDispatchResult(result.details.jobId, result.details.agents, theme)
          : formatResultText(getMessageText(result.content), theme),
        0,
        0,
      )
    },
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const job = dispatchIsolated(params.agents, toolCallId, ctx)
      return {
        content: [
          {
            type: 'text',
            text: [
              `Subagents dispatched. jobId: ${job.id}`,
              ...job.agents.map(agent => `${agent.name} sessionKey: ${agent.sessionKey}`),
              'Results will be delivered automatically.',
            ].join('\n'),
          },
        ],
        details: {
          jobId: job.id,
          agents: job.agents.map(agent => ({
            name: agent.name,
            sessionKey: agent.sessionKey,
          })),
        },
      }
    },
  }

  pi.registerTool(runSubAgentsTool)

  const runSubAgentsWithContextParameters = Type.Object({
    agents: Type.Array(
      Type.Object({
        name: Type.String(),
        prompt: Type.String(),
        sessionKey: Type.Optional(
          Type.String({
            description:
              'Reuse to continue a fork; omit to generate one. Do not run the same key concurrently.',
          }),
        ),
      }),
    ),
  })
  const runSubAgentsWithContextTool: ToolDefinition<
    typeof runSubAgentsWithContextParameters,
    SubagentDispatchDetails
  > = {
    ...runSubAgentsTool,
    name: 'runSubAgentsWithContext',
    label: 'Run Subagents With Context',
    description: `
      Fork your conversation into subagents and return a job ID plus session keys immediately. Use only when the user asks for it. One result message per call arrives when all its agents finish. Children inherit and lock cwd, model, and thinking. Subagents cannot delegate.
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
    renderResult(result, _options, theme) {
      return new Text(
        result.details
          ? renderDispatchResult(result.details.jobId, result.details.agents, theme)
          : formatResultText(getMessageText(result.content), theme),
        0,
        0,
      )
    },
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      assertSubagentToolsAvailable()
      if (params.agents.length === 0) throw new Error('No agents')
      if (!ctx.model) throw new Error('Parent context has no caller model')
      const agents = params.agents.map(agent => ({
        ...agent,
        sessionKey: resolveSubagentSessionKey(ctx.cwd, agent.name, agent.sessionKey),
        forkParent: true as const,
      }))
      if (new Set(agents.map(agent => agent.sessionKey)).size !== agents.length) {
        throw new Error('Duplicate subagent sessionKey for same cwd in one parallel run')
      }
      const jobId = createJobId(id => jobs.has(id))
      const details = createScheduledDetails(
        agents,
        ctx,
        pi.getThinkingLevel() as ThinkingLevel,
      )
      releaseSessionPaths.set(
        jobId,
        reserveSessionPaths(
          activeSessionPaths,
          agents.map(agent => getSubagentSessionPath(ctx.cwd, agent.sessionKey)),
        ),
      )
      jobContexts.set(jobId, ctx)
      try {
        jobs.reserve(
          jobId,
          'fork',
          agents.map(agent => ({ name: agent.name, sessionKey: agent.sessionKey })),
          (error, aborted) => createForkFailureResult(details, error, aborted),
        )
      } catch (error) {
        releaseSessionPaths.get(jobId)?.()
        releaseSessionPaths.delete(jobId)
        jobContexts.delete(jobId)
        throw error
      }
      pendingForkJobs.push({ jobId, toolCallId, agents })
      return {
        content: [
          {
            type: 'text',
            text: [
              `Forked subagents scheduled. jobId: ${jobId}`,
              ...agents.map(agent => `${agent.name} sessionKey: ${agent.sessionKey}`),
              'Results will be delivered automatically.',
            ].join('\n'),
          },
        ],
        details: {
          jobId,
          agents: agents.map(agent => ({
            name: agent.name,
            sessionKey: agent.sessionKey,
          })),
        },
        terminate: true,
      }
    },
  }

  pi.registerTool({
    name: 'cancelSubAgents',
    label: 'Cancel Subagents',
    description: 'Cancel a running subagent job.',
    parameters: Type.Object({ jobId: Type.String({ minLength: 1 }) }),
    async execute(_toolCallId, params) {
      if (!jobs.cancel(params.jobId)) throw new Error(`No running subagent job ${params.jobId}`)
      return {
        content: [{ type: 'text', text: `Cancelling subagent job ${params.jobId}; its result arrives as interrupted.` }],
        details: undefined,
      }
    },
  })

  pi.registerCommand('subagents', {
    description: 'List running subagent jobs or cancel one with /subagents cancel <jobId>.',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      if (parts.length === 0) {
        const running = jobs.listRunning()
        if (running.length === 0) {
          ctx.ui.notify('No running subagent jobs', 'info')
          return
        }
        const options = running.map(
          job =>
            `${job.id} · ${job.agents.map(agent => `${agent.name}:${agent.state}`).join(', ')} · ${formatElapsed(job.startedAt)}`,
        )
        const selected = await ctx.ui.select('Running subagent jobs', options)
        if (!selected) return
        const job = running[options.indexOf(selected)]
        if (!job) return
        const confirmed = await ctx.ui.confirm(
          `Cancel subagent job ${job.id}?`,
          job.agents.map(agent => agent.name).join(', '),
        )
        if (!confirmed) return
        const cancelled = jobs.cancel(job.id)
        ctx.ui.notify(
          cancelled ? `Cancelled subagent job ${job.id}` : `No running job ${job.id}`,
          cancelled ? 'info' : 'warning',
        )
        return
      }
      if (parts.length !== 2 || parts[0] !== 'cancel') {
        ctx.ui.notify('Usage: /subagents [cancel <jobId>]', 'warning')
        return
      }
      const cancelled = jobs.cancel(parts[1])
      ctx.ui.notify(
        cancelled ? `Cancelled subagent job ${parts[1]}` : `No running job ${parts[1]}`,
        cancelled ? 'info' : 'warning',
      )
    },
  })

  let forkToolRegistered = false
  pi.on('session_start', event => {
    if (!forkToolRegistered) {
      const enabledByParent = process.env[SIMPLE_SUBAGENT_FORK_TOOL_ENV] === '1'
      if (enabledByParent || config.enableForkTool) {
        pi.registerTool(runSubAgentsWithContextTool)
        forkToolRegistered = true
      }
    }

    if (!isSubagentProcess) return
    subagentToolsUnlocked = !shouldLockSubagentTools(isSubagentProcess, event.reason)
  })

  pi.on('agent_settled', () => {
    if (!isSubagentProcess || subagentToolsUnlocked) return
    subagentToolsUnlocked = true
  })

  pi.on('turn_end', async (_event, ctx) => {
    const scheduled = pendingForkJobs.splice(0)
    for (const pending of scheduled) {
      if (!jobs.isRunning(pending.jobId)) continue
      try {
        startJob(
          pi,
          jobs,
          pending.jobId,
          'fork',
          subagentToolsUnlocked,
          config.modelAliases,
          pending.toolCallId,
          pending.agents,
          ctx,
        )
      } catch (error) {
        const job = jobs.get(pending.jobId)
        if (!job || !jobs.isRunning(pending.jobId)) continue
        const details = createScheduledDetails(
          pending.agents,
          ctx,
          pi.getThinkingLevel() as ThinkingLevel,
        )
        jobs.fail(pending.jobId, createForkFailureResult(details, error, false))
      }
    }
    await holdPrintModeJobs(ctx.mode, jobs)
  })

  pi.on('session_shutdown', async () => {
    pendingForkJobs.length = 0
    await jobs.shutdown()
    for (const jobId of widgetJobs) {
      const ctx = jobContexts.get(jobId)
      if (ctx?.mode === 'tui') ctx.ui.setWidget(`simple-subagent-${jobId}`, undefined)
    }
    widgetDetails.clear()
    widgetJobs.clear()
    widgetRenders.clear()
    jobContexts.clear()
  })

  return {
    dispatchIsolated,
    join: (jobId, signal) => jobs.join(jobId, signal),
    listRunning: () => jobs.listRunning(),
  }
}
