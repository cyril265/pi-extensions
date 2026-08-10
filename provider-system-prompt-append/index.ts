import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from '@earendil-works/pi-coding-agent'

const providerNamePattern = /^[A-Za-z0-9._-]+$/

type PromptAppend = {
  text: string
  sourcePath: string
}

type CurrentAppends = {
  provider: string
  model: string
  providerAppend?: PromptAppend
  modelAppend?: PromptAppend
}

export default function providerSystemPromptAppend(pi: ExtensionAPI) {
  const warnedModels = new Set<string>()

  function getCurrentAppends(
    ctx: ExtensionContext,
  ): CurrentAppends | undefined {
    const currentModel = ctx.model
    if (!currentModel) return undefined

    const { provider, id: model } = currentModel

    try {
      return {
        provider,
        model,
        providerAppend: loadPromptAppend(
          ctx,
          getProviderAppendFilename(provider),
          'provider append system prompt',
        ),
        modelAppend: loadPromptAppend(
          ctx,
          getModelAppendFilename(provider, model),
          'model append system prompt',
        ),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const modelKey = `${provider}/${model}`
      if (!warnedModels.has(modelKey)) {
        ctx.ui.notify(message, 'warning')
        warnedModels.add(modelKey)
      }
      return undefined
    }
  }

  pi.on('session_start', async () => {
    warnedModels.clear()
  })

  pi.on('before_agent_start', async (event, ctx) => {
    const current = getCurrentAppends(ctx)
    if (!current) return

    const appendText = [current.providerAppend, current.modelAppend]
      .map((append) => append?.text)
      .filter((text): text is string => text !== undefined && text.length > 0)
      .join('\n\n')

    if (appendText.length === 0) return

    return {
      systemPrompt: `${event.systemPrompt}\n\n${appendText}`,
    }
  })
  pi.registerCommand('provider-system-prompt-append', {
    description: 'Show the current provider and model APPEND_SYSTEM file status',
    handler: async (_args, ctx) => {
      if (!ctx.model) {
        ctx.ui.notify('No model is selected yet.', 'warning')
        return
      }

      const current = getCurrentAppends(ctx)
      if (!current) return

      ctx.ui.notify(
        [
          `Current model: ${current.provider}/${current.model}`,
          `Provider append: ${current.providerAppend?.sourcePath ?? 'none'}`,
          `Model append: ${current.modelAppend?.sourcePath ?? 'none'}`,
        ].join('\n'),
        'info',
      )
    },
  })
}

function loadPromptAppend(
  ctx: ExtensionContext,
  filename: string,
  description: string,
): PromptAppend | undefined {
  const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, filename)

  if (ctx.isProjectTrusted() && existsSync(projectPath)) {
    return {
      text: resolvePromptFile(projectPath, `project ${description}`),
      sourcePath: projectPath,
    }
  }

  const globalPath = join(getAgentDir(), filename)
  if (existsSync(globalPath)) {
    return {
      text: resolvePromptFile(globalPath, `global ${description}`),
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

function getModelAppendFilename(provider: string, model: string): string {
  if (!providerNamePattern.test(provider)) {
    throw new Error(
      `Provider name ${JSON.stringify(provider)} cannot be used in an APPEND_SYSTEM.<provider>.<model>.md filename.`,
    )
  }

  return `APPEND_SYSTEM.${provider}.${encodeURIComponent(model)}.md`
}

function resolvePromptFile(filePath: string, description: string): string {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch (error) {
    console.error(`Warning: Could not read ${description} file ${filePath}: ${error}`)
    return filePath
  }
}
