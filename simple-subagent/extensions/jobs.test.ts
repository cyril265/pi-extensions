import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getPushOptions,
  holdPrintModeJobs,
  JobRegistry,
  type SubagentJobResult,
} from './jobs.ts'

function result(text = 'done'): SubagentJobResult {
  return {
    text,
    details: {
      agents: [
        {
          name: 'reviewer',
          thinking: 'medium',
          sessionKey: 'reviewer-key',
          status: 'done',
        },
      ],
    },
    isError: false,
  }
}

function failure(error: unknown): SubagentJobResult {
  return {
    ...result(error instanceof Error ? error.message : String(error)),
    isError: true,
  }
}

test('settles into one waiting collector and never delivers the same result twice', async () => {
  let finish!: (value: SubagentJobResult) => void
  const run = new Promise<SubagentJobResult>(resolve => {
    finish = resolve
  })
  const pushed: string[] = []
  const jobs = new JobRegistry({
    onPush: (_job, jobResult) => pushed.push(jobResult.text),
  })
  const job = jobs.start({
    id: 'job-1',
    kind: 'isolated',
    agents: [{ name: 'reviewer', sessionKey: 'reviewer-key' }],
    run: () => run,
    failureResult: failure,
  })

  const collected = jobs.collect(job.id, undefined)
  finish(result())

  assert.equal((await collected)?.text, 'done')
  assert.deepEqual(pushed, [])
  assert.deepEqual(job.agents.map(agent => agent.state), ['delivered'])
  assert.equal(await jobs.collect(job.id, undefined), undefined)
})

test('pushes settled results once and routes streaming and idle delivery differently', async () => {
  const pushed: string[] = []
  const jobs = new JobRegistry({
    onPush: (_job, jobResult) => pushed.push(jobResult.text),
  })
  const job = jobs.start({
    id: 'job-2',
    kind: 'isolated',
    agents: [{ name: 'reviewer', sessionKey: 'reviewer-key' }],
    run: async () => result('pushed'),
    failureResult: failure,
  })

  await job.settle

  assert.deepEqual(pushed, ['pushed'])
  assert.equal(await jobs.collect(job.id, undefined), undefined)
  assert.deepEqual(getPushOptions(false), { deliverAs: 'followUp' })
  assert.deepEqual(getPushOptions(true), { triggerTurn: true })
})

test('aborting collect leaves the job running for later push delivery', async () => {
  let finish!: (value: SubagentJobResult) => void
  const run = new Promise<SubagentJobResult>(resolve => {
    finish = resolve
  })
  const pushed: string[] = []
  const jobs = new JobRegistry({
    onPush: (_job, jobResult) => pushed.push(jobResult.text),
  })
  const job = jobs.start({
    id: 'job-3',
    kind: 'isolated',
    agents: [{ name: 'reviewer', sessionKey: 'reviewer-key' }],
    run: () => run,
    failureResult: failure,
  })
  const controller = new AbortController()
  const collected = jobs.collect(job.id, controller.signal)

  controller.abort()
  await assert.rejects(collected, error => error instanceof DOMException && error.name === 'AbortError')
  assert.equal(jobs.isRunning(job.id), true)

  finish(result('after abort'))
  await job.settle
  assert.deepEqual(pushed, ['after abort'])
})

for (const mode of ['print', 'json'] as const) {
  test(`${mode} single-shot mode waits for pending jobs`, async () => {
    let finish!: (value: SubagentJobResult) => void
    const run = new Promise<SubagentJobResult>(resolve => {
      finish = resolve
    })
    const jobs = new JobRegistry()
    jobs.start({
      id: `job-${mode}`,
      kind: 'isolated',
      agents: [{ name: 'reviewer', sessionKey: 'reviewer-key' }],
      run: () => run,
      failureResult: failure,
    })

    await holdPrintModeJobs('tui', jobs)
    let released = false
    const hold = holdPrintModeJobs(mode, jobs).then(() => {
      released = true
    })
    await Promise.resolve()
    assert.equal(released, false)

    finish(result())
    await hold
    assert.equal(released, true)
  })
}
