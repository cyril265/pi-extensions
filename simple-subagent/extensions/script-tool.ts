import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  type ImageContent,
  type TextContent,
  validateToolArguments,
} from '@earendil-works/pi-ai'
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  highlightCode,
  type ExtensionAPI,
  type ExtensionContext,
  SettingsManager,
  type ToolDefinition,
  type TruncationResult,
  truncateHead,
} from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import type { RegisteredSubagentTools } from './tools.ts'

export const NODE_SCRIPT_TOOL_NAMES = [
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'find',
  'ls',
  'runSubAgents',
  'collectSubagents',
] as const

export type NodeScriptToolName = (typeof NODE_SCRIPT_TOOL_NAMES)[number]
export type NodeScriptContentBlock = TextContent | ImageContent

export type NodeScriptToolValue = {
  text: string
  content: NodeScriptContentBlock[]
  details: unknown
}

export type NodeScriptTraceEntry = {
  tool: NodeScriptToolName
  status: 'success' | 'error'
  durationMs: number
}

export type NodeScriptWorkerResult = {
  consoleOutput: string
  returnOutput: string
  returnType: 'string' | 'json'
}

export type NodeScriptDetails = {
  output: string
  consoleOutput: string
  returnOutput: string
  returnType: NodeScriptWorkerResult['returnType']
  trace: NodeScriptTraceEntry[]
  truncation?: TruncationResult
  fullOutputPath?: string
}

type SerializedError = {
  name: string
  message: string
  stack?: string
}

type WorkerCallMessage = {
  type: 'call'
  id: string
  tool: NodeScriptToolName
  args: unknown
}

type WorkerCompleteMessage = {
  type: 'complete'
} & NodeScriptWorkerResult

type WorkerFailedMessage = {
  type: 'failed'
  error: SerializedError
  consoleOutput: string
}

type WorkerUnresolvedMessage = {
  type: 'unresolved'
  count: number
  consoleOutput: string
}

type WorkerMessage =
  | WorkerCallMessage
  | WorkerCompleteMessage
  | WorkerFailedMessage
  | WorkerUnresolvedMessage

type NodeScriptWorkerOptions = {
  code: string
  controller: AbortController
  invoke: (
    tool: NodeScriptToolName,
    args: unknown,
    callId: string,
    signal: AbortSignal,
  ) => Promise<NodeScriptToolValue>
}

type LimitedOutput = {
  text: string
  truncation?: TruncationResult
  fullOutputPath?: string
}

export class NodeScriptWorkerError extends Error {
  readonly consoleOutput: string

  constructor(message: string, consoleOutput = '', options?: ErrorOptions) {
    super(message, options)
    this.name = 'NodeScriptWorkerError'
    this.consoleOutput = consoleOutput
  }
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  return { name: 'Error', message: String(error) }
}

function restoreWorkerError(error: SerializedError, consoleOutput: string): NodeScriptWorkerError {
  const restored = new NodeScriptWorkerError(error.message, consoleOutput)
  restored.name = error.name || 'NodeScriptWorkerError'
  if (error.stack) restored.stack = error.stack
  return restored
}

function cancellationError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new DOMException(typeof reason === 'string' ? reason : 'nodeScript aborted', 'AbortError')
}

function textFromContent(content: NodeScriptContentBlock[]): string {
  return content
    .filter((part): part is TextContent => part.type === 'text')
    .map(part => part.text)
    .join('\n')
}

export async function invokePiTool(
  definition: ToolDefinition<any, any>,
  args: unknown,
  toolCallId: string,
  signal: AbortSignal,
  ctx: ExtensionContext,
): Promise<NodeScriptToolValue> {
  signal.throwIfAborted()
  const prepared = definition.prepareArguments ? definition.prepareArguments(args) : args
  const validated = validateToolArguments(definition, {
    type: 'toolCall',
    id: toolCallId,
    name: definition.name,
    arguments: prepared as Record<string, unknown>,
  })
  signal.throwIfAborted()
  const result = await definition.execute(toolCallId, validated, signal, undefined, ctx)
  const content = result.content as NodeScriptContentBlock[]
  return {
    text: textFromContent(content),
    content,
    details: result.details,
  }
}

export function createNativeNodeScriptTools(
  ctx: ExtensionContext,
): Record<Exclude<NodeScriptToolName, 'runSubAgents' | 'collectSubagents'>, ToolDefinition<any, any>> {
  const settings = SettingsManager.create(ctx.cwd, undefined, {
    projectTrusted: ctx.isProjectTrusted(),
  })
  return {
    read: createReadToolDefinition(ctx.cwd, {
      autoResizeImages: settings.getImageAutoResize(),
    }),
    write: createWriteToolDefinition(ctx.cwd),
    edit: createEditToolDefinition(ctx.cwd),
    bash: createBashToolDefinition(ctx.cwd, {
      commandPrefix: settings.getShellCommandPrefix(),
      shellPath: settings.getShellPath(),
    }),
    grep: createGrepToolDefinition(ctx.cwd),
    find: createFindToolDefinition(ctx.cwd),
    ls: createLsToolDefinition(ctx.cwd),
  }
}

export function runNodeScriptWorker(options: NodeScriptWorkerOptions): Promise<NodeScriptWorkerResult> {
  const worker = new Worker(new URL('./script-worker.mjs', import.meta.url), {
    workerData: { code: options.code },
  })
  const outstanding = new Set<Promise<void>>()

  return new Promise((resolve, reject) => {
    let settling = false

    const removeListeners = () => {
      options.controller.signal.removeEventListener('abort', onAbort)
      worker.removeAllListeners()
    }

    const terminate = async () => {
      try {
        await worker.terminate()
      } catch {}
    }

    const finishSuccess = (output: NodeScriptWorkerResult) => {
      if (settling) return
      settling = true
      options.controller.signal.removeEventListener('abort', onAbort)
      void (async () => {
        await Promise.allSettled([...outstanding])
        await terminate()
        removeListeners()
        resolve(output)
      })()
    }

    const finishFailure = (error: Error) => {
      if (settling) return
      settling = true
      options.controller.signal.removeEventListener('abort', onAbort)
      if (!options.controller.signal.aborted) options.controller.abort(error)
      void (async () => {
        await terminate()
        await Promise.allSettled([...outstanding])
        removeListeners()
        reject(error)
      })()
    }

    function onAbort() {
      finishFailure(cancellationError(options.controller.signal.reason))
    }

    const handleCall = (message: WorkerCallMessage) => {
      if (settling) return
      let request!: Promise<void>
      request = (async () => {
        try {
          const value = await options.invoke(
            message.tool,
            message.args,
            message.id,
            options.controller.signal,
          )
          if (!settling) worker.postMessage({ type: 'resolve', id: message.id, value })
        } catch (error) {
          if (!settling) {
            worker.postMessage({
              type: 'reject',
              id: message.id,
              error: serializeError(error),
            })
          }
        } finally {
          outstanding.delete(request)
        }
      })()
      outstanding.add(request)
    }

    worker.on('message', (message: WorkerMessage) => {
      switch (message.type) {
        case 'call':
          handleCall(message)
          break
        case 'complete':
          finishSuccess({
            consoleOutput: message.consoleOutput,
            returnOutput: message.returnOutput,
            returnType: message.returnType,
          })
          break
        case 'failed':
          finishFailure(restoreWorkerError(message.error, message.consoleOutput))
          break
        case 'unresolved':
          finishFailure(
            new NodeScriptWorkerError(
              `nodeScript returned with ${message.count} unresolved tool call${message.count === 1 ? '' : 's'}`,
              message.consoleOutput,
            ),
          )
          break
      }
    })
    worker.on('error', error =>
      finishFailure(error instanceof Error ? error : new Error(String(error))),
    )
    worker.on('exit', code => {
      if (!settling) finishFailure(new Error(`nodeScript worker exited before completion with code ${code}`))
    })

    if (options.controller.signal.aborted) onAbort()
    else options.controller.signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function limitNodeScriptOutput(output: string): Promise<LimitedOutput> {
  const truncation = truncateHead(output)
  if (!truncation.truncated) return { text: output }

  const directory = await mkdtemp(join(tmpdir(), 'node-script-'))
  const fullOutputPath = join(directory, 'output.txt')
  await writeFile(fullOutputPath, output, 'utf8')

  const shown = truncation.content
  const notice = truncation.firstLineExceedsLimit
    ? `[Output truncated: first line exceeds ${formatSize(DEFAULT_MAX_BYTES)}. Full output saved to: ${fullOutputPath}]`
    : `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`
  return {
    text: shown ? `${shown}\n\n${notice}` : notice,
    truncation,
    fullOutputPath,
  }
}

function traceText(trace: NodeScriptTraceEntry[]): string {
  return trace
    .map(entry =>
      entry.status === 'success'
        ? `${entry.tool} ${entry.durationMs}ms`
        : `${entry.tool} failed ${entry.durationMs}ms`,
    )
    .join(' · ')
}

function combineNodeScriptOutput(result: NodeScriptWorkerResult): string {
  return result.consoleOutput && result.returnOutput
    ? `${result.consoleOutput}\n\n${result.returnOutput}`
    : result.consoleOutput || result.returnOutput
}

const COLLAPSED_RETURN_LINES = 10

function renderNodeScriptResult(
  details: NodeScriptDetails,
  expanded: boolean,
  theme: Parameters<NonNullable<ToolDefinition['renderResult']>>[2],
) {
  const buildText = () => {
    const status = details.trace.length > 0
      ? `${theme.fg('success', 'completed')} ${theme.fg('muted', `· ${traceText(details.trace)}`)}`
      : theme.fg('success', 'completed')
    const headerLines = [status]
    if (details.consoleOutput) {
      headerLines.push('', ...details.consoleOutput.split('\n').map(line => theme.fg('muted', line)))
    }
    const returnLines = details.returnType === 'json'
      ? highlightCode(details.returnOutput, 'json')
      : details.returnOutput.split('\n').map(line => theme.fg('toolOutput', line))
    return {
      header: new Text(headerLines.join('\n'), 0, 0),
      returned: details.returnOutput ? new Text(returnLines.join('\n'), 0, 0) : undefined,
    }
  }

  let text = buildText()
  return {
    render(width: number) {
      const headerLines = text.header.render(width)
      if (!text.returned) return headerLines
      const returnedLines = text.returned.render(width)
      const visibleReturn = expanded || returnedLines.length <= COLLAPSED_RETURN_LINES
        ? returnedLines
        : [
            ...returnedLines.slice(0, COLLAPSED_RETURN_LINES - 1),
            theme.fg('muted', '...'),
          ]
      return [...headerLines, '', ...visibleReturn]
    },
    invalidate() {
      text = buildText()
    },
  }
}

export function registerNodeScriptTool(
  pi: ExtensionAPI,
  subagentTools: RegisteredSubagentTools,
): () => Promise<void> {
  const activeScripts = new Map<AbortController, Promise<NodeScriptWorkerResult>>()
  const parameters = Type.Object({
    code: Type.String({
      description:
        'Trusted JavaScript async function body. Use await tools.<name>({ ... }). Return a string or JSON-serializable value; omitting return or returning undefined fails. Console output is prepended to the returned value.',
    }),
  })

  pi.registerTool({
    name: 'nodeScript',
    label: 'nodeScript',
    description: `Run trusted, one-shot JavaScript that composes read, write, edit, bash, grep, find, ls, runSubAgents, and collectSubagents. The script receives JavaScript intrinsics, frozen tools, and a captured console. Node globals such as process, require, fetch, timers, and Buffer are unavailable; use tools.bash when needed. Tool calls resolve to { text, content, details } and reject on failure. Nested calls use stock Pi tools and share the parent cwd. Combined output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} with the full output saved to a temporary file.`,
    promptSnippet: 'Compose stock tools and isolated subagents in trusted JavaScript',
    parameters,
    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('nodeScript'))}\n${highlightCode(args.code, 'javascript').join('\n')}`,
        0,
        0,
      )
    },
    renderResult(result, { expanded }, theme, context) {
      const output = textFromContent(result.content as NodeScriptContentBlock[])
      if (context.isError) return new Text(theme.fg('error', output), 0, 0)
      const details = result.details as NodeScriptDetails | undefined
      if (!details) return new Text(output, 0, 0)
      if (details.returnOutput === undefined) return new Text(details.output, 0, 0)
      return renderNodeScriptResult(details, expanded, theme)
    },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const definitions: Record<NodeScriptToolName, ToolDefinition<any, any>> = {
        ...createNativeNodeScriptTools(ctx),
        runSubAgents: subagentTools.runSubAgentsTool,
        collectSubagents: subagentTools.collectSubagentsTool,
      }
      const controller = new AbortController()
      const trace: NodeScriptTraceEntry[] = []
      const onOuterAbort = () => controller.abort(signal?.reason)
      if (signal?.aborted) onOuterAbort()
      else signal?.addEventListener('abort', onOuterAbort, { once: true })

      const run = runNodeScriptWorker({
        code: params.code,
        controller,
        async invoke(tool, args, nestedCallId, nestedSignal) {
          const startedAt = Date.now()
          const entry: NodeScriptTraceEntry = { tool, status: 'success', durationMs: 0 }
          trace.push(entry)
          try {
            const value = await invokePiTool(
              definitions[tool],
              args,
              `${toolCallId}:${nestedCallId}`,
              nestedSignal,
              ctx,
            )
            entry.durationMs = Date.now() - startedAt
            return value
          } catch (error) {
            entry.status = 'error'
            entry.durationMs = Date.now() - startedAt
            throw error
          }
        },
      })
      activeScripts.set(controller, run)

      try {
        const workerResult = await run
        const limited = await limitNodeScriptOutput(combineNodeScriptOutput(workerResult))
        const display = limited.truncation
          ? { consoleOutput: '', returnOutput: limited.text, returnType: 'string' as const }
          : workerResult
        return {
          content: [{ type: 'text', text: limited.text }],
          details: {
            output: limited.text,
            ...display,
            trace,
            truncation: limited.truncation,
            fullOutputPath: limited.fullOutputPath,
          } satisfies NodeScriptDetails,
        }
      } catch (error) {
        const parts: string[] = []
        if (error instanceof NodeScriptWorkerError && error.consoleOutput) {
          parts.push(error.consoleOutput)
        }
        parts.push(error instanceof Error ? error.message : String(error))
        if (trace.length > 0) parts.push(`calls: ${traceText(trace)}`)
        const limited = await limitNodeScriptOutput(parts.join('\n\n'))
        throw new Error(limited.text, { cause: error })
      } finally {
        signal?.removeEventListener('abort', onOuterAbort)
        activeScripts.delete(controller)
      }
    },
  })

  return async () => {
    for (const controller of activeScripts.keys()) controller.abort('Session shutdown')
    await Promise.allSettled([...activeScripts.values()])
  }
}
