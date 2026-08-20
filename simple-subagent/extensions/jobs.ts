import { randomUUID } from 'node:crypto'
import type { SubagentResultDetails } from './types.ts'

export type SubagentJobKind = 'isolated' | 'fork'
export type SubagentJobAgentState = 'running' | 'done' | 'delivered'

export type SubagentJobResult = {
  text: string
  details: SubagentResultDetails
  isError: boolean
}

export type SubagentJobAgent = {
  name: string
  sessionKey: string
  state: SubagentJobAgentState
}

export type SubagentJob = {
  id: string
  kind: SubagentJobKind
  agents: SubagentJobAgent[]
  startedAt: number
  settle: Promise<void>
  controller: AbortController
  result?: SubagentJobResult
}

type Collector = {
  resolve: (result: SubagentJobResult | undefined) => void
  reject: (error: unknown) => void
  signal: AbortSignal | undefined
  abortHandler?: () => void
}

type InternalJob = SubagentJob & {
  started: boolean
  settled: boolean
  failureResult: (error: unknown, aborted: boolean) => SubagentJobResult
  resolveSettle: () => void
  collectors: Collector[]
}

type JobRegistryEvents = {
  onProgress?: (job: SubagentJob, details: SubagentResultDetails) => void
  onSettled?: (job: SubagentJob, result: SubagentJobResult) => void
  onPush?: (job: SubagentJob, result: SubagentJobResult) => void
}

type StartJobInput = {
  id: string
  kind: SubagentJobKind
  agents: Array<{ name: string; sessionKey: string }>
  run: (
    signal: AbortSignal,
    update: (details: SubagentResultDetails) => void,
  ) => Promise<SubagentJobResult>
  failureResult: (error: unknown, aborted: boolean) => SubagentJobResult
}

function abortError(): DOMException {
  return new DOMException('Collect aborted', 'AbortError')
}

export function createJobId(
  exists: (id: string) => boolean,
  generate: () => string = randomUUID,
): string {
  let id: string
  do {
    id = generate().slice(0, 8)
  } while (exists(id))
  return id
}

export class JobRegistry {
  private readonly jobs = new Map<string, InternalJob>()
  private readonly events: JobRegistryEvents
  private suppressDelivery = false

  constructor(events: JobRegistryEvents = {}) {
    this.events = events
  }

  reserve(
    id: string,
    kind: SubagentJobKind,
    agents: Array<{ name: string; sessionKey: string }>,
    failureResult: (error: unknown, aborted: boolean) => SubagentJobResult,
  ): SubagentJob {
    if (this.jobs.has(id)) throw new Error(`Subagent job already exists: ${id}`)

    let resolveSettle!: () => void
    const settle = new Promise<void>(resolve => {
      resolveSettle = resolve
    })
    const job: InternalJob = {
      id,
      kind,
      agents: agents.map(agent => ({ ...agent, state: 'running' })),
      startedAt: Date.now(),
      settle,
      controller: new AbortController(),
      started: false,
      settled: false,
      failureResult,
      resolveSettle,
      collectors: [],
    }
    this.jobs.set(id, job)
    return job
  }

  start(input: StartJobInput): SubagentJob {
    const job = this.jobs.get(input.id) as InternalJob | undefined
    const current =
      job || this.reserve(input.id, input.kind, input.agents, input.failureResult) as InternalJob
    if (current.settled) return current
    if (current.started) throw new Error(`Subagent job already started: ${input.id}`)
    current.started = true
    current.failureResult = input.failureResult

    let run: Promise<SubagentJobResult>
    try {
      run = input.run(current.controller.signal, details => this.update(current, details))
    } catch (error) {
      this.finalize(current, input.failureResult(error, current.controller.signal.aborted))
      return current
    }
    void run.then(
      result => this.finalize(current, result),
      error =>
        this.finalize(
          current,
          input.failureResult(error, current.controller.signal.aborted),
        ),
    )
    return current
  }

  fail(id: string, result: SubagentJobResult): void {
    const job = this.require(id)
    this.finalize(job, result)
  }

  get(id: string): SubagentJob | undefined {
    return this.jobs.get(id)
  }

  isRunning(id: string): boolean {
    const job = this.jobs.get(id)
    return !!job && !job.settled
  }

  listRunning(): SubagentJob[] {
    return [...this.jobs.values()].filter(job => !job.settled)
  }

  collect(id: string, signal: AbortSignal | undefined): Promise<SubagentJobResult | undefined> {
    const job = this.require(id)
    if (signal?.aborted) return Promise.reject(abortError())
    if (job.settled) return Promise.resolve(this.takeResult(job))

    return new Promise((resolve, reject) => {
      const collector: Collector = { resolve, reject, signal }
      if (signal) {
        collector.abortHandler = () => {
          const index = job.collectors.indexOf(collector)
          if (index >= 0) job.collectors.splice(index, 1)
          reject(abortError())
        }
        signal.addEventListener('abort', collector.abortHandler, { once: true })
      }
      job.collectors.push(collector)
    })
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job || job.settled) return false
    job.controller.abort(`Subagent job ${id} cancelled`)
    if (!job.started) this.finalize(job, job.failureResult(job.controller.signal.reason, true))
    return true
  }

  async waitForPending(): Promise<void> {
    while (true) {
      const pending = this.listRunning()
      if (pending.length === 0) return
      await Promise.all(pending.map(job => job.settle))
    }
  }

  async shutdown(): Promise<void> {
    this.suppressDelivery = true
    const pending = [...this.jobs.values()].filter(job => !job.settled)
    for (const job of pending) {
      job.controller.abort('Session shutdown')
      if (!job.started) this.finalize(job, job.failureResult(job.controller.signal.reason, true))
    }
    await Promise.all(pending.map(job => job.settle))
  }

  private update(job: InternalJob, details: SubagentResultDetails): void {
    details.agents.forEach((agent, index) => {
      if (!job.agents[index] || job.agents[index].state === 'delivered') return
      if (agent.status === 'done' || agent.status === 'failed' || agent.status === 'interrupted') {
        job.agents[index].state = 'done'
      }
    })
    this.events.onProgress?.(job, details)
  }

  private finalize(job: InternalJob, result: SubagentJobResult): void {
    if (job.settled) return
    job.settled = true
    job.result = result
    for (const agent of job.agents) agent.state = 'done'
    this.events.onSettled?.(job, result)

    const collector = job.collectors.shift()
    if (collector) {
      this.removeAbortHandler(collector)
      const delivered = this.takeResult(job)
      collector.resolve(delivered)
      for (const extra of job.collectors.splice(0)) {
        this.removeAbortHandler(extra)
        extra.resolve(undefined)
      }
    } else if (!this.suppressDelivery) {
      const delivered = this.takeResult(job)
      if (delivered) {
        this.events.onPush?.(job, delivered)
      }
    }
    job.resolveSettle()
  }

  private takeResult(job: InternalJob): SubagentJobResult | undefined {
    if (!job.result || job.agents.every(agent => agent.state === 'delivered')) return undefined
    for (const agent of job.agents) agent.state = 'delivered'
    return job.result
  }

  private require(id: string): InternalJob {
    const job = this.jobs.get(id)
    if (!job) throw new Error(`Unknown subagent job: ${id}`)
    return job
  }

  private removeAbortHandler(collector: Collector): void {
    if (collector.signal && collector.abortHandler) {
      collector.signal.removeEventListener('abort', collector.abortHandler)
    }
  }
}

export function getPushOptions(
  isIdle: boolean,
): { deliverAs: 'steer' } | { triggerTurn: true } {
  return isIdle ? { triggerTurn: true } : { deliverAs: 'steer' }
}

export async function holdPrintModeJobs(
  mode: 'tui' | 'rpc' | 'json' | 'print',
  jobs: JobRegistry,
): Promise<void> {
  if (mode === 'print' || mode === 'json') await jobs.waitForPending()
}
