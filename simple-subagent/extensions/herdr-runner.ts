import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { hideSubagents } from '../herdr/agent-view.ts'
import {
  getHerdrRecordPath,
  type HerdrSubagentRecord,
  pruneHerdrRecords,
  readHerdrRecords,
  updateHerdrRecord,
  writeHerdrRecord,
} from './herdr-state.ts'
import type { SubagentRunResult, ThinkingLevel, ToolDisplayItem } from './types.ts'

const SIMPLE_SUBAGENT_PROCESS_ENV = 'PI_SIMPLE_SUBAGENT'
const SIMPLE_SUBAGENT_CACHE_KEY_ENV = 'PI_SIMPLE_SUBAGENT_CACHE_KEY'
const SIMPLE_SUBAGENT_FORK_TOOL_ENV = 'PI_SIMPLE_SUBAGENT_FORK_TOOL'
const HERDR_RESULT_PATH_ENV = 'PI_SIMPLE_SUBAGENT_HERDR_RESULT_PATH'
const HERDR_EVENT_PATH_ENV = 'PI_SIMPLE_SUBAGENT_HERDR_EVENT_PATH'
const HERDR_ABORT_PATH_ENV = 'PI_SIMPLE_SUBAGENT_HERDR_ABORT_PATH'
const HERDR_PROMPT_PATH_ENV = 'PI_SIMPLE_SUBAGENT_HERDR_PROMPT_PATH'
const HERDR_START_PATH_ENV = 'PI_SIMPLE_SUBAGENT_HERDR_START_PATH'
const execFileAsync = promisify(execFile)

type HerdrAgentRequest = {
  name: string
  prompt: string
  cwd: string
  sessionKey: string
  sessionPath: string
  thinking: ThinkingLevel
  effectiveModel: string
  promptCacheKey: string | undefined
}

type SpawnedHerdrAgent = HerdrAgentRequest & {
  id: string
  paneId: string
  recordPath: string
  resultPath: string
  eventPath: string
  abortPath: string
  promptPath: string
  startPath: string
}

type HerdrCommandResult = {
  result?: {
    // biome-ignore lint/style/useNamingConvention: Herdr's JSON response uses snake_case.
    root_pane?: { pane_id?: string }
    // biome-ignore lint/style/useNamingConvention: Herdr's JSON response uses snake_case.
    tab?: { tab_id?: string; label?: string }
    // biome-ignore lint/style/useNamingConvention: Herdr's JSON response uses snake_case.
    pane?: { pane_id?: string; agent?: string; agent_status?: string }
    // biome-ignore lint/style/useNamingConvention: Herdr's JSON response uses snake_case.
    agent?: { pane_id?: string }
    // biome-ignore lint/style/useNamingConvention: Herdr's JSON response uses snake_case.
    panes?: Array<{ pane_id: string; agent_status?: string }>
  }
  error?: { code?: string; message?: string }
}

type HerdrBridgeResult = { ok: true; result: SubagentRunResult } | { ok: false; error: string }

export type HerdrSubagentOutcome =
  | { index: number; result: SubagentRunResult }
  | { index: number; error: string }

export class HerdrInitializationError extends Error {}

export function partitionParentRecords(
  records: HerdrSubagentRecord[],
  paneStatuses: Map<string, string | undefined>,
  workspaceId: string,
  parentSessionId: string,
): { finished: HerdrSubagentRecord[]; reusable: HerdrSubagentRecord | undefined } {
  const live = records.filter(
    record =>
      record.workspaceId === workspaceId &&
      record.parentSessionId === parentSessionId &&
      paneStatuses.has(record.paneId),
  )
  const finished = live.filter(record => {
    const paneStatus = paneStatuses.get(record.paneId)
    if (paneStatus === 'working' || paneStatus === 'blocked') return false
    return (
      paneStatus === 'done' ||
      record.status === 'done' ||
      record.status === 'failed' ||
      record.status === 'interrupted'
    )
  })
  const reusable = live
    .filter(record => !finished.includes(record))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1)
  return { finished, reusable }
}

export function formatSubagentTabLabel(parentLabel: string): string {
  return `SU: ${parentLabel.slice(0, 10).trimEnd()}`
}

class HerdrCommandError extends Error {
  readonly code: string | undefined

  constructor(code: string | undefined, message: string) {
    super(message)
    this.code = code
  }
}

function parseHerdrResponse(output: string | undefined): HerdrCommandResult | undefined {
  const value = output?.trim()
  if (!value) return undefined
  try {
    return JSON.parse(value) as HerdrCommandResult
  } catch {
    return undefined
  }
}

export function parseHerdrFailure(
  stdout: string | undefined,
  stderr: string | undefined,
): HerdrCommandResult['error'] {
  return parseHerdrResponse(stdout)?.error || parseHerdrResponse(stderr)?.error
}

export function isHerdrEnvironment(): boolean {
  return (
    process.env.HERDR_ENV === '1' && !!process.env.HERDR_PANE_ID && !!process.env.HERDR_WORKSPACE_ID
  )
}

function formatHerdrCommandFailure(commandLabel: string, reason: string): string {
  const reloadGuidance = reason.includes('unknown option:')
    ? '\nRun `/reload` to load the current simple-subagent code. If this persists, the Herdr adapter and CLI versions are incompatible.'
    : ''
  return `${commandLabel} failed: ${reason}${reloadGuidance}`
}

async function runHerdr(
  args: string[],
  cwd: string,
  responseRequired = true,
): Promise<HerdrCommandResult> {
  const command = process.env.HERDR_BIN_PATH || 'herdr'
  const commandLabel = `herdr ${args.slice(0, 2).join(' ')}`
  let stdout: string
  try {
    const result = await execFileAsync(command, args, { cwd, encoding: 'utf8' })
    stdout = result.stdout
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    const responseError = parseHerdrFailure(failure.stdout, failure.stderr)
    if (responseError) {
      throw new HerdrCommandError(
        responseError.code,
        formatHerdrCommandFailure(
          commandLabel,
          responseError.message || responseError.code || 'unknown error',
        ),
      )
    }
    throw new Error(
      formatHerdrCommandFailure(commandLabel, failure.stderr?.trim() || failure.message),
    )
  }
  const output = stdout.trim()
  const response = output ? (JSON.parse(output) as HerdrCommandResult) : undefined
  if (response?.error) {
    throw new HerdrCommandError(
      response.error.code,
      formatHerdrCommandFailure(
        commandLabel,
        response.error.message || response.error.code || 'unknown error',
      ),
    )
  }
  if (!response && responseRequired) throw new Error(`${commandLabel} returned no response`)
  return response || {}
}

export async function getHerdrParentLabel(fallback: string, cwd: string): Promise<string> {
  const tabId = process.env.HERDR_TAB_ID
  if (!tabId) return fallback
  return (await runHerdr(['tab', 'get', tabId], cwd)).result?.tab?.label || fallback
}

export async function notifyHerdrSubagentsFinished(
  cwd: string,
  doneCount: number,
  failedCount: number,
): Promise<void> {
  await runHerdr(
    [
      'notification',
      'show',
      'Subagents finished',
      '--body',
      `${doneCount} done, ${failedCount} failed`,
      '--sound',
      'done',
    ],
    cwd,
    false,
  ).catch(() => {})
}

function getChildEnvironment(agent: SpawnedHerdrAgent): Record<string, string> {
  return {
    [SIMPLE_SUBAGENT_PROCESS_ENV]: '1',
    [HERDR_RESULT_PATH_ENV]: agent.resultPath,
    [HERDR_EVENT_PATH_ENV]: agent.eventPath,
    [HERDR_ABORT_PATH_ENV]: agent.abortPath,
    [HERDR_PROMPT_PATH_ENV]: agent.promptPath,
    [HERDR_START_PATH_ENV]: agent.startPath,
    ...(agent.promptCacheKey
      ? {
          [SIMPLE_SUBAGENT_CACHE_KEY_ENV]: agent.promptCacheKey,
          [SIMPLE_SUBAGENT_FORK_TOOL_ENV]: '1',
        }
      : {}),
  }
}

function getChildArguments(agent: SpawnedHerdrAgent): string[] {
  return [
    '--session',
    agent.sessionPath,
    '--name',
    agent.name,
    '--model',
    agent.effectiveModel,
    '--thinking',
    agent.thinking,
  ]
}

function getChildEnvironmentArguments(agent: SpawnedHerdrAgent): string[] {
  return Object.entries(getChildEnvironment(agent)).flatMap(([name, value]) => [
    '--env',
    `${name}=${value}`,
  ])
}

async function startHerdrAgent(agent: SpawnedHerdrAgent): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await runHerdr(
        [
          'agent',
          'start',
          `simple-subagent-${agent.id.slice(0, 8)}`,
          '--kind',
          'pi',
          '--pane',
          agent.paneId,
          '--',
          ...getChildArguments(agent),
        ],
        agent.cwd,
      )
      if (response.result?.agent?.pane_id !== agent.paneId) {
        throw new Error(`Herdr did not start subagent "${agent.name}" in pane ${agent.paneId}`)
      }
      return
    } catch (error) {
      if (!(error instanceof HerdrCommandError && error.code === 'agent_pane_busy')) throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw new Error(
    `Subagent pane ${agent.paneId} did not reach an available shell prompt; the pane may have a leftover process. Close it and retry.`,
  )
}

async function reportPaneMetadata(agent: SpawnedHerdrAgent, parentLabel: string): Promise<void> {
  await runHerdr(
    [
      'pane',
      'report-metadata',
      agent.paneId,
      '--source',
      'simple-subagent',
      '--agent',
      'pi',
      '--title',
      agent.name,
      '--display-agent',
      agent.name,
      '--token',
      `parent=${parentLabel}`,
      '--token',
      `simple_subagent=${agent.name}`,
    ],
    agent.cwd,
    false,
  )
}

async function waitForAgentDetection(agent: SpawnedHerdrAgent): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const response = await runHerdr(['pane', 'get', agent.paneId], agent.cwd)
    if (response.result?.pane?.agent === 'pi') return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Herdr did not detect subagent "${agent.name}" as Pi`)
}

function createAgentRecord(
  agent: SpawnedHerdrAgent,
  runId: string,
  tabId: string,
  parentPaneId: string,
  parentSessionId: string,
  parentLabel: string,
  workspaceId: string,
): void {
  const now = new Date().toISOString()
  const record: HerdrSubagentRecord = {
    version: 1,
    id: path.basename(agent.recordPath, '.json'),
    runId,
    parentPaneId,
    parentSessionId,
    parentLabel,
    workspaceId,
    tabId,
    paneId: agent.paneId,
    name: agent.name,
    prompt: agent.prompt,
    cwd: agent.cwd,
    sessionKey: agent.sessionKey,
    sessionPath: agent.sessionPath,
    status: 'running',
    createdAt: now,
    updatedAt: now,
  }
  writeHerdrRecord(agent.recordPath, record)
}

function readNewToolEvents(
  agent: SpawnedHerdrAgent,
  offset: number,
): {
  offset: number
  tools: ToolDisplayItem[]
} {
  if (!fs.existsSync(agent.eventPath)) return { offset, tools: [] }
  const content = fs.readFileSync(agent.eventPath, 'utf8')
  const next = content.slice(offset)
  const completeLength = next.lastIndexOf('\n') + 1
  if (completeLength === 0) return { offset, tools: [] }
  const complete = next.slice(0, completeLength)
  const tools = complete
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { type: 'tool'; tool: ToolDisplayItem })
    .map(event => event.tool)
  return { offset: offset + completeLength, tools }
}

async function waitForAgent(
  agent: SpawnedHerdrAgent,
  signal: AbortSignal | undefined,
  onTool: ((tool: ToolDisplayItem) => void) | undefined,
): Promise<SubagentRunResult> {
  let eventOffset = 0
  let livenessChecks = 0
  let consecutiveLivenessFailures = 0

  while (true) {
    const events = readNewToolEvents(agent, eventOffset)
    eventOffset = events.offset
    for (const tool of events.tools) onTool?.(tool)

    if (fs.existsSync(agent.resultPath)) {
      const bridge = JSON.parse(fs.readFileSync(agent.resultPath, 'utf8')) as HerdrBridgeResult
      if (!bridge.ok) {
        updateHerdrRecord(agent.recordPath, {
          status: 'failed',
          completedAt: new Date().toISOString(),
        })
        throw new Error(bridge.error)
      }
      updateHerdrRecord(agent.recordPath, {
        status: bridge.result.exitCode === 0 ? 'done' : 'failed',
        completedAt: new Date().toISOString(),
      })
      return bridge.result
    }

    if (signal?.aborted) {
      await interruptAgent(agent)
      throw new Error('Subagent was aborted')
    }

    livenessChecks += 1
    if (livenessChecks === 10) {
      livenessChecks = 0
      try {
        const pane = await runHerdr(['pane', 'get', agent.paneId], agent.cwd)
        if (pane.result?.pane?.agent === 'pi') {
          consecutiveLivenessFailures = 0
        } else {
          consecutiveLivenessFailures += 1
        }
      } catch {
        consecutiveLivenessFailures += 1
      }
      if (consecutiveLivenessFailures >= 3 && fs.existsSync(agent.recordPath)) {
        updateHerdrRecord(agent.recordPath, {
          status: 'failed',
          completedAt: new Date().toISOString(),
        })
      }
      if (consecutiveLivenessFailures >= 3) {
        throw new Error('Subagent pane stopped before producing a result')
      }
    }

    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

async function interruptAgent(agent: SpawnedHerdrAgent): Promise<void> {
  try {
    fs.writeFileSync(agent.abortPath, '')
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      if (fs.existsSync(agent.resultPath)) break
      try {
        await runHerdr(['pane', 'get', agent.paneId], agent.cwd)
      } catch {
        break
      }
      if (attempt === 29) {
        await runHerdr(['pane', 'close', agent.paneId], agent.cwd, false)
      }
    }
  } catch {
    // A missing pane is already stopped.
  } finally {
    if (fs.existsSync(agent.recordPath)) {
      let status: 'done' | 'interrupted' = 'interrupted'
      if (fs.existsSync(agent.resultPath)) {
        const bridge = JSON.parse(fs.readFileSync(agent.resultPath, 'utf8')) as HerdrBridgeResult
        if (bridge.ok && bridge.result.exitCode === 0) status = 'done'
      }
      updateHerdrRecord(agent.recordPath, {
        status,
        completedAt: new Date().toISOString(),
      })
    }
  }
}

export async function runSubagentsInHerdr(
  agents: HerdrAgentRequest[],
  runDirectory: string,
  parentSessionId: string,
  parentLabel: string,
  signal: AbortSignal | undefined,
  onStatus: (index: number, status: 'running' | 'done' | 'failed' | 'interrupted') => void,
  onTool: (index: number, tool: ToolDisplayItem) => void,
): Promise<HerdrSubagentOutcome[]> {
  let workspaceId: string
  let parentPaneId: string
  let prepared: SpawnedHerdrAgent[]
  let firstAgent: SpawnedHerdrAgent
  let tabId: string
  let rootPaneId: string
  let reuseSplitPaneId: string | undefined
  try {
    const workspace = process.env.HERDR_WORKSPACE_ID
    const parentPane = process.env.HERDR_PANE_ID
    if (!(workspace && parentPane)) throw new Error('Herdr pane context is missing')
    workspaceId = workspace
    parentPaneId = parentPane
    const socketPath = process.env.HERDR_SOCKET_PATH
    if (!socketPath) throw new Error('HERDR_SOCKET_PATH is required')

    await hideSubagents(socketPath, 'local.simple-subagent')

    const paneList = await runHerdr(['pane', 'list'], agents[0].cwd)
    if (!paneList.result?.panes) throw new Error('Herdr pane list returned no panes')
    pruneHerdrRecords(new Set(paneList.result.panes.map(pane => pane.pane_id)))

    const paneStatuses = new Map(
      paneList.result.panes.map(pane => [pane.pane_id, pane.agent_status]),
    )
    const { finished, reusable } = partitionParentRecords(
      readHerdrRecords(),
      paneStatuses,
      workspaceId,
      parentSessionId,
    )
    await Promise.allSettled(
      finished.map(async record => {
        await runHerdr(['pane', 'close', record.paneId], agents[0].cwd, false).catch(() => {})
        try {
          fs.unlinkSync(getHerdrRecordPath(record.id))
        } catch {
          // The record may already be pruned.
        }
      }),
    )

    prepared = agents.map(agent => {
      const id = randomUUID()
      const child: SpawnedHerdrAgent = {
        ...agent,
        id,
        paneId: '',
        recordPath: getHerdrRecordPath(id),
        resultPath: path.join(runDirectory, `${id}-bridge-result.json`),
        eventPath: path.join(runDirectory, `${id}-events.jsonl`),
        abortPath: path.join(runDirectory, `${id}-abort`),
        promptPath: path.join(runDirectory, `${id}-prompt.txt`),
        startPath: path.join(runDirectory, `${id}-start`),
      }
      fs.writeFileSync(child.eventPath, '')
      fs.writeFileSync(child.promptPath, child.prompt)
      return child
    })
    firstAgent = prepared[0]
    if (reusable) {
      tabId = reusable.tabId
      rootPaneId = ''
      reuseSplitPaneId = reusable.paneId
      await runHerdr(
        ['tab', 'rename', tabId, formatSubagentTabLabel(parentLabel)],
        firstAgent.cwd,
        false,
      ).catch(() => {})
    } else {
      const tabResponse = await runHerdr(
        [
          'tab',
          'create',
          '--workspace',
          workspaceId,
          '--cwd',
          agents[0].cwd,
          '--label',
          formatSubagentTabLabel(parentLabel),
          '--no-focus',
          ...getChildEnvironmentArguments(firstAgent),
        ],
        firstAgent.cwd,
      )
      const createdTabId = tabResponse.result?.tab?.tab_id
      const createdRootPaneId = tabResponse.result?.root_pane?.pane_id
      if (!(createdTabId && createdRootPaneId)) {
        throw new Error('Herdr tab creation returned no tab or pane ID')
      }
      tabId = createdTabId
      rootPaneId = createdRootPaneId
    }
  } catch (error) {
    throw new HerdrInitializationError(error instanceof Error ? error.message : String(error))
  }

  const runId = randomUUID()
  const spawned: SpawnedHerdrAgent[] = []
  const paneSizes: Array<{ width: number; height: number }> = []
  try {
    for (const [index, child] of prepared.entries()) {
      if (signal?.aborted) throw new Error('Subagent launch was aborted')
      if (index === 0 && !reuseSplitPaneId) {
        child.paneId = rootPaneId
        paneSizes.push({ width: 1, height: 1 })
      } else {
        let splitTargetPaneId: string
        let splitTargetSize: { width: number; height: number } | undefined
        let direction: 'right' | 'down'
        if (index === 0 && reuseSplitPaneId) {
          splitTargetPaneId = reuseSplitPaneId
          direction = 'right'
        } else {
          const splitTargetIndex = paneSizes.reduce((largest, size, candidate) => {
            const largestSize = paneSizes[largest]
            return size.width * size.height > largestSize.width * largestSize.height
              ? candidate
              : largest
          }, 0)
          splitTargetPaneId = prepared[splitTargetIndex].paneId
          splitTargetSize = paneSizes[splitTargetIndex]
          direction = splitTargetSize.width >= splitTargetSize.height ? 'right' : 'down'
        }
        const splitResponse = await runHerdr(
          [
            'pane',
            'split',
            splitTargetPaneId,
            '--direction',
            direction,
            '--cwd',
            child.cwd,
            '--no-focus',
            ...getChildEnvironmentArguments(child),
          ],
          child.cwd,
        )
        const paneId = splitResponse.result?.pane?.pane_id
        if (!paneId) throw new Error(`Herdr did not create a pane for subagent "${child.name}"`)
        child.paneId = paneId
        if (splitTargetSize) {
          const splitSize = { ...splitTargetSize }
          if (direction === 'right') {
            splitTargetSize.width /= 2
            splitSize.width /= 2
          } else {
            splitTargetSize.height /= 2
            splitSize.height /= 2
          }
          paneSizes.push(splitSize)
        } else {
          paneSizes.push({ width: 1, height: 1 })
        }
      }
      await reportPaneMetadata(child, parentLabel)
      await startHerdrAgent(child)
      // The child bridge holds the prompt until this file exists, so Herdr
      // observes an idle agent and reports it ready before the first turn.
      fs.writeFileSync(child.startPath, '')
      createAgentRecord(
        child,
        runId,
        tabId,
        parentPaneId,
        parentSessionId,
        parentLabel,
        workspaceId,
      )
      spawned.push(child)
      onStatus(index, 'running')
    }

    const detections = await Promise.allSettled(spawned.map(waitForAgentDetection))
    const failedDetection = detections.find(result => result.status === 'rejected')
    if (failedDetection?.status === 'rejected') throw failedDetection.reason
  } catch (error) {
    await Promise.allSettled(spawned.map(interruptAgent))
    if (reuseSplitPaneId) {
      await Promise.allSettled(
        spawned.map(agent =>
          runHerdr(['pane', 'close', agent.paneId], agent.cwd, false).catch(() => {}),
        ),
      )
    } else {
      await runHerdr(['tab', 'close', tabId], firstAgent.cwd, false).catch(() => {})
    }
    throw error
  }

  const outcomes = await Promise.allSettled(
    spawned.map(async (agent, index) => {
      try {
        const result = await waitForAgent(agent, signal, tool => onTool(index, tool))
        onStatus(index, result.exitCode === 0 ? 'done' : 'failed')
        return { index, result }
      } catch (error) {
        onStatus(index, signal?.aborted ? 'interrupted' : 'failed')
        if (signal?.aborted) throw error
        throw error
      }
    }),
  )

  if (signal?.aborted) {
    const sessions = agents.map(agent => `${agent.name}: ${agent.sessionKey}`).join(', ')
    throw new Error(
      `Subagents were interrupted (${String(signal.reason)}). Resume with the same sessionKey values: ${sessions}`,
    )
  }

  const results = outcomes.map((outcome, index): HerdrSubagentOutcome => {
    if (outcome.status === 'fulfilled') return outcome.value
    return {
      index,
      error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
    }
  })
  return results
}
