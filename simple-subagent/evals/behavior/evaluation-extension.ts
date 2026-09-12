// Evaluation-only instrumentation. Production execution remains in
// registerSubagentTools/registerClientBridge; no mock children are used.
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { registerClientBridge } from '../../extensions/client-bridge.ts'
import { registerSubagentTools, type IsolatedDispatchRequest } from '../../extensions/tools.ts'
import type { RunConfig, TraceEvent } from './types.ts'
import { readBudget, recordTokens, reserveRequest, usageTokens } from './budget.ts'

export default function evaluationExtension(pi: ExtensionAPI) {
  const config = JSON.parse(readFileSync(process.env.SUBAGENT_EVAL_CONFIG!, 'utf8')) as RunConfig
  const child = process.env.PI_SIMPLE_SUBAGENT === '1'
  let sessionId: string | undefined
  const trace = (type: string, data: Record<string, unknown> = {}) => {
    const event: TraceEvent = { at: Date.now(), type, role: child ? 'child' : 'parent', pid: process.pid, sessionId, data }
    appendFileSync(config.tracePath, `${JSON.stringify(event)}\n`)
  }
  const snapshots = new Map<string, string[]>()
  const hashFiles = () => config.watch.map(path => {
    try { return createHash('sha256').update(readFileSync(join(config.workdir, path))).digest('hex') } catch { return 'absent' }
  })
  pi.on('session_start', (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId()
    process.env.SUBAGENT_EVAL_SESSION = sessionId
    process.env.SUBAGENT_EVAL_ACTOR_PID = String(process.pid)
    trace('session-start', { path: ctx.sessionManager.getSessionFile(), mode: ctx.mode, model: ctx.model?.id })
    if (child) {
      for (const key of ['PI_SIMPLE_SUBAGENT_ENDPOINT', 'PI_SIMPLE_SUBAGENT_TOKEN', 'PI_SIMPLE_SUBAGENT_CLIENT']) delete process.env[key]
    }
  })
  pi.on('before_provider_request', async event => {
    const budget = config.campaignBudget
    if (budget) {
      let reason: string | undefined
      try {
        if (Date.now() >= budget.deadline) reason = 'campaign time limit'
        else if (readBudget(budget.directory).tokens >= budget.tokens) reason = 'campaign token limit'
        else if (!reserveRequest(budget.trialDirectory, config.maxRequests)) reason = 'trial request limit'
        else if (!reserveRequest(join(budget.directory, 'requests'), budget.requests)) reason = 'campaign request limit'
      } catch (error) { reason = `budget accounting failed: ${String(error)}` }
      if (reason) {
        trace('budget-denied', { reason })
        // Extension hook exceptions are swallowed by Pi. Hold before sending;
        // the supervising runner observes this event and tears down the group.
        await new Promise<never>(() => {})
      }
    }
    const serialized = JSON.stringify(event.payload)
    trace('provider-request', { bytes: Buffer.byteLength(serialized), sha256: createHash('sha256').update(serialized).digest('hex') })
  })
  pi.on('after_provider_response', event => { trace('provider-response', { status: event.status }) })
  pi.on('message_end', event => {
    const message = event.message as any
    if (message.role === 'assistant' && config.campaignBudget) recordTokens(config.campaignBudget.directory, usageTokens(message.usage))
    if (message.role === 'assistant') trace('assistant-message', {
      usage: message.usage, stopReason: message.stopReason, error: message.errorMessage,
      text: message.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('') ?? '',
    })
  })
  pi.on('agent_start', () => { trace('agent-start') })
  pi.on('agent_end', () => { trace('agent-end') })
  pi.on('agent_settled', () => { trace('agent-settled') })
  pi.on('session_shutdown', () => { trace('session-shutdown') })
  pi.on('tool_call', event => {
    snapshots.set(event.toolCallId, hashFiles())
    trace('tool-call', { id: event.toolCallId, name: event.toolName, args: event.input })
  })
  pi.on('tool_result', event => {
    const before = snapshots.get(event.toolCallId)
    snapshots.delete(event.toolCallId)
    const after = hashFiles()
    trace('tool-result', {
      id: event.toolCallId, name: event.toolName, isError: event.isError,
      text: event.content.filter(part => part.type === 'text').map(part => part.text).join('\n'),
      // A concurrent writer can overlap a tool. This is provenance evidence,
      // not OS-level attribution; artifact timing is observed independently.
      changed: before ? config.watch.filter((_path, index) => before[index] !== after[index]) : [],
    })
  })
  if (child) return

  // Parent: production tools with tracing. `client` is production as shipped. `native`
  // removes the Node client and its hint from the tool description as the control arm.
  const seenResults = new Set<string>()
  const recordResult = (jobId: string, result: any) => {
    if (seenResults.has(jobId)) return
    seenResults.add(jobId)
    trace('job-result', { jobId, result })
  }
  const fixedAgents = (agents: IsolatedDispatchRequest[]): IsolatedDispatchRequest[] =>
    agents.map(agent => ({ ...agent, thinking: config.thinking as IsolatedDispatchRequest['thinking'], overrideModel: config.model }))
  let runtime: ReturnType<typeof registerSubagentTools> | undefined
  const proxy = new Proxy(pi, {
    get(target, property) {
      if (property === 'sendUserMessage') return (text: string, options: any) => {
        const jobId = /^Subagent job (\S+) finished\./.exec(text)?.[1]
        if (jobId) {
          trace('push', { jobIds: [jobId], options })
          void runtime!.join(jobId, undefined).then(result => recordResult(jobId, result))
        }
        return target.sendUserMessage(text, options)
      }
      if (property === 'registerTool') return (definition: ToolDefinition<any, any>) => {
        const execute = definition.execute.bind(definition)
        if (definition.name === 'runSubAgents') {
          if (config.variant === 'native') {
            definition.description = definition.description.split('\n').filter(line => !line.includes('PI_SIMPLE_SUBAGENT_CLIENT')).join('\n')
          }
          definition.execute = async (id, args: any, signal, update, ctx) => {
            const result = await execute(id, { ...args, agents: fixedAgents(args.agents) }, signal, update, ctx)
            trace('job-start', { jobId: result.details.jobId, via: 'native', agents: args.agents })
            return result
          }
        }
        if (definition.name === 'cancelSubAgents') {
          definition.execute = async (id, args: any, signal, update, ctx) => {
            try {
              const result = await execute(id, args, signal, update, ctx)
              trace('cancel', { jobId: args.jobId, accepted: true })
              return result
            } catch (error) {
              trace('cancel', { jobId: args.jobId, accepted: false })
              throw error
            }
          }
        }
        target.registerTool(definition)
      }
      return Reflect.get(target, property)
    },
  }) as ExtensionAPI

  const bridge = config.variant === 'client' ? registerClientBridge(proxy) : undefined
  runtime = registerSubagentTools(proxy, false, { enableForkTool: false, modelAliases: {} })
  bridge?.attach({
    ...runtime,
    dispatchIsolated(agents: IsolatedDispatchRequest[], id, ctx) {
      const job = runtime!.dispatchIsolated(fixedAgents(agents), id, ctx)
      trace('job-start', { jobId: job.id, via: 'client', agents })
      return job
    },
    async join(jobId: string, signal: AbortSignal | undefined) {
      const result = await runtime!.join(jobId, signal)
      recordResult(jobId, result)
      return result
    },
  })
  bridge?.registerClosureWait()
  pi.on('before_agent_start', event => {
    trace('effective-prompt', { systemPrompt: event.systemPrompt, variant: config.variant })
  })
}
