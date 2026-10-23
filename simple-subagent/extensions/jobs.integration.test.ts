import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { JobRegistry, type SubagentJobResult } from './jobs.ts'

// Exercise result retention with real artifact IO. These jobs read saved reports;
// they do not simulate child agents or make provider requests.
for (const delivery of ['push', 'join'] as const) {
  test(`saved results survive ${delivery} and repeated retrieval until shutdown`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'subagent-result-retention-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const outputPath = join(directory, 'report.md')
    const deliveryPath = join(directory, 'delivered.md')
    const report = 'Release blocked.\n'.repeat(500)
    await writeFile(outputPath, report)
    const notifications: SubagentJobResult[] = []
    const delivered: string[] = []
    const jobs = new JobRegistry({
      async onPush(_job, result) {
        await writeFile(deliveryPath, result.text)
        notifications.push({ ...result, text: await readFile(deliveryPath, 'utf8') })
      },
      onDelivered: job => { delivered.push(job.id) },
    })
    t.after(() => jobs.shutdown())
    const job = jobs.start({
      id: 'report',
      kind: 'isolated',
      agents: [{ name: 'report', sessionKey: 'report-session' }],
      async run() {
        return {
          text: await readFile(outputPath, 'utf8'),
          isError: false,
          details: { agents: [{ name: 'report', thinking: 'medium', outputPath }] },
        }
      },
      failureResult: error => ({ text: String(error), isError: true, details: { agents: [] } }),
    })
    assert.throws(() => jobs.getResult(job.id), /still running/)
    assert.throws(() => jobs.getResult('unknown'), /Unknown subagent job/)
    const waiters = delivery === 'join'
      ? [jobs.join(job.id, undefined), jobs.join(job.id, undefined)]
      : []
    await job.settle
    const saved = jobs.getResult(job.id)
    assert.equal(saved.text, report)
    for (const result of await Promise.all(waiters)) assert.equal(result, saved)
    for (let read = 0; read < 2; read += 1) {
      assert.equal(jobs.getResult(job.id), saved)
      assert.equal(await jobs.join(job.id, undefined), saved)
      assert.equal(await readFile(outputPath, 'utf8'), report)
    }
    assert.equal(notifications.length, delivery === 'push' ? 1 : 0)
    if (delivery === 'push') assert.equal(await readFile(deliveryPath, 'utf8'), report)
    assert.deepEqual(delivered, [job.id])
    assert.deepEqual(jobs.listRunning(), [])
    await jobs.shutdown()
    assert.throws(() => jobs.getResult(job.id), /Unknown subagent job/)
    assert.equal(await readFile(outputPath, 'utf8'), report)
  })
}

test('a failed asynchronous push keeps the result available for explicit retrieval', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'subagent-result-delivery-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const errors: unknown[] = []
  const delivered: string[] = []
  const jobs = new JobRegistry({
    async onPush(_job, result) {
      await writeFile(directory, result.text)
    },
    onPushError(_job, error) {
      errors.push(error)
    },
    onDelivered(job) {
      delivered.push(job.id)
    },
  })
  t.after(() => jobs.shutdown())

  const job = jobs.start({
    id: 'failed-delivery',
    kind: 'isolated',
    agents: [{ name: 'report', sessionKey: 'report-session' }],
    async run() {
      return { text: 'finished', isError: false, details: { agents: [] } }
    },
    failureResult: error => ({ text: String(error), isError: true, details: { agents: [] } }),
  })

  await job.settle
  assert.equal(errors.length, 1)
  assert.deepEqual(job.agents.map(agent => agent.state), ['done'])
  assert.deepEqual(delivered, [])
  assert.equal((await jobs.join(job.id, undefined)).text, 'finished')
  assert.deepEqual(job.agents.map(agent => agent.state), ['delivered'])
  assert.deepEqual(delivered, [job.id])
})
