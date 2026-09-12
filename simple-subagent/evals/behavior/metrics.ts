import type { TraceEvent, Usage, RunResult } from './types.ts'

export function parseTrace(text: string): TraceEvent[] {
  // Readers may observe the last append while it is still being written.
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function usage(events: TraceEvent[], role: 'parent' | 'child'): Usage {
  const result: Usage = { requests: 0, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, usageMissing: 0 }
  for (const event of events.filter(event => event.role === role)) {
    if (event.type === 'provider-request') result.requests++
    if (event.type !== 'assistant-message') continue
    result.messages++
    const value = event.data.usage
    if (!value) { result.usageMissing++; continue }
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      if (typeof value[key] === 'number') result[key] += value[key]
    }
    if (typeof value.cost?.total === 'number') result.cost += value.cost.total
  }
  return result
}

export function measure(events: TraceEvent[]) {
  const parent = usage(events, 'parent')
  const child = usage(events, 'child')
  const starts = events.filter(event => event.type === 'job-start')
  const completed = events.filter(event => event.type === 'job-result')
  const deliveries = events.filter(event => event.type === 'push')
  const start = events[0]?.at ?? 0
  const uniqueChildren = new Set(events.filter(event => event.type === 'session-start' && event.role === 'child').map(event => event.sessionId))
  const toolErrors = events.filter(event => event.type === 'tool-result' && event.data.isError)
  const calls = events.filter(event => event.type === 'tool-call' && event.role === 'parent')
  const pushes = deliveries.flatMap(event => event.data.jobIds as string[])
  const followUps = events.filter(event => event.type === 'follow-up')
  const cancellations = events.filter(event => event.type === 'cancel' && event.data.accepted)
  const activeAtRequest = events.filter(event => event.role === 'parent' && event.type === 'provider-request').map(request => ({
    at: request.at,
    pending: starts.filter(job => job.at < request.at && !completed.some(done => done.data.jobId === job.data.jobId && done.at <= request.at)).length,
  }))
  return {
    elapsedMs: Math.max(0, (events.at(-1)?.at ?? start) - start),
    firstJobResultMs: completed.length ? Math.min(...completed.map(event => event.at)) - start : null,
    parent, child,
    childSessions: uniqueChildren.size,
    jobs: starts.length,
    dispatchedAgents: starts.reduce((sum, event) => sum + (event.data.agents?.length ?? 0), 0),
    parentToolCalls: calls.length,
    parentToolErrors: toolErrors.filter(event => event.role === 'parent').length,
    childToolErrors: toolErrors.filter(event => event.role === 'child').length,
    automaticMessages: deliveries.length,
    duplicatePushes: pushes.length - new Set(pushes).size,
    parentRequestsWithPendingJobs: activeAtRequest.filter(item => item.pending > 0).length,
    parentRequestBytes: events.filter(event => event.type === 'provider-request' && event.role === 'parent').reduce((sum, event) => sum + (event.data.bytes ?? 0), 0),
    interfaces: starts.map(event => event.data.via as string),
    clientRuns: starts.filter(event => event.data.via === 'client').length,
    // These are diagnostics, not automatic claims that a call was unnecessary.
    possiblePollingCalls: calls.filter(event => event.data.name === 'bash' && /\b(sleep|while|watch)\b/.test(event.data.args?.command ?? '')).length,
    cancellationLatencyMs: cancellations.map(cancel => {
      const request = followUps.filter(event => event.at <= cancel.at).at(-1)
      const done = completed.find(event => event.data.jobId === cancel.data.jobId)
      return { jobId: cancel.data.jobId, userToCancel: request ? cancel.at - request.at : null, cancelToSettle: done ? done.at - cancel.at : null }
    }),
    artifactTimings: events.filter(event => event.type === 'artifact-change').map(event => ({ path: event.data.path, elapsedMs: event.at - start })),
    usageComplete: parent.usageMissing === 0 && child.usageMissing === 0 && parent.requests === parent.messages && child.requests === child.messages && (uniqueChildren.size === 0 || child.messages > 0),
  }
}

export function wilson(successes: number, count: number): [number, number] | null {
  if (!count) return null
  const z = 1.96, p = successes / count, d = 1 + z * z / count
  const center = (p + z * z / (2 * count)) / d
  const radius = z * Math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / d
  return [Math.max(0, center - radius), Math.min(1, center + radius)]
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function summarize(results: RunResult[]) {
  const groups = new Map<string, RunResult[]>()
  for (const result of results) {
    const key = `${result.model} | ${result.scenario} | ${result.variant}`
    groups.set(key, [...(groups.get(key) ?? []), result])
  }
  return [...groups].map(([key, runs]) => {
    const eligible = runs.filter(run => run.status !== 'infrastructure-error' && run.status !== 'interrupted')
    const passed = eligible.filter(run => run.status === 'passed')
    return {
      key, attempts: runs.length, eligible: eligible.length, passed: passed.length,
      infrastructureErrors: runs.filter(run => run.status === 'infrastructure-error').length,
      interrupted: runs.filter(run => run.status === 'interrupted').length,
      successRate: eligible.length ? passed.length / eligible.length : null,
      successRate95: wilson(passed.length, eligible.length),
      medianElapsedMsAll: median(eligible.map(run => run.metrics.elapsedMs)),
      medianElapsedMsPassed: median(passed.map(run => run.metrics.elapsedMs)),
      medianParentRequestsPassed: median(passed.map(run => run.metrics.parent.requests)),
      medianParentInputPassed: median(passed.map(run => run.metrics.parent.input)),
      medianParentCacheReadPassed: median(passed.map(run => run.metrics.parent.cacheRead)),
      medianParentOutputPassed: median(passed.map(run => run.metrics.parent.output)),
      medianChildOutputPassed: median(passed.map(run => run.metrics.child.output)),
      totalReportedCostAll: runs.reduce((sum, run) => sum + run.metrics.parent.cost + run.metrics.child.cost, 0),
    }
  })
}
