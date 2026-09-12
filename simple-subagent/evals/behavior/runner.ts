import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { measure, parseTrace, summarize } from './metrics.ts'
import { scenarios, getScenario } from './scenarios.ts'
import { variants, type Variant, type RunConfig, type RunResult, type TraceEvent, type Check } from './types.ts'
import { pairedComparisons, renderReport } from './report.ts'
import { budgetReason, readBudget, usageTokens } from './budget.ts'

const packageRoot = resolve(import.meta.dirname, '../..')
const extensionPath = join(import.meta.dirname, 'evaluation-extension.ts')
const piPath = join(packageRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js')
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

export type Options = {
  models: string[]; variants: Variant[]; cases: string[]; repeats: number; seed: number
  timeout: number; maxRequests: number; maxTokens: number; thinking: string; out?: string; execute: boolean
  maxRuns: number; campaignRequests: number; campaignTokens: number; campaignTimeout: number
  keepGoing: boolean; rerunFailed?: string; regrade?: string
}

export function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({ args: argv, options: {
    models: { type: 'string', default: 'openai-codex/gpt-5.6-sol' },
    variants: { type: 'string', default: 'native,client' },
    cases: { type: 'string', default: 'small-local-change,parallel-repair' },
    repeats: { type: 'string', default: '1' }, seed: { type: 'string', default: '1729' },
    timeout: { type: 'string', default: '180' }, 'max-requests': { type: 'string', default: '30' },
    'max-tokens': { type: 'string', default: '100000' }, thinking: { type: 'string', default: 'medium' },
    'max-runs': { type: 'string', default: '4' }, 'campaign-requests': { type: 'string', default: '60' },
    'campaign-tokens': { type: 'string', default: '200000' }, 'campaign-timeout': { type: 'string', default: '600' },
    'keep-going': { type: 'boolean', default: false }, 'rerun-failed': { type: 'string' }, regrade: { type: 'string' },
    out: { type: 'string' }, execute: { type: 'boolean', default: false },
  }, strict: true, allowPositionals: false })
  const positive = (key: 'repeats' | 'seed' | 'timeout' | 'max-requests' | 'max-tokens' | 'max-runs' | 'campaign-requests' | 'campaign-tokens' | 'campaign-timeout') => {
    const value = Number(values[key])
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`)
    return value
  }
  const list = (value: string) => [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))]
  const selectedVariants = list(values.variants!)
  for (const variant of selectedVariants) if (!(variants as readonly string[]).includes(variant)) throw new Error(`Unknown variant: ${variant}`)
  const cases = values.cases === 'all' ? scenarios.map(item => item.id) : list(values.cases!)
  for (const id of cases) getScenario(id)
  const models = list(values.models!)
  if (!models.length || models.some(model => !model.includes('/'))) throw new Error('models must contain provider/model identifiers')
  if (!selectedVariants.length || !cases.length) throw new Error('Select at least one variant and case')
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(values.thinking!)) throw new Error('Unsupported thinking level')
  if (values.regrade && (values.execute || values['rerun-failed'])) throw new Error('--regrade is offline and cannot be combined with --execute or --rerun-failed')
  if (values['rerun-failed'] && argv.some(arg => /^--(models|thinking|cases|variants|repeats|seed)(=|$)/.test(arg))) throw new Error('--rerun-failed preserves the original trial settings; use budget flags to limit the retry')
  return {
    models, variants: selectedVariants as Variant[], cases, repeats: positive('repeats'), seed: positive('seed'),
    timeout: positive('timeout'), maxRequests: positive('max-requests'), maxTokens: positive('max-tokens'),
    thinking: values.thinking!, out: values.out, execute: values.execute!,
    maxRuns: positive('max-runs'), campaignRequests: positive('campaign-requests'), campaignTokens: positive('campaign-tokens'), campaignTimeout: positive('campaign-timeout'),
    keepGoing: values['keep-going']!, rerunFailed: values['rerun-failed'], regrade: values.regrade,
  }
}

export function buildPlan(options: Options) {
  if (options.rerunFailed) return loadResults(options.rerunFailed).filter(result => result.status !== 'passed').map(({ model, thinking, scenario, variant, seed, repeat }) => ({ model, thinking, scenario, variant, seed, repeat }))
  let state = options.seed >>> 0
  const random = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296 }
  const plan: Array<{ model: string; thinking: string; scenario: string; variant: Variant; seed: number; repeat: number }> = []
  for (const model of options.models) for (const scenario of options.cases) for (let repeat = 1; repeat <= options.repeats; repeat++) {
    const order = [...options.variants]
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]
    }
    for (const variant of order) plan.push({ model, thinking: options.thinking, scenario, variant, seed: options.seed + repeat - 1, repeat })
  }
  return plan
}

export function loadResults(source: string): RunResult[] {
  const file = source.endsWith('.jsonl') ? resolve(source) : join(resolve(source), 'results.jsonl')
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => {
    const result = JSON.parse(line) as RunResult
    getScenario(result.scenario)
    if (!variants.includes(result.variant) || typeof result.model !== 'string' || !result.model.includes('/') ||
      !['low', 'medium', 'high', 'xhigh', 'max'].includes(result.thinking) || !Number.isSafeInteger(result.seed) ||
      !Number.isSafeInteger(result.repeat) || typeof result.artifactDirectory !== 'string' || !Array.isArray(result.checks)) throw new Error(`Invalid saved trial in ${file}`)
    return result
  })
}

export function writeReports(output: string, results: RunResult[]): void {
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summarize(results), null, 2))
  writeFileSync(join(output, 'paired-comparisons.json'), JSON.stringify(pairedComparisons(results), null, 2))
  writeFileSync(join(output, 'report.md'), renderReport(results, output))
}

export function regradeCampaign(source: string, output: string): RunResult[] {
  if (existsSync(join(output, 'results.jsonl')) || existsSync(join(output, 'manifest.json'))) throw new Error('Regrading requires a fresh output directory')
  const previous = loadResults(source)
  mkdirSync(output, { recursive: true })
  const results = previous.map(result => {
    const directory = result.artifactDirectory
    const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8')) as RunConfig
    const allEvents = parseTrace(readFileSync(join(directory, 'trace.jsonl'), 'utf8'))
    const cutoff = allEvents.findIndex(event => event.type === 'run-end')
    const events = cutoff < 0 ? allEvents : allEvents.slice(0, cutoff + 1)
    const metrics = measure(events)
    const checks = [
      ...verifyFixture(join(directory, 'oracle.mjs'), config.workdir),
      ...(getScenario(result.scenario).gradeTrace?.(events) ?? []),
      ...result.checks.filter(check => check.name.startsWith('preserved evaluator fixture ')),
      { name: 'no duplicate automatic delivery', pass: metrics.duplicatePushes === 0 },
    ]
    const status = ['passed', 'failed'].includes(result.status) ? (checks.every(check => check.pass) ? 'passed' : 'failed') : result.status
    return { ...result, status, checks, metrics } as RunResult
  })
  writeFileSync(join(output, 'manifest.json'), JSON.stringify({ regradedFrom: resolve(source), providerCalls: 0, createdAt: new Date().toISOString() }, null, 2))
  writeFileSync(join(output, 'results.jsonl'), results.map(result => JSON.stringify(result)).join('\n') + '\n')
  writeReports(output, results)
  return results
}

function environment(agentDir: string, configPath: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (name.startsWith('PI_SIMPLE_SUBAGENT') || name.startsWith('HERDR_') || name.startsWith('SUBAGENT_EVAL_')) delete env[name]
  }
  // No user settings, skills, extension packages, sessions, or workspace context.
  delete env.PI_CODING_AGENT_SESSION_DIR
  delete env.PI_PROVIDER
  delete env.PI_MODEL
  return { ...env, PI_CODING_AGENT_DIR: agentDir, SUBAGENT_EVAL_CONFIG: configPath }
}

export function verifyFixture(oraclePath: string, workdir: string): Check[] {
  const result = spawnSync(process.execPath, [oraclePath], { cwd: workdir, encoding: 'utf8', timeout: 10000, maxBuffer: 2_000_000 })
  if (result.status !== 0) return [{ name: 'artifact oracle completed', pass: false, detail: result.error?.message ?? result.stderr.slice(-4000) }]
  try {
    const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1)!)
    if (!Array.isArray(parsed) || !parsed.length || parsed.some(check => typeof check.name !== 'string' || typeof check.pass !== 'boolean')) throw new Error('Invalid oracle result')
    return parsed
  } catch (error) { return [{ name: 'artifact oracle returned valid checks', pass: false, detail: String(error) }] }
}

async function runOne(options: Options, trial: ReturnType<typeof buildPlan>[number], artifactDirectory: string, signal: AbortSignal, campaign: { directory: string; startedAt: number }): Promise<RunResult> {
  mkdirSync(artifactDirectory, { recursive: true })
  const scenario = getScenario(trial.scenario), fixture = scenario.fixture(trial.seed)
  const workdir = join(artifactDirectory, trial.scenario === 'quoting-and-paths' ? "repo O'Reilly $cash 雪" : 'repo')
  mkdirSync(workdir, { recursive: true })
  for (const [path, text] of Object.entries(fixture.files)) {
    const target = join(workdir, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text)
  }
  const tracePath = join(artifactDirectory, 'trace.jsonl')
  writeFileSync(tracePath, '')
  const config: RunConfig = {
    ...trial, timeoutSeconds: options.timeout,
    maxRequests: options.maxRequests, maxTokens: options.maxTokens, workdir, tracePath, watch: fixture.watch,
    campaignBudget: { directory: campaign.directory, requests: options.campaignRequests, tokens: options.campaignTokens, deadline: campaign.startedAt + options.campaignTimeout * 1000, trialDirectory: join(artifactDirectory, 'request-tickets') },
  }
  const configPath = join(artifactDirectory, 'config.json')
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  writeFileSync(join(artifactDirectory, 'prompt.txt'), fixture.prompt)
  const oraclePath = join(artifactDirectory, 'oracle.mjs')
  writeFileSync(oraclePath, fixture.oracle)
  const trace = (type: string, data: Record<string, unknown> = {}) => appendFileSync(tracePath, `${JSON.stringify({ at: Date.now(), type, role: 'harness', pid: process.pid, data })}\n`)
  const agentDir = mkdtempSync(join(tmpdir(), 'subagent-eval-auth-'))
  chmodSync(agentDir, 0o700)
  let child: ReturnType<typeof spawn> | undefined
  let closed = false
  let fatal: string | undefined
  let status: RunResult['status'] = 'failed'
  let events: TraceEvent[] = []
  let resultError: string | undefined
  const started = Date.now()
  try {
    const preflight = verifyFixture(oraclePath, workdir)
    if (preflight.some(check => check.name.startsWith('artifact oracle ')) || preflight.every(check => check.pass)) throw new Error('Fixture preflight failed; refusing model calls')
    for (const filename of ['auth.json', 'models.json']) {
      const source = join(getAgentDir(), filename)
      if (existsSync(source)) { copyFileSync(source, join(agentDir, filename)); chmodSync(join(agentDir, filename), 0o600) }
    }
    // Children discover only the evaluation extension through isolated settings.
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ extensions: [extensionPath], retry: { enabled: false }, compaction: { enabled: false } }))
    child = spawn(process.execPath, [piPath, '--mode', 'rpc', '--approve', '--session', join(artifactDirectory, 'parent.jsonl'),
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '-e', extensionPath,
      '--model', trial.model, '--thinking', trial.thinking], {
      cwd: workdir, env: environment(agentDir, configPath), detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.on('error', error => { fatal = error.message })
    child.on('close', (code, signal) => { closed = true; fatal ??= `Parent exited before evaluation completion: code=${code}, signal=${signal}` })
    child.stdin!.on('error', error => { if (!closed) fatal = error.message })
    let rpcBuffer = ''
    let rpcState: any
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      appendFileSync(join(artifactDirectory, 'rpc.jsonl'), chunk)
      rpcBuffer += chunk
      let newline: number
      while ((newline = rpcBuffer.indexOf('\n')) >= 0) {
        const line = rpcBuffer.slice(0, newline); rpcBuffer = rpcBuffer.slice(newline + 1)
        try {
          const event = JSON.parse(line)
          if (event.type === 'response' && event.command === 'get_state' && event.success) rpcState = event.data
          if (event.type === 'response' && event.command === 'prompt' && !event.success) fatal = event.error ?? 'Prompt preflight failed'
        } catch { /* Non-JSON startup diagnostics remain in the raw artifact. */ }
      }
    })
    child.stderr!.on('data', chunk => appendFileSync(join(artifactDirectory, 'stderr.log'), chunk))
    const send = (command: object) => { if (!closed) child!.stdin!.write(`${JSON.stringify(command)}\n`) }
    const hashes = new Map(fixture.watch.map(path => [path, existsSync(join(workdir, path)) ? sha(readFileSync(join(workdir, path))) : 'absent']))
    trace('run-start', { scenario: trial.scenario, variant: trial.variant })
    send({ type: 'prompt', id: 'initial', message: `${fixture.prompt}\n\nWork within this fixture. Do not modify tools/probe.mjs or docs/contract.md. Keep final reports concise unless the task requests a full report.` })
    let followUpSent = !fixture.followUp
    let idleSince = 0
    let stateRequestedAt = 0
    while (true) {
      await pause(200)
      if (signal.aborted) { status = 'interrupted'; break }
      events = parseTrace(readFileSync(tracePath, 'utf8'))
      for (const path of fixture.watch) {
        let contents: Buffer | undefined
        try { contents = readFileSync(join(workdir, path)) } catch { /* A writer may temporarily remove/replace the file. */ }
        const hash = contents ? sha(contents) : 'absent'
        if (hash !== hashes.get(path)) { trace('artifact-change', { path, before: hashes.get(path), after: hash }); hashes.set(path, hash) }
      }
      if (fatal) { status = 'infrastructure-error'; resultError = fatal; break }
      const denied = events.find(event => event.type === 'budget-denied')
      const shared = readBudget(campaign.directory)
      if (denied || shared.tokens >= options.campaignTokens || Date.now() >= config.campaignBudget!.deadline) {
        status = 'budget'; resultError = denied?.data.reason ?? (shared.tokens >= options.campaignTokens ? 'campaign token limit' : 'campaign time limit'); break
      }
      const requests = events.filter(event => event.type === 'provider-request').length
      const tokenCount = events.filter(event => event.type === 'assistant-message').reduce((sum, event) => sum + usageTokens(event.data.usage), 0)
      // Let the last admitted request finish; admission rejects the next one.
      if (requests > options.maxRequests || tokenCount >= options.maxTokens) { status = 'budget'; resultError = 'trial usage limit'; break }
      if (Date.now() - started >= options.timeout * 1000) { status = 'timeout'; break }
      if (Date.now() - stateRequestedAt >= 500) { send({ type: 'get_state' }); stateRequestedAt = Date.now() }
      const completed = new Set(events.filter(event => event.type === 'job-result').map(event => event.data.jobId))
      const pending = events.some(event => event.type === 'job-start' && !completed.has(event.data.jobId))
      const settled = events.some(event => event.type === 'agent-settled' && event.role === 'parent')
      const lastActivity = events.filter(event => !['provider-response', 'artifact-change'].includes(event.type)).at(-1)?.at ?? started
      const idle = settled && !pending && rpcState && !rpcState.isStreaming && !rpcState.isCompacting && !rpcState.pendingMessageCount && Date.now() - lastActivity >= 1500
      if (!followUpSent && fixture.followUp) {
        const ready = fixture.followUp.trigger === 'idle' ? idle : events.some(event => event.type === 'probe-start' && event.role === 'child' && event.data.mode === 'cancel')
        if (ready) {
          for (const path of fixture.followUp.remove ?? []) rmSync(join(workdir, path), { force: true })
          trace('follow-up', { prompt: fixture.followUp.prompt })
          send({ type: 'prompt', id: 'follow-up', message: fixture.followUp.prompt, streamingBehavior: 'steer' })
          followUpSent = true; idleSince = 0; rpcState = undefined
          continue
        }
      }
      if (idle && followUpSent) {
        idleSince ||= Date.now()
        if (Date.now() - idleSince >= 500) {
          const providerFailure = events.find(event => event.type === 'assistant-message' && event.data.stopReason === 'error')
          if (providerFailure) { status = 'infrastructure-error'; resultError = providerFailure.data.error ?? 'Provider returned an error' }
          else status = 'passed'
          break
        }
      } else idleSince = 0
    }
  } catch (error) {
    status = 'infrastructure-error'; resultError = String(error)
  } finally {
    // Observe cancellation before our process-group cleanup can hide an orphan.
    let beforeCleanup: TraceEvent[] = []
    try { beforeCleanup = parseTrace(readFileSync(tracePath, 'utf8')) } catch (error) {
      status = 'infrastructure-error'; resultError = `Invalid telemetry: ${String(error)}`
    }
    if (beforeCleanup.some(event => event.type === 'cancel' && event.data.accepted)) {
      for (const probe of beforeCleanup.filter(event => event.type === 'probe-start' && event.data.mode === 'cancel')) {
        if (!Number.isSafeInteger(probe.data.probePid) || probe.data.probePid <= 0) continue
        let alive = true
        try { process.kill(probe.data.probePid, 0) } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH' }
        trace('cancelled-probe-state', { probePid: probe.data.probePid, alive })
      }
    }
    trace('run-end', { status, error: resultError })
    if (child?.pid) {
      const kill = (signal: NodeJS.Signals) => { try { process.kill(-child!.pid!, signal) } catch {} }
      kill('SIGTERM')
      for (let i = 0; i < 15 && !closed; i++) await pause(100)
      // Also stop orphaned CLI wrappers/probes in this run's process group.
      kill('SIGKILL')
    }
    // Credentials are ephemeral and are never retained with traces or sessions.
    // Copy child session evidence before removing the private agent directory.
    const sessions = join(agentDir, 'sessions')
    try {
      if (existsSync(sessions)) {
        const { cpSync } = await import('node:fs')
        cpSync(sessions, join(artifactDirectory, 'child-sessions'), { recursive: true })
      }
    } finally { rmSync(agentDir, { recursive: true, force: true }) }
  }
  try { events = parseTrace(readFileSync(tracePath, 'utf8')) } catch (error) {
    status = 'infrastructure-error'; resultError = `Invalid telemetry: ${String(error)}`
  }
  const cutoff = events.findIndex(event => event.type === 'run-end')
  const measured = cutoff < 0 ? events : events.slice(0, cutoff + 1)
  const checks = [...verifyFixture(oraclePath, workdir), ...(scenario.gradeTrace?.(measured) ?? [])]
  for (const path of ['tools/probe.mjs', 'docs/contract.md']) checks.push({
    name: `preserved evaluator fixture ${path}`,
    pass: existsSync(join(workdir, path)) && readFileSync(join(workdir, path), 'utf8') === fixture.files[path],
  })
  const metrics = measure(measured)
  checks.push({ name: 'no duplicate automatic delivery', pass: metrics.duplicatePushes === 0 })
  if (status === 'passed' && checks.some(check => !check.pass)) status = 'failed'
  const result: RunResult = { ...trial, status, checks, metrics, artifactDirectory, ...(resultError ? { error: resultError } : {}) }
  writeFileSync(join(artifactDirectory, 'result.json'), JSON.stringify(result, null, 2))
  return result
}

export async function main(argv: string[]) {
  const options = parseOptions(argv)
  if (options.regrade) {
    const output = options.out ? resolve(options.out) : mkdtempSync(join(tmpdir(), 'subagent-regrade-'))
    const results = regradeCampaign(options.regrade, output)
    console.log(`Regraded ${results.length} saved trials; zero provider calls. Reports: ${output}`)
    return
  }
  const plan = buildPlan(options)
  if (!options.execute) {
    console.log(JSON.stringify({ execute: false, runs: plan.length, maxRuns: options.maxRuns,
      campaignLimits: { requests: options.campaignRequests, tokensIncludingCache: options.campaignTokens, seconds: options.campaignTimeout },
      trialLimits: { requests: options.maxRequests, tokensIncludingCache: options.maxTokens, seconds: options.timeout },
      failFast: !options.keepGoing,
      plan }, null, 2))
    console.log('Plan only. --execute runs the selected models with shared campaign caps; no automatic retries.')
    return
  }
  if (!plan.length) { console.log('No trials selected. No provider calls.'); return }
  if (plan.length > options.maxRuns) throw new Error(`Plan has ${plan.length} trials, exceeding --max-runs ${options.maxRuns}. Select fewer cases/variants or explicitly raise the limit.`)
  if (process.platform === 'win32') throw new Error('The behavior runner currently requires POSIX process groups for reliable descendant cleanup.')
  const output = options.out ? resolve(options.out) : mkdtempSync(join(tmpdir(), 'simple-subagent-behavior-'))
  mkdirSync(output, { recursive: true })
  // Never append to an earlier campaign accidentally.
  const manifestPath = join(output, 'manifest.json')
  if (existsSync(manifestPath)) throw new Error(`Output already contains a campaign: ${output}`)
  const tracked = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'simple-subagent'], { cwd: resolve(packageRoot, '..'), encoding: 'utf8' })
  const sourceHashes = Object.fromEntries(tracked.stdout.trim().split('\n').filter(path => path && existsSync(join(packageRoot, '..', path))).map(path => [path, sha(readFileSync(join(packageRoot, '..', path)))]))
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' }).stdout.trim()
  writeFileSync(manifestPath, JSON.stringify({ options, plan, createdAt: new Date().toISOString(), node: process.version, platform: process.platform, commit, sourceHashes }, null, 2))
  const results: RunResult[] = []
  const campaign = { directory: join(output, 'budget'), startedAt: Date.now() }
  const limits = { requests: options.campaignRequests, tokens: options.campaignTokens, seconds: options.campaignTimeout }
  let stopped: string | undefined
  const saveBudget = () => writeFileSync(join(output, 'budget.json'), JSON.stringify({
    limits, used: readBudget(campaign.directory), elapsedSeconds: (Date.now() - campaign.startedAt) / 1000,
    plannedTrials: plan.length, completedTrials: results.length, unrunTrials: plan.length - results.length, stopped,
  }, null, 2))
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  try {
    for (const [index, trial] of plan.entries()) {
      stopped = budgetReason(campaign.directory, limits, campaign.startedAt)
      if (stopped) break
      console.log(`[${index + 1}/${plan.length}] ${trial.model} ${trial.scenario} ${trial.variant} repeat=${trial.repeat}`)
      // Keep treatment names out of the task cwd and use equal-length paths.
      const result = await runOne(options, trial, join(output, String(index + 1).padStart(4, '0')), controller.signal, campaign)
      results.push(result)
      appendFileSync(join(output, 'results.jsonl'), `${JSON.stringify(result)}\n`)
      writeReports(output, results)
      saveBudget()
      console.log(`${result.status}: ${result.checks.filter(check => check.pass).length}/${result.checks.length} checks, parent requests=${result.metrics.parent.requests}, child requests=${result.metrics.child.requests}`)
      if (controller.signal.aborted) { stopped = 'interrupted'; break }
      if (result.status === 'infrastructure-error' || result.status === 'budget' || (result.status !== 'passed' && !options.keepGoing)) {
        stopped = result.error ?? result.status
        console.error(`Stopping campaign: ${stopped}`); break
      }
    }
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); saveBudget() }
  console.log(`Artifacts: ${output}`)
  if (stopped || results.some(result => result.status !== 'passed')) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
