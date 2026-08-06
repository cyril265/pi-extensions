import * as fs from 'node:fs'
import type { ThinkingLevel } from '../simple-subagent/index.ts'

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

export type PrewalkConfig = {
  executor: {
    model: string
    thinking: ThinkingLevel
  }
}

export function loadConfig(configPath: string): PrewalkConfig | undefined {
  if (!fs.existsSync(configPath)) return undefined
  const raw: unknown = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${configPath} must contain a JSON object`)
  }
  const executor = (raw as { executor?: unknown }).executor
  if (!executor || typeof executor !== 'object' || Array.isArray(executor)) {
    throw new Error(`"executor" must be an object in ${configPath}`)
  }
  const { model, thinking } = executor as { model?: unknown; thinking?: unknown }
  if (typeof model !== 'string' || !model.includes('/')) {
    throw new Error(`"executor.model" must be a "provider/model" string in ${configPath}`)
  }
  if (typeof thinking !== 'string' || !(THINKING_LEVELS as readonly string[]).includes(thinking)) {
    throw new Error(`"executor.thinking" must be one of ${THINKING_LEVELS.join('|')} in ${configPath}`)
  }
  return { executor: { model, thinking: thinking as ThinkingLevel } }
}

export function saveConfig(configPath: string, config: PrewalkConfig): void {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
}
