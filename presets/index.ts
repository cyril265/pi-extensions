/**
 * Preset Extension
 *
 * Allows defining named presets that configure model, thinking level, readonly mode,
 * and system prompt instructions. Presets are defined in JSON config files
 * and can be activated via CLI flag, /preset command, or Ctrl+Shift+U to cycle.
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/presets.json (global)
 * - <cwd>/.pi/presets.json (project-local)
 *
 * Example presets.json:
 * ```json
 * {
 *   "plan": {
 *     "provider": "openai-codex",
 *     "model": "gpt-5.2-codex",
 *     "thinkingLevel": "high",
 *     "readonly": true,
 *     "instructions": "You are in PLANNING MODE. Your job is to deeply understand the problem and create a detailed implementation plan.\n\nRules:\n- DO NOT make any changes. You cannot edit or write files.\n- Read files IN FULL (no offset/limit) to get complete context. Partial reads miss critical details.\n- Explore thoroughly: grep for related code, find similar patterns, understand the architecture.\n- Ask clarifying questions if requirements are ambiguous. Do not assume.\n- Identify risks, edge cases, and dependencies before proposing solutions.\n\nOutput:\n- Create a structured plan with numbered steps.\n- For each step: what to change, why, and potential risks.\n- List files that will be modified.\n- Note any tests that should be added or updated.\n\nWhen done, ask the user if they want you to:\n1. Write the plan to a markdown file (e.g., PLAN.md)\n2. Create a GitHub issue with the plan\n3. Proceed to implementation (they should switch to 'implement' preset)"
 *   },
 *   "implement": {
 *     "provider": "anthropic",
 *     "model": "claude-sonnet-4-5",
 *     "thinkingLevel": "high",
 *     "instructions": "You are in IMPLEMENTATION MODE. Your job is to make focused, correct changes.\n\nRules:\n- Keep scope tight. Do exactly what was asked, no more.\n- Read files before editing to understand current state.\n- Make surgical edits. Prefer edit over write for existing files.\n- Explain your reasoning briefly before each change.\n- Run tests or type checks after changes if the project has them (npm test, npm run check, etc.).\n- If you encounter unexpected complexity, STOP and explain the issue rather than hacking around it.\n\nIf no plan exists:\n- Ask clarifying questions before starting.\n- Propose what you'll do and get confirmation for non-trivial changes.\n\nAfter completing changes:\n- Summarize what was done.\n- Note any follow-up work or tests that should be added."
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi --preset plan` - start with plan preset
 * - `/preset` - show selector to switch presets mid-session
 * - `/preset implement` - switch to implement preset directly
 * - `/readonly <prompt>` - run one prompt with edit/write tools disabled
 * - `<prompt> !readonly` - same as `/readonly <prompt>`
 * - `Ctrl+Shift+U` - cycle through presets
 *
 * CLI flags always override preset values.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSupportedThinkingLevels, type ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { DynamicBorder, getAgentDir } from '@earendil-works/pi-coding-agent'
import {
  type Component,
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  Key,
  type SelectItem,
  SelectList,
  Text,
} from '@earendil-works/pi-tui'

type ThinkingLevel = ModelThinkingLevel
const DEFAULT_ACTIVE_TOOLS = ['read', 'bash', 'edit', 'write']
const WRITE_TOOL_NAMES = new Set(['edit', 'write'])
const READONLY_TURN_INSTRUCTIONS = `Readonly request: NO EDITS!`
const READONLY_SUFFIX_PATTERN = /(?:^|\s)!readonly\s*$/

// Preset configuration
interface Preset {
  /** Provider name (e.g., "anthropic", "openai") */
  provider?: string
  /** Model ID (e.g., "claude-sonnet-4-5") */
  model?: string
  /** Thinking level */
  thinkingLevel?: ThinkingLevel
  /** Enable read-only mode by removing write tools from default active tools */
  readonly?: boolean
  /** Instructions to append to system prompt */
  instructions?: string
}

interface PresetsConfig {
  [name: string]: Preset
}

function getAvailableThinkingLevels(ctx: ExtensionContext): ThinkingLevel[] {
  return ctx.model ? getSupportedThinkingLevels(ctx.model) : ['off']
}

/**
 * Load presets from config files.
 * Project-local presets override global presets with the same name.
 */
function loadPresets(cwd: string): PresetsConfig {
  const globalPath = join(getAgentDir(), 'presets.json')
  const projectPath = join(cwd, '.pi', 'presets.json')

  let globalPresets: PresetsConfig = {}
  let projectPresets: PresetsConfig = {}

  // Load global presets
  if (existsSync(globalPath)) {
    try {
      const content = readFileSync(globalPath, 'utf-8')
      globalPresets = JSON.parse(content)
    } catch (err) {
      console.error(`Failed to load global presets from ${globalPath}: ${err}`)
    }
  }

  // Load project presets
  if (existsSync(projectPath)) {
    try {
      const content = readFileSync(projectPath, 'utf-8')
      projectPresets = JSON.parse(content)
    } catch (err) {
      console.error(`Failed to load project presets from ${projectPath}: ${err}`)
    }
  }

  // Merge (project overrides global)
  return { ...globalPresets, ...projectPresets }
}

export default function presetExtension(pi: ExtensionAPI) {
  let presets: PresetsConfig = {}
  let activePresetName: string | undefined
  let activePreset: Preset | undefined
  let toolsBeforeReadonly: string[] | undefined
  let toolsBeforeReadonlyTurn: string[] | undefined

  // Register --preset CLI flag
  pi.registerFlag('preset', {
    description: 'Preset configuration to use',
    type: 'string',
  })

  function withoutWriteTools(toolNames: string[]): string[] {
    return toolNames.filter(toolName => !WRITE_TOOL_NAMES.has(toolName))
  }

  function stripReadonlySuffix(prompt: string): string | undefined {
    const match = prompt.match(READONLY_SUFFIX_PATTERN)
    if (!match) return undefined

    return prompt.slice(0, match.index).trimEnd()
  }

  function applyReadonlyMode(preset: Preset, fallbackToDefaultTools: boolean) {
    const currentToolNames = pi.getActiveTools()
    const baseToolNames =
      fallbackToDefaultTools && currentToolNames.length === 0
        ? DEFAULT_ACTIVE_TOOLS
        : currentToolNames

    if (preset.readonly) {
      if (!(activePreset?.readonly || toolsBeforeReadonly)) {
        toolsBeforeReadonly = baseToolNames
      }

      const activeTools = withoutWriteTools(baseToolNames)
      pi.setActiveTools(activeTools)
    } else if (activePreset?.readonly) {
      const restoredTools =
        toolsBeforeReadonly ??
        (fallbackToDefaultTools
          ? [...new Set([...baseToolNames, ...DEFAULT_ACTIVE_TOOLS])]
          : baseToolNames)
      pi.setActiveTools(restoredTools)
      toolsBeforeReadonly = undefined
    }
  }

  function startReadonlyTurn(ctx: ExtensionContext, busyMessage: string): boolean {
    if (!ctx.isIdle()) {
      ctx.ui.notify(busyMessage, 'warning')
      return false
    }

    const currentTools = pi.getActiveTools()
    if (!toolsBeforeReadonlyTurn) {
      toolsBeforeReadonlyTurn = currentTools
    }
    pi.setActiveTools(withoutWriteTools(currentTools))
    ctx.ui.setStatus('readonly', ctx.ui.theme.fg('warning', 'readonly'))

    return true
  }

  function restoreReadonlyTurn(ctx: ExtensionContext) {
    if (!toolsBeforeReadonlyTurn) return

    pi.setActiveTools(toolsBeforeReadonlyTurn)
    toolsBeforeReadonlyTurn = undefined
    ctx.ui.setStatus('readonly', undefined)
  }

  /**
   * Apply a preset configuration.
   */
  async function applyPreset(
    name: string,
    preset: Preset,
    ctx: ExtensionContext,
    fallbackToDefaultTools = false,
  ): Promise<boolean> {
    // Apply model if specified
    if (preset.provider && preset.model) {
      const model = ctx.modelRegistry.find(preset.provider, preset.model)
      if (model) {
        const success = await pi.setModel(model)
        if (!success) {
          ctx.ui.notify(
            `Preset "${name}": No API key for ${preset.provider}/${preset.model}`,
            'warning',
          )
          return false
        }
      } else {
        ctx.ui.notify(
          `Preset "${name}": Model ${preset.provider}/${preset.model} not found`,
          'warning',
        )
        return false
      }
    }

    // Apply thinking level if specified
    if (preset.thinkingLevel) {
      pi.setThinkingLevel(preset.thinkingLevel)
    }

    // Apply readonly mode if enabled, restore previous tools when leaving readonly
    applyReadonlyMode(preset, fallbackToDefaultTools)

    // Store active preset for system prompt injection
    activePresetName = name
    activePreset = preset

    return true
  }

  /**
   * Build description string for a preset.
   */
  function buildPresetDescription(preset: Preset): string {
    const parts: string[] = []

    if (preset.provider && preset.model) {
      parts.push(`${preset.provider}/${preset.model}`)
    }
    if (preset.thinkingLevel) {
      parts.push(`thinking:${preset.thinkingLevel}`)
    }
    if (preset.readonly) {
      parts.push('readonly')
    }
    if (preset.instructions) {
      const truncated =
        preset.instructions.length > 30
          ? `${preset.instructions.slice(0, 27)}...`
          : preset.instructions
      parts.push(`"${truncated}"`)
    }

    return parts.join(' | ')
  }

  /**
   * Show preset selector UI using custom SelectList component.
   */
  async function showPresetSelector(ctx: ExtensionContext): Promise<void> {
    const presetNames = Object.keys(presets)

    if (presetNames.length === 0) {
      ctx.ui.notify(
        'No presets defined. Add presets to ~/.pi/agent/presets.json or .pi/presets.json',
        'warning',
      )
      return
    }

    // Build select items with descriptions
    const items: SelectItem[] = presetNames.map(name => {
      const preset = presets[name]
      const isActive = name === activePresetName
      return {
        value: name,
        label: isActive ? `${name} (active)` : name,
        description: buildPresetDescription(preset),
      }
    })

    // Add "None" option to clear preset
    items.push({
      value: '(none)',
      label: '(none)',
      description: 'Clear active preset',
    })

    const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
      const container = new Container()
      container.addChild(new DynamicBorder(str => theme.fg('accent', str)))

      // Header
      container.addChild(new Text(theme.fg('accent', theme.bold('Select Preset'))))

      const searchInput = new Input()
      container.addChild(searchInput)

      const listContainer = new Container()
      container.addChild(listContainer)

      let selectList: SelectList

      function updateList(query: string) {
        const filteredItems = query
          ? fuzzyFilter(items, query, item => `${item.label} ${item.description ?? ''}`)
          : items

        selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 10), {
          selectedPrefix: text => theme.fg('accent', text),
          selectedText: text => theme.fg('accent', text),
          description: text => theme.fg('muted', text),
          scrollInfo: text => theme.fg('dim', text),
          noMatch: () => theme.fg('warning', '  No matching presets'),
        })
        selectList.onSelect = item => done(item.value)
        selectList.onCancel = () => done(null)

        listContainer.clear()
        listContainer.addChild(selectList)
      }

      updateList('')

      // Footer hint
      container.addChild(
        new Text(theme.fg('dim', 'type to search • ↑↓ navigate • enter select • esc cancel')),
      )

      container.addChild(new DynamicBorder(str => theme.fg('accent', str)))

      const component: Component & Focusable = {
        get focused() {
          return searchInput.focused
        },
        set focused(value: boolean) {
          searchInput.focused = value
        },
        render(width: number) {
          return container.render(width)
        },
        invalidate() {
          container.invalidate()
        },
        handleInput(data: string) {
          if (
            keybindings.matches(data, 'tui.select.up') ||
            keybindings.matches(data, 'tui.select.down') ||
            keybindings.matches(data, 'tui.select.confirm') ||
            keybindings.matches(data, 'tui.select.cancel')
          ) {
            selectList.handleInput(data)
          } else {
            const previousQuery = searchInput.getValue()
            searchInput.handleInput(data)
            const query = searchInput.getValue()
            if (query !== previousQuery) updateList(query)
          }
          tui.requestRender()
        },
      }

      return component
    })

    if (!result) return

    if (result === '(none)') {
      // Clear preset
      if (activePreset?.readonly) {
        applyReadonlyMode({}, false)
      }
      activePresetName = undefined
      activePreset = undefined
      toolsBeforeReadonly = undefined
      pi.appendEntry('preset-state', { name: null })
      ctx.ui.notify('Preset cleared', 'info')
      updateStatus(ctx)
      return
    }

    const preset = presets[result]
    if (preset) {
      const applied = await applyPreset(result, preset, ctx)
      if (!applied) return

      pi.appendEntry('preset-state', { name: result, toolsBeforeReadonly })
      ctx.ui.notify(`Preset "${result}" activated`, 'info')
      updateStatus(ctx)
    }
  }

  async function showThinkingSelector(ctx: ExtensionContext): Promise<void> {
    const availableLevels = getAvailableThinkingLevels(ctx)
    const items: SelectItem[] = availableLevels.map(level => ({
      value: level,
      label: level,
      description: `Set thinking level to ${level}`,
    }))
    const currentThinkingLevel = pi.getThinkingLevel()

    const result = await ctx.ui.custom<ThinkingLevel | null>((tui, theme, _kb, done) => {
      const container = new Container()
      container.addChild(new DynamicBorder(str => theme.fg('accent', str)))

      container.addChild(new Text(theme.fg('accent', theme.bold('Select Thinking Level'))))

      const selectList = new SelectList(items, items.length, {
        selectedPrefix: text => theme.fg('accent', text),
        selectedText: text => theme.fg('accent', text),
        description: text => theme.fg('muted', text),
        scrollInfo: text => theme.fg('dim', text),
        noMatch: text => theme.fg('warning', text),
      })
      const selectedIndex = availableLevels.indexOf(currentThinkingLevel)
      if (selectedIndex !== -1) {
        selectList.setSelectedIndex(selectedIndex)
      }

      selectList.onSelect = item => done(item.value as ThinkingLevel)
      selectList.onCancel = () => done(null)

      container.addChild(selectList)

      container.addChild(new Text(theme.fg('dim', '↑↓ navigate • enter select • esc cancel')))

      container.addChild(new DynamicBorder(str => theme.fg('accent', str)))

      return {
        render(width: number) {
          return container.render(width)
        },
        invalidate() {
          container.invalidate()
        },
        handleInput(data: string) {
          selectList.handleInput(data)
          tui.requestRender()
        },
      }
    })

    if (!result) return

    pi.setThinkingLevel(result)
    ctx.ui.notify(`Thinking level set to ${pi.getThinkingLevel()}`, 'info')
  }

  /**
   * Update status indicator.
   */
  function updateStatus(ctx: ExtensionContext) {
    if (activePresetName) {
      ctx.ui.setStatus('preset', ctx.ui.theme.fg('accent', `preset:${activePresetName}`))
    } else {
      ctx.ui.setStatus('preset', undefined)
    }
  }

  function getPresetOrder(): string[] {
    return Object.keys(presets).sort()
  }

  async function cyclePreset(ctx: ExtensionContext): Promise<void> {
    const presetNames = getPresetOrder()
    if (presetNames.length === 0) {
      ctx.ui.notify(
        'No presets defined. Add presets to ~/.pi/agent/presets.json or .pi/presets.json',
        'warning',
      )
      return
    }

    const cycleList = ['(none)', ...presetNames]
    const currentName = activePresetName ?? '(none)'
    const currentIndex = cycleList.indexOf(currentName)
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % cycleList.length
    const nextName = cycleList[nextIndex]

    if (nextName === '(none)') {
      if (activePreset?.readonly) {
        applyReadonlyMode({}, false)
      }
      activePresetName = undefined
      activePreset = undefined
      toolsBeforeReadonly = undefined
      pi.appendEntry('preset-state', { name: null })
      ctx.ui.notify('Preset cleared', 'info')
      updateStatus(ctx)
      return
    }

    const preset = presets[nextName]
    if (!preset) return

    const applied = await applyPreset(nextName, preset, ctx)
    if (!applied) return

    pi.appendEntry('preset-state', { name: nextName, toolsBeforeReadonly })
    ctx.ui.notify(`Preset "${nextName}" activated`, 'info')
    updateStatus(ctx)
  }

  pi.registerShortcut(Key.ctrlShift('u'), {
    description: 'Cycle presets',
    handler: async ctx => {
      await cyclePreset(ctx)
    },
  })

  // Register /preset command
  pi.registerCommand('preset', {
    description: 'Switch preset configuration',
    handler: async (args, ctx) => {
      // If preset name provided, apply directly
      if (args?.trim()) {
        const name = args.trim()
        const preset = presets[name]

        if (!preset) {
          const available = Object.keys(presets).join(', ') || '(none defined)'
          ctx.ui.notify(`Unknown preset "${name}". Available: ${available}`, 'error')
          return
        }

        const applied = await applyPreset(name, preset, ctx)
        if (!applied) return

        pi.appendEntry('preset-state', { name, toolsBeforeReadonly })
        ctx.ui.notify(`Preset "${name}" activated`, 'info')
        updateStatus(ctx)
        return
      }

      // Otherwise show selector
      await showPresetSelector(ctx)
    },
  })

  pi.registerCommand('thinking', {
    description: 'Set thinking level',
    handler: async (args, ctx) => {
      const level = args?.trim()

      if (!level) {
        await showThinkingSelector(ctx)
        return
      }

      const availableLevels = getAvailableThinkingLevels(ctx)
      if (!availableLevels.includes(level as ThinkingLevel)) {
        ctx.ui.notify(
          `Thinking level "${level}" is unavailable for the current model. Available: ${availableLevels.join(', ')}`,
          'error',
        )
        return
      }

      pi.setThinkingLevel(level as ThinkingLevel)
      ctx.ui.notify(`Thinking level set to ${pi.getThinkingLevel()}`, 'info')
    },
  })

  pi.registerCommand('readonly', {
    description: 'Run one prompt without edit/write tools',
    handler: async (args, ctx) => {
      const prompt = args?.trim()

      if (!prompt) {
        ctx.ui.notify('Usage: /readonly <prompt>', 'warning')
        return
      }

      if (!startReadonlyTurn(ctx, 'Agent is busy. Run /readonly after it finishes.')) return

      try {
        pi.sendUserMessage(prompt)
      } catch (err) {
        restoreReadonlyTurn(ctx)
        const message = err instanceof Error ? err.message : String(err)
        ctx.ui.notify(`Failed to start readonly prompt: ${message}`, 'error')
      }
    },
  })

  pi.on('input', async (event, ctx) => {
    if (event.source === 'extension') {
      return { action: 'continue' }
    }

    const prompt = stripReadonlySuffix(event.text)
    if (prompt === undefined) {
      return { action: 'continue' }
    }

    if (!prompt.trim()) {
      ctx.ui.notify('Usage: <prompt> !readonly', 'warning')
      return { action: 'handled' }
    }

    if (!startReadonlyTurn(ctx, '!readonly is only supported when the agent is idle.')) {
      return { action: 'handled' }
    }

    return { action: 'transform', text: prompt }
  })

  // Inject preset instructions into system prompt
  pi.on('before_agent_start', async event => {
    const instructions: string[] = []

    if (activePreset?.instructions) {
      instructions.push(activePreset.instructions)
    }
    if (toolsBeforeReadonlyTurn) {
      instructions.push(READONLY_TURN_INSTRUCTIONS)
    }

    if (instructions.length > 0) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n${instructions.join('\n\n')}`,
      }
    }
  })

  pi.on('agent_end', async (_event, ctx) => {
    restoreReadonlyTurn(ctx)
  })

  // Initialize on session start
  pi.on('session_start', async (_event, ctx) => {
    // Load presets from config files
    presets = loadPresets(ctx.cwd)

    const branch = ctx.sessionManager.getBranch()
    const presetEntry = branch
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === 'custom' && e.customType === 'preset-state',
      )
      .pop() as { data?: { name: string | null; toolsBeforeReadonly?: string[] } } | undefined

    if (Array.isArray(presetEntry?.data?.toolsBeforeReadonly)) {
      toolsBeforeReadonly = presetEntry.data.toolsBeforeReadonly
    }

    const restoredPreset = presetEntry?.data?.name ? presets[presetEntry.data.name] : undefined

    // Check for --preset flag
    const presetFlag = pi.getFlag('preset')
    if (typeof presetFlag === 'string' && presetFlag) {
      const preset = presets[presetFlag]
      if (preset) {
        if (restoredPreset?.readonly) {
          activePresetName = presetEntry?.data?.name
          activePreset = restoredPreset
        }
        const applied = await applyPreset(presetFlag, preset, ctx, true)
        if (applied) {
          if (!preset.readonly && pi.getActiveTools().length === 0) {
            pi.setActiveTools(DEFAULT_ACTIVE_TOOLS)
          }
          pi.appendEntry('preset-state', { name: presetFlag, toolsBeforeReadonly })
          ctx.ui.notify(`Preset "${presetFlag}" activated`, 'info')
        }
      } else {
        const available = Object.keys(presets).join(', ') || '(none defined)'
        ctx.ui.notify(`Unknown preset "${presetFlag}". Available: ${available}`, 'warning')
      }
    }

    // Restore preset from session state
    if (presetEntry?.data?.name && !presetFlag) {
      const preset = presets[presetEntry.data.name]
      if (preset) {
        if (!preset.readonly && pi.getActiveTools().length === 0) {
          pi.setActiveTools(DEFAULT_ACTIVE_TOOLS)
        } else {
          applyReadonlyMode(preset, true)
        }
        activePresetName = presetEntry.data.name
        activePreset = preset
        // Don't re-apply model on restore, just keep the name for instructions
      }
    }

    updateStatus(ctx)
  })

  // Persist preset state
  pi.on('turn_start', async () => {
    if (activePresetName) {
      pi.appendEntry('preset-state', { name: activePresetName, toolsBeforeReadonly })
    }
  })
}
