import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import type { SimpleSubagentConfig } from './config.ts'
import {
  formatElapsed,
  formatResultText,
  renderAgentsOverview,
  renderSubagentDetails,
  renderSubagentWidget,
} from './display.ts'
import { startJob } from './execute-subagents.ts'
import { notifyHerdrSubagentsFinished } from './herdr-runner.ts'
import {
  createJobId,
  getPushOptions,
  holdPrintModeJobs,
  JobRegistry,
  type SubagentJob,
  type SubagentJobKind,
  type SubagentJobResult,
} from './jobs.ts'
import { resolveSubagentSessionKey } from './sessions.ts'
import type { SubagentRequest, SubagentResultDetails, ThinkingLevel } from './types.ts'

const SIMPLE_SUBAGENT_FORK_TOOL_ENV = 'PI_SIMPLE_SUBAGENT_FORK_TOOL'
type PendingForkJob = {
  jobId: string
  toolCallId: string
  agents: Array<{ name: string; prompt: string; sessionKey: string; forkParent: true }>
}
type DeliveredSubagentJob = {
  jobId: string
  kind: SubagentJobKind
  result: SubagentJobResult
}
type ForkedSubagentResultsDetails = {
  jobs: DeliveredSubagentJob[]
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

export function registerSubagentTools(
  pi: ExtensionAPI,
  isSubagentProcess: boolean,
  config: SimpleSubagentConfig,
) {
  const pendingForkJobs: PendingForkJob[] = []
  const jobContexts = new Map<string, ExtensionContext>()
  const widgetDetails = new Map<string, SubagentResultDetails>()
  const widgetJobs = new Set<string>()
  const widgetRenders = new Map<string, () => void>()
  let subagentToolsUnlocked = !isSubagentProcess
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
    onSettled(job, result) {
      const ctx = jobContexts.get(job.id)
      if (ctx?.mode === 'tui') ctx.ui.setWidget(`simple-subagent-${job.id}`, undefined)
      widgetDetails.delete(job.id)
      widgetJobs.delete(job.id)
      widgetRenders.delete(job.id)
      if (result.herdrNotification) {
        const { cwd, doneCount, failedCount } = result.herdrNotification
        void notifyHerdrSubagentsFinished(cwd, doneCount, failedCount)
      }
    },
    onPush(job, result) {
      const ctx = jobContexts.get(job.id)
      if (!ctx) throw new Error(`Missing context for subagent job ${job.id}`)
      const isIdle = ctx.isIdle()
      pi.sendMessage(
        {
          customType: 'forked-subagent-results',
          content: isIdle
            ? `Subagent job ${job.id} finished:\n\n${result.text}`
            : `Subagent job ${job.id} finished.\nContinue your current work and use these findings where relevant.\n\n${result.text}`,
          display: true,
          details: {
            jobs: [{ jobId: job.id, kind: job.kind, result }],
          } satisfies ForkedSubagentResultsDetails,
        },
        getPushOptions(isIdle),
      )
    },
  })

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
  const runSubAgentsTool: ToolDefinition<typeof runSubAgentsParameters, undefined> = {
    name: 'runSubAgents',
    label: 'Run Subagents',
    description: `
        Dispatch isolated subagents and return a job ID plus session keys immediately. A subagent has no knowledge of the parent context, so provide complete instructions. Continue independent work after dispatch. Call collectSubagents only when you need to block; otherwise results are delivered automatically.
        A job settles only when ALL its agents finish. Batch agents into one call only when you need their results together; dispatch separate calls for independently actionable tasks so each result arrives as soon as it is ready.
        sessionKey: Optional reusable session name. If omitted, a durable name-based key with an 8-character mixed-case alphanumeric suffix is generated and returned. Reuse a key only for follow-up work that benefits from its existing context, and use distinct keys for agents in the same call.
        overrideModel: ${Object.keys(config.modelAliases).length > 0 ? `options ${Object.keys(config.modelAliases).join(', ')}` : 'use provider/model'}
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
    renderResult(result, _options, theme) {
      return new Text(`\n${theme.fg('muted', 'dispatch:')}\n${formatResultText(getMessageText(result.content), theme)}`, 0, 0)
    },
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const jobId = createJobId(id => !!jobs.get(id))
      jobContexts.set(jobId, ctx)
      try {
        const job = startJob(
          pi,
          jobs,
          jobId,
          'isolated',
          subagentToolsUnlocked,
          config.modelAliases,
          toolCallId,
          params.agents as SubagentRequest[],
          ctx,
        )
        return {
          content: [
            {
              type: 'text',
              text: [
                `Subagents dispatched. jobId: ${job.id}`,
                ...job.agents.map(agent => `${agent.name} sessionKey: ${agent.sessionKey}`),
                `Collect with collectSubagents({ jobId: "${job.id}" }).`,
              ].join('\n'),
            },
          ],
          details: undefined,
        }
      } catch (error) {
        jobContexts.delete(jobId)
        throw error
      }
    },
  }

  pi.registerTool(runSubAgentsTool)

  const collectSubagentsParameters = Type.Object({
    jobId: Type.String(),
  })
  const collectSubagentsTool: ToolDefinition<
    typeof collectSubagentsParameters,
    SubagentResultDetails | undefined
  > = {
    name: 'collectSubagents',
    label: 'Collect Subagents',
    description:
      'Wait for a dispatched subagent job and return results that have not already been delivered. Cancelling this tool does not cancel the job.',
    parameters: collectSubagentsParameters,
    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('collectSubagents'))} ${theme.fg('accent', args.jobId)}`,
        0,
        0,
      )
    },
    renderResult(result, { expanded }, theme) {
      if (result.details?.agents.length) {
        return new Text(renderSubagentDetails(result.details, expanded, theme), 0, 0)
      }
      return new Text(formatResultText(getMessageText(result.content), theme), 0, 0)
    },
    async execute(_toolCallId, params, signal) {
      if (!subagentToolsUnlocked) {
        throw new Error('Subagent tools are unavailable during this run')
      }
      const result = await jobs.collect(params.jobId, signal)
      if (!result) {
        return {
          content: [
            {
              type: 'text',
              text: `Job ${params.jobId} has no undelivered results.`,
            },
          ],
          details: undefined,
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: `Subagent job ${params.jobId} finished:\n${result.text}`,
          },
        ],
        details: result.details,
      }
    },
  }

  pi.registerTool(collectSubagentsTool)

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
    undefined
  > = {
    ...runSubAgentsTool,
    name: 'runSubAgentsWithContext',
    label: 'Run Subagents With Context',
    description: `
      Fork the parent context into parallel subagents and return a job ID plus session keys immediately. Use only when requested.
      A job settles only when ALL its agents finish. Batch agents into one call only when you need their results together; dispatch separate calls for independently actionable tasks so each result arrives as soon as it is ready.
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
    renderResult(result, _options, theme) {
      return new Text(
        `\n${theme.fg('muted', 'dispatch:')}\n${formatResultText(getMessageText(result.content), theme)}`,
        0,
        0,
      )
    },
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (!subagentToolsUnlocked) {
        throw new Error('Subagent tools are unavailable during this run')
      }
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
      const jobId = createJobId(id => !!jobs.get(id))
      const details = createScheduledDetails(
        agents,
        ctx,
        pi.getThinkingLevel() as ThinkingLevel,
      )
      jobContexts.set(jobId, ctx)
      jobs.reserve(
        jobId,
        'fork',
        agents.map(agent => ({ name: agent.name, sessionKey: agent.sessionKey })),
        (error, aborted) => createForkFailureResult(details, error, aborted),
      )
      pendingForkJobs.push({ jobId, toolCallId, agents })
      return {
        content: [
          {
            type: 'text',
            text: [
              `Forked subagents scheduled. jobId: ${jobId}`,
              ...agents.map(agent => `${agent.name} sessionKey: ${agent.sessionKey}`),
              `Collect with collectSubagents({ jobId: "${jobId}" }).`,
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
    if (!details?.jobs.length) return new Text(getMessageText(message.content), 0, 0)
    return new Text(
      details.jobs
        .map(job => {
          const title = job.kind === 'fork' ? 'runSubAgentsWithContext' : 'runSubAgents'
          return `${theme.fg('muted', `job ${job.jobId}`)}\n${renderSubagentDetails(job.result.details, expanded, theme, title)}`
        })
        .join('\n\n'),
      0,
      0,
    )
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
}
