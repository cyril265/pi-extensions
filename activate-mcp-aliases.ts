import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ExtensionAPI, getAgentDir } from '@earendil-works/pi-coding-agent'

/**
 * pi-claude-code-use only advertises mcp__-aliased companion tools to Anthropic OAuth when the
 * alias is in the ACTIVE tool list, and its own syncAliasActivation does not reliably get them
 * there. This extension activates every registered alias from pi-claude-code-use.json whenever
 * the session runs on Anthropic OAuth, and removes them again otherwise. The bridge treats
 * aliases it did not auto-activate as user-selected and preserves them.
 *
 * Must be listed AFTER pi-claude-code-use in settings.json packages.
 */

const CONFIG_FILENAME = 'pi-claude-code-use.json'

function readAliasNames(path: string): string[] {
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { toolAliases?: unknown }
    if (!Array.isArray(parsed.toolAliases)) return []
    return parsed.toolAliases
      .filter((pair): pair is [string, string] => Array.isArray(pair) && typeof pair[1] === 'string')
      .map(pair => pair[1])
  } catch {
    return []
  }
}

function configuredAliases(cwd: string): string[] {
  return [
    ...new Set([
      ...readAliasNames(join(getAgentDir(), 'extensions', CONFIG_FILENAME)),
      ...readAliasNames(join(cwd, '.pi', 'extensions', CONFIG_FILENAME)),
    ]),
  ]
}

export default function (pi: ExtensionAPI) {
  const logPath = join(getAgentDir(), '..', 'logs', 'activate-mcp-aliases.log')
  let lastState = ''
  const logStateChange = (state: string) => {
    if (state === lastState) return
    lastState = state
    try {
      appendFileSync(logPath, `${new Date().toISOString()} pid=${process.pid} ${state}\n`)
    } catch {
      // diagnostics must never break the session
    }
  }

  pi.on('before_agent_start', (_event, ctx) => {
    const aliases = configuredAliases(ctx.cwd)
    if (aliases.length === 0) {
      logStateChange('no aliases configured')
      return
    }

    const model = ctx.model
    const isOAuth = model?.provider === 'anthropic' && ctx.modelRegistry.isUsingOAuth(model)
    const registered = new Set(pi.getAllTools().map(tool => tool.name))
    const active = pi.getActiveTools()

    if (isOAuth) {
      const missing = aliases.filter(alias => registered.has(alias) && !active.includes(alias))
      if (missing.length > 0) pi.setActiveTools([...active, ...missing])
      const unregistered = aliases.filter(alias => !registered.has(alias))
      logStateChange(
        `oauth cwd=${ctx.cwd} activated=[${missing.join(',')}] alreadyActive=[${aliases.filter(a => active.includes(a)).join(',')}] unregistered=[${unregistered.join(',')}]`,
      )
    } else {
      const next = active.filter(name => !aliases.includes(name))
      if (next.length !== active.length) pi.setActiveTools(next)
      logStateChange(`non-oauth provider=${model?.provider ?? 'none'} removed=${active.length - next.length}`)
    }
  })
}
