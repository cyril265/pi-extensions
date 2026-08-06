import * as fs from 'node:fs'
import * as path from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'

const CONFIG_FILE_NAME = 'simple-subagent.json'

export type SimpleSubagentConfig = {
  enableForkTool: boolean
  modelAliases: Record<string, string>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getSimpleSubagentConfigPath(): string {
  return path.join(getAgentDir(), CONFIG_FILE_NAME)
}

export function readSimpleSubagentConfig(
  configPath = getSimpleSubagentConfigPath(),
): SimpleSubagentConfig {
  if (!fs.existsSync(configPath)) {
    return { enableForkTool: false, modelAliases: {} }
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  if (!isObject(parsed)) throw new Error(`Simple subagent config must be an object in ${configPath}`)
  if (parsed.enableForkTool !== undefined && typeof parsed.enableForkTool !== 'boolean') {
    throw new Error(`enableForkTool must be boolean in ${configPath}`)
  }
  if (parsed.modelAliases !== undefined && !isObject(parsed.modelAliases)) {
    throw new Error(`modelAliases must be an object in ${configPath}`)
  }

  const aliases = Object.entries(parsed.modelAliases ?? {})

  const modelAliases = Object.fromEntries(
    aliases.map(([alias, model]) => {
      if (!alias || alias.trim() !== alias || alias.includes('/')) {
        throw new Error(`Invalid model alias "${alias}" in ${configPath}`)
      }
      if (
        typeof model !== 'string' ||
        model.trim() !== model ||
        !/^\S+\/\S+$/.test(model)
      ) {
        throw new Error(`Model alias "${alias}" must map to provider/model in ${configPath}`)
      }
      return [alias, model]
    }),
  )

  return {
    enableForkTool: parsed.enableForkTool ?? false,
    modelAliases,
  }
}
