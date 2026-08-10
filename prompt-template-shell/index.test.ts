import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from '@earendil-works/pi-coding-agent'
import promptTemplateShell, { expandTemplate, parseCommandArgs, substituteArgs } from './index.ts'

type InputHandler = (
  event: InputEvent,
  ctx: ExtensionContext,
) => InputEventResult | undefined | Promise<InputEventResult | undefined>

function captureInputHandler(templatePath: string): InputHandler {
  let handler: InputHandler | undefined
  const pi = {
    on(event: string, candidate: InputHandler) {
      if (event === 'input') handler = candidate
    },
    getCommands() {
      return [
        {
          name: 'dynamic',
          source: 'prompt',
          sourceInfo: {
            path: templatePath,
            source: 'local',
            scope: 'temporary',
            origin: 'top-level',
          },
        },
      ]
    },
  } as unknown as ExtensionAPI

  promptTemplateShell(pi)
  assert.ok(handler)
  return handler
}

function context(cwd: string, errors: string[]): ExtensionContext {
  return {
    cwd,
    // biome-ignore lint/style/useNamingConvention: Pi API property
    hasUI: true,
    ui: {
      notify(message: string) {
        errors.push(message)
      },
    },
  } as unknown as ExtensionContext
}

function input(text: string): InputEvent {
  return { type: 'input', text, source: 'interactive' }
}

test('matches Pi prompt-template argument parsing and substitution', () => {
  const args = parseCommandArgs('Button "click handler" remaining')
  assert.deepEqual(args, ['Button', 'click handler', 'remaining'])
  assert.equal(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Testing literal Pi placeholders
    substituteArgs('$1 | ${2:-default} | ${@:2} | $ARGUMENTS', args),
    'Button | click handler | click handler remaining | Button click handler remaining',
  )
})

test('expands only command tokens present in the template source', async () => {
  const commands: string[] = []
  const rendered = await expandTemplate(
    // biome-ignore lint/security/noSecrets: Shell syntax is test input, not a secret
    'Result: !`printf "%s" "$1"`\nArgument: $2',
    ['hello', '!`must-not-run`'],
    async command => {
      commands.push(command)
      return '$1'
    },
  )

  assert.deepEqual(commands, ['printf "%s" "hello"'])
  assert.equal(rendered, 'Result: $1\nArgument: !`must-not-run`')
})

test('expands dynamic commands in invoked prompt templates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-prompt-template-shell-'))
  try {
    const templatePath = join(root, 'dynamic.md')
    await writeFile(
      templatePath,
      [
        '---',
        'description: Dynamic test',
        '---',
        'Value: !`printf "%s" "$1"`',
        'All: $ARGUMENTS',
      ].join('\n'),
    )

    const errors: string[] = []
    const result = await captureInputHandler(templatePath)(
      input('/dynamic "hello world" second'),
      context(root, errors),
    )

    assert.deepEqual(result, {
      action: 'transform',
      text: 'Value: hello world\nAll: hello world second',
    })
    assert.deepEqual(errors, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('does not expand commands in direct prompts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-prompt-template-shell-direct-'))
  try {
    const marker = join(root, 'marker')
    const templatePath = join(root, 'dynamic.md')
    await writeFile(templatePath, 'Unused: !`true`')

    const result = await captureInputHandler(templatePath)(
      input(`Direct: !\`touch ${marker}\``),
      context(root, []),
    )

    assert.deepEqual(result, { action: 'continue' })
    await assert.rejects(readFile(marker), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('leaves ordinary prompt templates to Pi', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-prompt-template-shell-static-'))
  try {
    const templatePath = join(root, 'dynamic.md')
    await writeFile(templatePath, 'Static template with $1')

    const result = await captureInputHandler(templatePath)(
      input('/dynamic value'),
      context(root, []),
    )

    assert.deepEqual(result, { action: 'continue' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stops the prompt when a template command fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-prompt-template-shell-failure-'))
  try {
    const templatePath = join(root, 'dynamic.md')
    await writeFile(templatePath, 'Result: !`printf failure; exit 7`')

    const errors: string[] = []
    const result = await captureInputHandler(templatePath)(input('/dynamic'), context(root, errors))

    assert.deepEqual(result, { action: 'handled' })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /Command failed \(exit code 7\)/)
    assert.match(errors[0], /failure/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
