export const variants = ['native', 'client'] as const
export type Variant = (typeof variants)[number]

export type TraceEvent = {
  at: number
  type: string
  role: 'parent' | 'child' | 'harness'
  pid: number
  sessionId?: string
  data: Record<string, any>
}

export type Check = { name: string; pass: boolean; detail?: string }
export type Fixture = {
  files: Record<string, string>
  prompt: string
  oracle: string
  watch: string[]
  followUp?: { trigger: 'idle' | 'probe-start'; prompt: string; remove?: string[] }
}

export type Scenario = {
  id: string
  question: string
  fixture: (seed: number) => Fixture
  gradeTrace?: (events: TraceEvent[]) => Check[]
}

export type RunConfig = {
  variant: Variant
  model: string
  thinking: string
  seed: number
  timeoutSeconds: number
  maxRequests: number
  maxTokens: number
  scenario: string
  workdir: string
  tracePath: string
  watch: string[]
  campaignBudget?: { directory: string; requests: number; tokens: number; deadline: number; trialDirectory: string }
}

export type Usage = {
  requests: number
  messages: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  usageMissing: number
}

export type RunResult = {
  scenario: string
  variant: Variant
  model: string
  thinking: string
  seed: number
  repeat: number
  status: 'passed' | 'failed' | 'timeout' | 'budget' | 'interrupted' | 'infrastructure-error'
  checks: Check[]
  metrics: ReturnType<typeof import('./metrics.ts').measure>
  artifactDirectory: string
  error?: string
}
