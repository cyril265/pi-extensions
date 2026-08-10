import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { readSimpleSubagentConfig } from './config.ts'
import { registerHerdrChildBridge } from './herdr-child.ts'
import { isHerdrTerminal, openHerdrForkTab } from './herdr-tab.ts'
import { registerSubagentTools } from './tools.ts'
import type { ThinkingLevel } from './types.ts'

const SIMPLE_SUBAGENT_PROCESS_ENV = 'PI_SIMPLE_SUBAGENT'
const SIMPLE_SUBAGENT_CACHE_KEY_ENV = 'PI_SIMPLE_SUBAGENT_CACHE_KEY'

export default function (pi: ExtensionAPI) {
  const isSubagentProcess = process.env[SIMPLE_SUBAGENT_PROCESS_ENV] === '1'
  const inheritedPromptCacheKey = process.env[SIMPLE_SUBAGENT_CACHE_KEY_ENV]
  const config = readSimpleSubagentConfig()

  registerHerdrChildBridge(pi)

  if (inheritedPromptCacheKey) {
    pi.on('before_provider_request', event => {
      if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload))
        return
      if (!('prompt_cache_key' in event.payload)) return
      // biome-ignore lint/complexity/useLiteralKeys: OpenAI's payload key is snake_case.
      return { ...event.payload, ['prompt_cache_key']: inheritedPromptCacheKey }
    })
  }

  pi.registerCommand('forkTab', {
    description: 'Fork the current session into a new interactive Herdr tab.',
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify('Usage: /forkTab', 'warning')
        return
      }
      if (!isHerdrTerminal()) {
        ctx.ui.notify('Not inside Herdr', 'error')
        return
      }
      const sessionPath = ctx.sessionManager.getSessionFile()
      if (!sessionPath) {
        ctx.ui.notify('Current session is not persisted and cannot be forked', 'error')
        return
      }
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined
      if (!model) {
        ctx.ui.notify('No caller model', 'error')
        return
      }

      try {
        openHerdrForkTab(model, pi.getThinkingLevel() as ThinkingLevel, ctx.cwd, sessionPath)
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      }
    },
  })

  registerSubagentTools(pi, isSubagentProcess, config)
}
