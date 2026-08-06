export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ForkOverride = { model: string; thinking: ThinkingLevel }

export type SubagentRequest = {
  name: string
  prompt: string
  thinking?: ThinkingLevel
  cwd?: string
  overrideModel?: string
  sessionKey?: string
  forkParent?: boolean
  forkOverride?: ForkOverride
}

export type ForkMetadata = {
  version: 1
  sourceSessionId: string
  promptCacheKey: string
  provider: string
  model: string
  thinking: ThinkingLevel
  cwd: string
}

export type UsageStats = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  turns: number
}

export type PiJsonEvent = {
  type?: string
  message?: unknown
  toolName?: string
  args?: unknown
}

export type ToolDisplayItem = { name: string; args: Record<string, unknown> }
export type LiveDisplayEvent = { type: 'tool'; agent: string; tool: ToolDisplayItem }
export type SubagentStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted'

export type SubagentResultDetails = {
  liveEvents?: LiveDisplayEvent[]
  agents: Array<{
    name: string
    thinking: ThinkingLevel
    suppliedModel?: string
    effectiveModel?: string
    prompt?: string
    cwd?: string
    sessionKey?: string
    forkParent?: boolean
    status?: SubagentStatus
    exitCode?: number
    outputPath?: string
    tools?: ToolDisplayItem[]
    usage?: UsageStats
  }>
}

export type AgentDisplayInfo = {
  name: string
  thinking: ThinkingLevel
  suppliedModel?: string
  effectiveModel?: string
  prompt?: string
  cwd?: string
  sessionKey?: string
  forkParent?: boolean
  status?: SubagentStatus
  usage?: UsageStats
}

export type FirstTurnUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type SubagentRunResult = {
  text: string
  exitCode: number
  tools: ToolDisplayItem[]
  usage: UsageStats
  firstTurnUsage: FirstTurnUsage
}
