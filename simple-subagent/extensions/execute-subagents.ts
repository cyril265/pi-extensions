import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { runSubAgent } from './child-process.ts'
import {
  getHerdrParentLabel,
  HerdrInitializationError,
  isHerdrEnvironment,
  runSubagentsInHerdr,
} from './herdr-runner.ts'
import {
  type JobRegistry,
  type SubagentJob,
  type SubagentJobKind,
  type SubagentJobResult,
} from './jobs.ts'
import { resolveEffectiveModel } from './model.ts'
import {
  createForkedSession,
  createRunDirectory,
  findForkLeafId,
  getSubagentSessionPath,
  readForkMetadata,
  resolveSubagentSessionKey,
  sanitizeFileName,
  writeForkMetadata,
} from './sessions.ts'
import { cloneToolArgs } from './tool-events.ts'
import type {
  ForkMetadata,
  LiveDisplayEvent,
  SubagentRequest,
  SubagentRunResult,
  SubagentResultDetails,
  ThinkingLevel,
  ToolDisplayItem,
} from './types.ts'
import { formatUsageStats, sumUsageStats } from './usage.ts'

export const INLINE_RESULT_MAX_CHARACTERS = 2048
const PARENT_ASSIGNED_RUN_INSTRUCTION =
  'Do not call runSubAgents, collectSubagents, or runSubAgentsWithContext during this run; those tools are unavailable.'

export function getParentAssignedPrompt(prompt: string): string {
  return `${prompt}${prompt ? '\n\n' : ''}${PARENT_ASSIGNED_RUN_INSTRUCTION}`
}

type PreparedAgent = SubagentRequest & {
  cwd: string
  sessionKey: string
  thinking: ThinkingLevel
  effectiveModel: string
  suppliedModel: string | undefined
  forkParent: boolean
  sessionPath: string
  promptCacheKey: string | undefined
}

function snapshotDetails(
  liveEvents: LiveDisplayEvent[],
  agents: SubagentResultDetails['agents'],
): SubagentResultDetails {
  return {
    liveEvents: liveEvents.map(event => ({
      type: 'tool',
      agent: event.agent,
      tool: {
        name: event.tool.name,
        args: cloneToolArgs(event.tool.args),
      },
    })),
    agents: agents.map(agent => ({
      ...agent,
      tools: agent.tools?.map(tool => ({
        name: tool.name,
        args: cloneToolArgs(tool.args),
      })),
      usage: agent.usage ? { ...agent.usage } : undefined,
    })),
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function formatFinishedAgentResult(
  agent: {
    name: string
    thinking: ThinkingLevel
    effectiveModel: string
    sessionKey: string
  },
  outputPath: string,
  result: SubagentRunResult,
  hasParentPromptCache: boolean,
): string[] {
  const lines = [
    `${agent.name} (${agent.thinking}, ${agent.effectiveModel}, exit ${result.exitCode}): ${outputPath}`,
    `sessionKey: ${agent.sessionKey}`,
    formatUsageStats(result.usage),
  ]
  if (hasParentPromptCache) {
    const firstTurn = result.firstTurnUsage
    lines.push(
      firstTurn.cacheRead > 0
        ? `parent cache: hit (${firstTurn.cacheRead} cached, ${firstTurn.input} uncached input tokens)`
        : `parent cache: MISS (${firstTurn.input} uncached input tokens)`,
    )
  }
  if (result.text.length <= INLINE_RESULT_MAX_CHARACTERS) {
    lines.push('', `${agent.name} result:`, ...result.text.split('\n').map(line => `    ${line}`))
  }
  return lines
}

export function startJob(
  pi: ExtensionAPI,
  jobs: JobRegistry,
  jobId: string,
  kind: SubagentJobKind,
  subagentToolsUnlocked: boolean,
  modelAliases: Record<string, string>,
  toolCallId: string,
  requestedAgents: SubagentRequest[],
  ctx: ExtensionContext,
): SubagentJob {
  if (!subagentToolsUnlocked) {
    throw new Error('Subagent tools are unavailable during this run')
  }
  if (requestedAgents.length === 0) throw new Error('No agents')

  const callerModelInfo = ctx.model
  const callerModel = callerModelInfo
    ? `${callerModelInfo.provider}/${callerModelInfo.id}`
    : undefined
  const callerThinking = pi.getThinkingLevel() as ThinkingLevel
  const resolvedAgents = requestedAgents.map(agent => {
    if (agent.forkParent) {
      if (
        agent.cwd !== undefined ||
        agent.thinking !== undefined ||
        agent.overrideModel !== undefined
      ) {
        throw new Error(
          `Forked subagent "${agent.name}" inherits cwd, thinking, and model; omit those fields`,
        )
      }
      if (!callerModelInfo) {
        throw new Error(`No caller model for forked subagent "${agent.name}"`)
      }
      const override = agent.forkOverride
      if (override && !override.model.trim()) {
        throw new Error(`forkOverride.model for forked subagent "${agent.name}" is empty`)
      }
      const forkedModel = override
        ? (resolveEffectiveModel(override.model, modelAliases) ?? override.model)
        : `${callerModelInfo.provider}/${callerModelInfo.id}`
      return {
        ...agent,
        cwd: ctx.cwd,
        sessionKey: resolveSubagentSessionKey(ctx.cwd, agent.name, agent.sessionKey),
        thinking: override?.thinking ?? callerThinking,
        suppliedModel: override?.model,
        effectiveModel: forkedModel,
        forkParent: true,
      }
    }

    if (agent.forkOverride) {
      throw new Error(`forkOverride requires forkParent for subagent "${agent.name}"`)
    }
    if (!agent.cwd) throw new Error(`cwd is required for isolated subagent "${agent.name}"`)
    if (!agent.thinking) {
      throw new Error(`thinking is required for isolated subagent "${agent.name}"`)
    }
    const suppliedModel = agent.overrideModel?.trim() || undefined
    if (agent.overrideModel !== undefined && !suppliedModel) {
      throw new Error(`overrideModel for subagent "${agent.name}" is empty`)
    }

    const effectiveModel = resolveEffectiveModel(suppliedModel, modelAliases) || callerModel
    if (!effectiveModel) {
      throw new Error(`No caller model for subagent "${agent.name}" and no overrideModel`)
    }

    return {
      ...agent,
      cwd: agent.cwd,
      thinking: agent.thinking,
      sessionKey: resolveSubagentSessionKey(agent.cwd, agent.name, agent.sessionKey),
      suppliedModel,
      effectiveModel,
      forkParent: false,
    }
  })

  const runDirectory = createRunDirectory()
  const agentsWithSessionPaths = resolvedAgents.map(agent => ({
    ...agent,
    sessionPath: getSubagentSessionPath(agent.cwd, agent.sessionKey),
  }))
  const sessionPaths = agentsWithSessionPaths.map(agent => agent.sessionPath)
  if (new Set(sessionPaths).size !== sessionPaths.length) {
    throw new Error('Duplicate subagent sessionKey for same cwd in one parallel run')
  }

  const hasForkedAgents = agentsWithSessionPaths.some(agent => agent.forkParent)
  let parentFork:
    | {
        sourceSessionPath: string
        sourceSessionId: string
        forkLeafId: string
        provider: string
      }
    | undefined
  if (hasForkedAgents) {
    const sourceSessionPath = ctx.sessionManager.getSessionFile()
    if (!sourceSessionPath) {
      throw new Error('Parent context can only be forked from a persisted session')
    }
    if (!callerModelInfo) throw new Error('Parent context has no caller model')
    parentFork = {
      sourceSessionPath,
      sourceSessionId: ctx.sessionManager.getSessionId(),
      forkLeafId: findForkLeafId(ctx.sessionManager, toolCallId),
      provider: callerModelInfo.provider,
    }
  }

  const preparedAgents: PreparedAgent[] = agentsWithSessionPaths.map(agent => {
    if (!agent.forkParent) {
      if (readForkMetadata(agent.sessionPath)) {
        throw new Error(
          `Session "${agent.sessionKey}" is a parent fork; use runSubAgentsWithContext instead`,
        )
      }
      return { ...agent, promptCacheKey: undefined }
    }

    if (!parentFork) throw new Error('Parent fork context was not prepared')
    const existingMetadata = readForkMetadata(agent.sessionPath)
    const sessionExists = fs.existsSync(agent.sessionPath)
    if (sessionExists !== !!existingMetadata) {
      throw new Error(`Incomplete forked session state for "${agent.name}" at ${agent.sessionPath}`)
    }
    const inheritsParentCache = agent.effectiveModel === callerModel
    const expectedMetadata: ForkMetadata = {
      version: 1,
      sourceSessionId: parentFork.sourceSessionId,
      promptCacheKey: parentFork.sourceSessionId,
      provider: parentFork.provider,
      model: agent.effectiveModel,
      thinking: agent.thinking,
      cwd: agent.cwd,
    }

    if (existingMetadata) {
      for (const field of [
        'version',
        'sourceSessionId',
        'provider',
        'model',
        'thinking',
        'cwd',
      ] as const) {
        if (existingMetadata[field] !== expectedMetadata[field]) {
          throw new Error(
            `Forked session "${agent.sessionKey}" is locked to ${field}=${existingMetadata[field]}`,
          )
        }
      }
      return {
        ...agent,
        promptCacheKey: inheritsParentCache ? existingMetadata.promptCacheKey : undefined,
      }
    }

    createForkedSession(
      parentFork.sourceSessionPath,
      parentFork.forkLeafId,
      agent.sessionPath,
      parentFork.sourceSessionId,
    )
    try {
      writeForkMetadata(agent.sessionPath, expectedMetadata)
    } catch (error) {
      fs.unlinkSync(agent.sessionPath)
      throw error
    }
    return {
      ...agent,
      promptCacheKey: inheritsParentCache ? expectedMetadata.promptCacheKey : undefined,
    }
  })

  const initialAgents: SubagentResultDetails['agents'] = preparedAgents.map(agent => ({
    name: agent.name,
    thinking: agent.thinking,
    suppliedModel: agent.suppliedModel,
    effectiveModel: agent.effectiveModel,
    prompt: agent.prompt,
    cwd: agent.cwd,
    sessionKey: agent.sessionKey,
    forkParent: agent.forkParent,
    status: 'queued',
    tools: [],
  }))
  let latestDetails: SubagentResultDetails = { agents: initialAgents }
  const failureResult = (error: unknown, aborted: boolean): SubagentJobResult => ({
    text: `${kind === 'fork' ? 'Forked subagents' : 'Subagents'} failed: ${errorText(error)}`,
    details: {
      ...latestDetails,
      agents: latestDetails.agents.map(agent => ({
        ...agent,
        status:
          agent.status === 'done' || agent.status === 'failed'
            ? agent.status
            : aborted
              ? 'interrupted'
              : 'failed',
      })),
    },
    isError: true,
  })

  return jobs.start({
    id: jobId,
    kind,
    agents: preparedAgents.map(agent => ({ name: agent.name, sessionKey: agent.sessionKey })),
    failureResult,
    run: async (signal, update) => {
      const liveEvents: LiveDisplayEvent[] = []
      const liveAgents: SubagentResultDetails['agents'] = initialAgents.map(agent => ({
        ...agent,
        tools: [],
      }))
      const emitLiveUpdate = () => {
        if (signal.aborted) return
        latestDetails = snapshotDetails(liveEvents, liveAgents)
        update(latestDetails)
      }
      const emitAgentTool = (index: number, tool: ToolDisplayItem) => {
        liveAgents[index].tools ??= []
        liveAgents[index].tools.push(tool)
        liveEvents.push({ type: 'tool', agent: liveAgents[index].name, tool })
        emitLiveUpdate()
      }

      emitLiveUpdate()
      let results: Array<{
        index: number
        outputPath: string
        result: Awaited<ReturnType<typeof runSubAgent>>
      }> = []
      const failures: Array<{ index: number; error: string }> = []
      let herdrParentLabel: string | undefined
      let herdrWarning: string | undefined
      let runInChildProcesses = !isHerdrEnvironment()
      let herdrRunStarted = false

      if (!runInChildProcesses) {
        try {
          const parentLabel =
            ctx.sessionManager.getSessionName() ||
            (await getHerdrParentLabel(path.basename(ctx.cwd), ctx.cwd))
          herdrRunStarted = true
          const herdrOutcomes = await runSubagentsInHerdr(
            preparedAgents.map(agent => ({
              ...agent,
              prompt: getParentAssignedPrompt(agent.prompt),
            })),
            runDirectory,
            ctx.sessionManager.getSessionId(),
            parentLabel,
            signal,
            (index, status) => {
              liveAgents[index].status = status
              emitLiveUpdate()
            },
            emitAgentTool,
          )
          herdrParentLabel = parentLabel
          results = herdrOutcomes.flatMap(outcome => {
            if ('error' in outcome) {
              failures.push({ index: outcome.index, error: outcome.error })
              return []
            }
            const { index, result } = outcome
            const agent = preparedAgents[index]
            const outputPath = path.join(
              runDirectory,
              `${sanitizeFileName(agent.name)}-result.md`,
            )
            fs.writeFileSync(outputPath, result.text)
            liveAgents[index].exitCode = result.exitCode
            liveAgents[index].outputPath = outputPath
            liveAgents[index].usage = result.usage
            emitLiveUpdate()
            return [{ index, outputPath, result }]
          })
        } catch (error) {
          if (herdrRunStarted && !(error instanceof HerdrInitializationError)) throw error
          herdrWarning = errorText(error)
          runInChildProcesses = true
        }
      }

      if (runInChildProcesses) {
        const outcomes = await Promise.allSettled(
          preparedAgents.map(async (agent, index) => {
            liveAgents[index].status = 'running'
            emitLiveUpdate()
            try {
              const result = await runSubAgent(
                agent.effectiveModel,
                agent.thinking,
                getParentAssignedPrompt(agent.prompt),
                agent.cwd,
                agent.sessionPath,
                agent.promptCacheKey,
                signal,
                tool => emitAgentTool(index, tool),
              )
              const outputPath = path.join(
                runDirectory,
                `${sanitizeFileName(agent.name)}-result.md`,
              )
              fs.writeFileSync(outputPath, result.text)
              liveAgents[index].status = result.exitCode === 0 ? 'done' : 'failed'
              liveAgents[index].exitCode = result.exitCode
              liveAgents[index].outputPath = outputPath
              liveAgents[index].usage = result.usage
              emitLiveUpdate()
              return { index, outputPath, result }
            } catch (error) {
              liveAgents[index].status = signal.aborted ? 'interrupted' : 'failed'
              if (!signal.aborted) emitLiveUpdate()
              throw error
            }
          }),
        )

        if (signal.aborted) {
          const sessions = resolvedAgents
            .map(agent => `${agent.name}: ${agent.sessionKey}`)
            .join(', ')
          throw new Error(
            `Subagents were interrupted. Resume with the same sessionKey values: ${sessions}`,
          )
        }

        results = outcomes.flatMap((outcome, index) => {
          if (outcome.status === 'fulfilled') return [outcome.value]
          failures.push({ index, error: errorText(outcome.reason) })
          return []
        })
      }

      const sortedResults = [...results].sort((a, b) => a.index - b.index)
      const successfulResults = new Map(sortedResults.map(result => [result.index, result]))
      const failedResults = new Map(failures.map(failure => [failure.index, failure]))
      const lines = resolvedAgents.flatMap((agent, index) => {
        const successful = successfulResults.get(index)
        if (!successful) {
          const failed = failedResults.get(index)
          if (!failed) return []
          return [
            `${agent.name}: FAILED (exit/unknown) resume with sessionKey "${agent.sessionKey}": ${failed.error}`,
          ]
        }
        return formatFinishedAgentResult(
          agent,
          successful.outputPath,
          successful.result,
          !!(agent.forkParent && preparedAgents[index].promptCacheKey),
        )
      })
      if (sortedResults.length > 1) {
        lines.push(
          `Total: ${formatUsageStats(sumUsageStats(sortedResults.map(({ result }) => result.usage)))}`,
        )
      }
      if (herdrParentLabel) {
        lines.push(
          `Panes: tab "subagents · ${herdrParentLabel}" in Herdr`,
          "Review: run 'herdr plugin pane open --plugin local.simple-subagent --entrypoint subagents --placement overlay --focus' or press your bound key",
        )
      }
      if (herdrWarning) lines.push(`Warning: Herdr mode unavailable: ${herdrWarning}`)
      latestDetails = snapshotDetails(liveEvents, liveAgents)
      const doneCount = results.filter(({ result }) => result.exitCode === 0).length
      const failedCount = preparedAgents.length - doneCount

      return {
        text: lines.join('\n'),
        details: latestDetails,
        isError: failures.length > 0 || results.some(({ result }) => result.exitCode !== 0),
        herdrNotification: herdrParentLabel
          ? { cwd: preparedAgents[0].cwd, doneCount, failedCount }
          : undefined,
      }
    },
  })
}
