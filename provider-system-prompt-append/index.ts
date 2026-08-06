import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from '@earendil-works/pi-coding-agent'

const providerNamePattern = /^[A-Za-z0-9._-]+$/

type ProviderAppend = {
  text: string
  sourcePath: string
}

type CurrentProviderAppend = ProviderAppend & {
  provider: string
}

export default function providerSystemPromptAppend(pi: ExtensionAPI) {
  const warnedProviders = new Set<string>()

  function getCurrentProviderAppend(
    ctx: ExtensionContext,
    provider = ctx.model?.provider,
  ): CurrentProviderAppend | undefined {
    if (!provider) return undefined

    try {
      const providerAppend = loadProviderAppend(ctx, provider)
      return providerAppend ? { provider, ...providerAppend } : undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!warnedProviders.has(provider)) {
        ctx.ui.notify(message, 'warning')
        warnedProviders.add(provider)
      }
      return undefined
    }
  }

  pi.on('session_start', async () => {
    warnedProviders.clear()
  })

  pi.on('before_agent_start', async (event, ctx) => {
    const providerAppend = getCurrentProviderAppend(ctx)
    if (!providerAppend || providerAppend.text.length === 0) return

    return {
      systemPrompt: `${event.systemPrompt}\n\n${providerAppend.text}`,
    }
  })
  pi.registerCommand('provider-system-prompt-append', {
    description: 'Show the current provider-specific APPEND_SYSTEM file status',
    handler: async (_args, ctx) => {
      const provider = ctx.model?.provider

      if (!provider) {
        ctx.ui.notify('No model provider is selected yet.', 'warning')
        return
      }

      const providerAppend = getCurrentProviderAppend(ctx, provider)

      if (!providerAppend) {
        ctx.ui.notify(`Current provider: ${provider}. No provider append file found.`, 'info')
        return
      }

      ctx.ui.notify(`Current provider: ${provider}. Using ${providerAppend.sourcePath}`, 'info')
    },
  })
}

function loadProviderAppend(ctx: ExtensionContext, provider: string): ProviderAppend | undefined {
  const filename = getProviderAppendFilename(provider)
  const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, filename)

  if (ctx.isProjectTrusted() && existsSync(projectPath)) {
    return {
      text: resolvePromptFile(projectPath, 'project provider append system prompt'),
      sourcePath: projectPath,
    }
  }

  const globalPath = join(getAgentDir(), filename)
  if (existsSync(globalPath)) {
    return {
      text: resolvePromptFile(globalPath, 'global provider append system prompt'),
      sourcePath: globalPath,
    }
  }

  return undefined
}

function getProviderAppendFilename(provider: string): string {
  if (!providerNamePattern.test(provider)) {
    throw new Error(
      `Provider name ${JSON.stringify(provider)} cannot be used in an APPEND_SYSTEM.<provider>.md filename.`,
    )
  }

  return `APPEND_SYSTEM.${provider}.md`
}

function resolvePromptFile(filePath: string, description: string): string {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch (error) {
    console.error(`Warning: Could not read ${description} file ${filePath}: ${error}`)
    return filePath
  }
}
