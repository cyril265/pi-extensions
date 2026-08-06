import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import unifiedEditExtension, { UNIFIED_EDIT_VERSION } from './unified-edit.ts'

type EditTool = {
  execute: (
    toolCallId: string,
    params: { text: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: { cwd: string },
  ) => Promise<{ details?: unknown }>
}

type ToolResultEvent = {
  toolCallId: string
  toolName: string
  details?: unknown
}

type ToolResultPatch = { details: Record<string, unknown> } | undefined
type ToolResultHandler = (event: ToolResultEvent) => ToolResultPatch

let editTool: EditTool | undefined
let toolResultHandler: ToolResultHandler | undefined
const extensionApi = {
  registerTool(tool: unknown) {
    editTool = tool as EditTool
  },
  on(event: string, handler: unknown) {
    if (event === 'tool_result') toolResultHandler = handler as ToolResultHandler
  },
}
unifiedEditExtension(extensionApi as never)

const workspaces: string[] = []

async function createWorkspace(files: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp('/tmp/unified-edit-test-')
  workspaces.push(cwd)
  for (const [path, content] of Object.entries(files)) {
    const absolutePath = join(cwd, path)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, content, 'utf8')
  }
  return cwd
}

async function edit(cwd: string, text: string): Promise<void> {
  if (!editTool) throw new Error('Unified edit tool was not registered.')
  await editTool.execute('test-edit', { text }, undefined, undefined, { cwd })
}

function toolResult(event: ToolResultEvent): ToolResultPatch {
  if (!toolResultHandler) throw new Error('Unified edit tool result handler was not registered.')
  return toolResultHandler(event)
}

async function contents(cwd: string, path = 'file.txt'): Promise<string> {
  return readFile(join(cwd, path), 'utf8')
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('unified patch matching', () => {
  test('records the implementation version on successful and failed edit results', async () => {
    expect(UNIFIED_EDIT_VERSION).toBe(5)
    if (!editTool) throw new Error('Unified edit tool was not registered.')
    const cwd = await createWorkspace({ 'file.txt': 'old\n' })

    const successResult = await editTool.execute(
      'version-success',
      {
        text: `*** Begin Patch
*** Update File: file.txt
@@
-old
+new
*** End Patch`,
      },
      undefined,
      undefined,
      { cwd },
    )
    const successfulResult = toolResult({
      toolCallId: 'version-success',
      toolName: 'edit',
      details: successResult.details,
    })
    expect(successfulResult?.details.unifiedEdit).toEqual({ version: UNIFIED_EDIT_VERSION })

    await expect(
      editTool.execute(
        'version-failure',
        { text: '*** Begin Patch\n*** Update File: missing.txt\n*** End Patch' },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow()
    const failedResult = toolResult({
      toolCallId: 'version-failure',
      toolName: 'edit',
    })
    expect(failedResult?.details.unifiedEdit).toEqual({ version: UNIFIED_EDIT_VERSION })

    expect(
      toolResult({ toolCallId: 'other-call', toolName: 'edit', details: { source: 'other' } }),
    ).toBeUndefined()
  })

  test('rejects legacy row edit scripts', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'old\n' })

    await expect(
      edit(
        cwd,
        `[file.txt]
@REPLACE
-old
+new`,
      ),
    ).rejects.toThrow("The first line of the patch must be '*** Begin Patch'")
    await expect(contents(cwd)).resolves.toBe('old\n')
  })

  test('applies unique hunks emitted out of source order', async () => {
    const cwd = await createWorkspace({
      'file.txt': [
        '.error {',
        '  color: red;',
        '}',
        '',
        'render() {',
        '  return oldRender;',
        '}',
        '',
        'updated() {',
        '  oldUpdate();',
        '}',
        '',
      ].join('\n'),
    })

    await edit(
      cwd,
      `*** Begin Patch
*** Update File: file.txt
@@
 render() {
-  return oldRender;
+  return newRender;
 }
@@
 updated() {
-  oldUpdate();
+  newUpdate();
 }
@@
 .error {
-  color: red;
+  color: blue;
 }
*** End Patch`,
    )

    expect(await contents(cwd)).toContain('color: blue;')
    expect(await contents(cwd)).toContain('return newRender;')
    expect(await contents(cwd)).toContain('newUpdate();')
  })

  test('falls back for a change context located before the cursor', async () => {
    const cwd = await createWorkspace({
      'file.txt': [
        'createState() {',
        '  enabled: false,',
        '}',
        '',
        'interface State {',
        '  enabled: boolean;',
        '}',
        '',
        'handle() {',
        '  oldHandler();',
        '}',
        '',
      ].join('\n'),
    })

    await edit(
      cwd,
      `*** Begin Patch
*** Update File: file.txt
@@
 createState() {
   enabled: false,
+  signature: "",
 }
@@
 handle() {
-  oldHandler();
+  newHandler();
 }
@@ interface State {
   enabled: boolean;
+  signature: string;
 }
*** End Patch`,
    )

    expect(await contents(cwd)).toContain('signature: "",')
    expect(await contents(cwd)).toContain('signature: string;')
    expect(await contents(cwd)).toContain('newHandler();')
  })

  test('rejects an ambiguous whole-file fallback with candidate line numbers', async () => {
    const cwd = await createWorkspace({
      'file.txt': ['target', 'one', 'target', 'two', 'later', ''].join('\n'),
    })

    await expect(
      edit(
        cwd,
        `*** Begin Patch
*** Update File: file.txt
@@
-later
+changed later
@@
-target
+changed target
*** End Patch`,
      ),
    ).rejects.toThrow('matching starts: 1, 3')
  })

  test('rejects a duplicate hunk instead of applying it twice', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'old\n' })

    await expect(
      edit(
        cwd,
        `*** Begin Patch
*** Update File: file.txt
@@
-old
+new
@@
-old
+new again
*** End Patch`,
      ),
    ).rejects.toThrow('overlaps an earlier hunk')
  })

  test('rejects an insertion inside a replacement range', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'start\ninside\nend\n' })

    await expect(
      edit(
        cwd,
        `*** Begin Patch
*** Update File: file.txt
@@
-start
-inside
-end
+replacement
@@ start
+inserted
*** End Patch`,
      ),
    ).rejects.toThrow('overlaps an earlier hunk')
  })

  test('preserves insertions at replacement boundaries', async () => {
    const startCwd = await createWorkspace({ 'file.txt': 'anchor\nold one\nold two\n' })

    await edit(
      startCwd,
      `*** Begin Patch
*** Update File: file.txt
@@
-old one
-old two
+replacement
@@ anchor
+before replacement
*** End Patch`,
    )
    expect(await contents(startCwd)).toBe('anchor\nbefore replacement\nreplacement\n')

    const endCwd = await createWorkspace({ 'file.txt': 'old one\nold two\ntail\n' })
    await edit(
      endCwd,
      `*** Begin Patch
*** Update File: file.txt
@@
-old one
-old two
+replacement
@@ old two
+after replacement
*** End Patch`,
    )
    expect(await contents(endCwd)).toBe('replacement\nafter replacement\ntail\n')
  })

  test('keeps first-match forward semantics for repeated text', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'target\nmiddle\ntarget\n' })

    await edit(
      cwd,
      `*** Begin Patch
*** Update File: file.txt
@@
-target
+changed
*** End Patch`,
    )

    expect(await contents(cwd)).toBe('changed\nmiddle\ntarget\n')
  })

  test('uses a unique exact match before a more ambiguous relaxed pass', async () => {
    const cwd = await createWorkspace({ 'file.txt': '  target\ntarget\n' })

    await edit(
      cwd,
      `*** Begin Patch
*** Update File: file.txt
@@
-  target
+  changed
*** End Patch`,
    )

    expect(await contents(cwd)).toBe('  changed\ntarget\n')
  })

  test('keeps a relaxed forward match ahead of an exact backward match', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'target\nmarker\n  target  \n' })

    await edit(
      cwd,
      `*** Begin Patch
*** Update File: file.txt
@@
-marker
+changed marker
@@
-target
+changed target
*** End Patch`,
    )

    expect(await contents(cwd)).toBe('target\nchanged marker\nchanged target\n')
  })

  test('preserves actual context bytes when relaxed matching is used', async () => {
    const cwd = await createWorkspace({
      'file.txt': "const label = “actual”;  \nold\nconst end = 'kept'; \t\n",
    })
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      ' const label = "actual";',
      '-old',
      '+new',
      " const end = 'kept';",
      '*** End Patch',
    ].join('\n')

    await edit(cwd, patch)

    expect(await contents(cwd)).toBe("const label = “actual”;  \nnew\nconst end = 'kept'; \t\n")
  })

  test('preserves context around multiple change groups', async () => {
    const cwd = await createWorkspace({
      'file.txt': 'leading  \nold one\ninterior \t\nold two\ntrailing  \n',
    })
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      ' leading',
      '-old one',
      '+new one',
      ' interior',
      '-old two',
      '+new two',
      ' trailing',
      '*** End Patch',
    ].join('\n')

    await edit(cwd, patch)

    expect(await contents(cwd)).toBe('leading  \nnew one\ninterior \t\nnew two\ntrailing  \n')
  })

  test('rejects an ambiguous backward change context', async () => {
    const cwd = await createWorkspace({
      'file.txt': ['anchor', 'one', 'anchor', 'two', 'later', ''].join('\n'),
    })

    await expect(
      edit(
        cwd,
        `*** Begin Patch
*** Update File: file.txt
@@
-later
+changed later
@@ anchor
+inserted
*** End Patch`,
      ),
    ).rejects.toThrow('matching lines: 1, 3')
  })

  test('does not use whole-file fallback for an end-of-file hunk', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'target\nnot the tail\n' })

    await expect(
      edit(
        cwd,
        `*** Begin Patch
*** Update File: file.txt
@@
-target
+changed
*** End of File
*** End Patch`,
      ),
    ).rejects.toThrow('only matches at the file tail')
  })

  test('preserves trailing-empty-line retry during a backward fallback', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'earlier\nseparator\nlater\n' })

    await edit(
      cwd,
      `*** Begin Patch
*** Update File: file.txt
@@
-later
+changed later
@@
-earlier
+changed earlier

*** End Patch`,
    )

    expect(await contents(cwd)).toBe('changed earlier\nseparator\nchanged later\n')
  })

  test('reports partial source lines without applying them', async () => {
    const cwd = await createWorkspace({
      'file.txt': 'The tool exposes alpha and beta. Additional details remain here.\n',
    })

    await expect(
      edit(
        cwd,
        `*** Begin Patch
*** Update File: file.txt
@@
-The tool exposes alpha and beta.
+The tool exposes alpha, beta, and gamma.
*** End Patch`,
      ),
    ).rejects.toThrow('matches only part of source line 1')
  })

  test('does not report a blank line as a partial match', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'present\n\nstill present\n' })

    try {
      await edit(
        cwd,
        `*** Begin Patch
*** Update File: file.txt
@@
-a wholly absent source line
+replacement
*** End Patch`,
      )
      throw new Error('Expected edit to fail.')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('Failed to find expected lines')
      expect(message).not.toContain('matches only part')
    }
  })

  test('uses a context-only hunk as navigation without rewriting it', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'anchor  \ncontext \t\nold\n' })
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      ' anchor',
      ' context',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n')

    await edit(cwd, patch)

    expect(await contents(cwd)).toBe('anchor  \ncontext \t\nnew\n')
  })

  test('navigation disambiguates a repeated target', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'target\nbetween\nanchor\ntarget\n' })
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      ' anchor',
      '@@',
      '-target',
      '+changed',
      '*** End Patch',
    ].join('\n')

    await edit(cwd, patch)

    expect(await contents(cwd)).toBe('target\nbetween\nanchor\nchanged\n')
  })

  test('supports a rowless named navigation hunk', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'target\nfunctionName  \ntarget\n' })
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@ functionName',
      '@@',
      '-target',
      '+changed',
      '*** End Patch',
    ].join('\n')

    await edit(cwd, patch)

    expect(await contents(cwd)).toBe('target\nfunctionName  \nchanged\n')
  })

  test('requires a mutation alongside rowless named navigation', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'functionName\ntail\n' })
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@ functionName',
      '*** End Patch',
    ].join('\n')

    await expect(edit(cwd, patch)).rejects.toThrow('contains only context rows')
  })

  test('rejects stale and ambiguous rowless named navigation', async () => {
    const staleCwd = await createWorkspace({ 'file.txt': 'actual\ntarget\n' })
    const stalePatch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@ missingFunction',
      '@@',
      '-target',
      '+changed',
      '*** End Patch',
    ].join('\n')
    await expect(edit(staleCwd, stalePatch)).rejects.toThrow('Failed to find context')

    const ambiguousCwd = await createWorkspace({
      'file.txt': 'functionName\none\nfunctionName\ntwo\nlater\n',
    })
    const ambiguousPatch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      '-later',
      '+changed later',
      '@@ functionName',
      '*** End Patch',
    ].join('\n')
    await expect(edit(ambiguousCwd, ambiguousPatch)).rejects.toThrow('matching lines: 1, 3')
  })

  test('keeps a bare rowless hunk invalid', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'target\n' })
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      '@@',
      '-target',
      '+changed',
      '*** End Patch',
    ].join('\n')

    await expect(edit(cwd, patch)).rejects.toThrow("Unexpected line found in update hunk: '@@'")
  })

  test('rejects ambiguous context-only navigation after the forward cursor', async () => {
    const cwd = await createWorkspace({
      'file.txt': 'anchor\none\nanchor\ntwo\nlater\n',
    })
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      '-later',
      '+changed later',
      '@@',
      ' anchor',
      '*** End Patch',
    ].join('\n')

    await expect(edit(cwd, patch)).rejects.toThrow('matching starts: 1, 3')
  })

  test('rejects stale context-only navigation', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'actual\nold\n' })
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      ' stale anchor',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n')

    await expect(edit(cwd, patch)).rejects.toThrow('Failed to find expected lines')
  })

  test('supports out-of-order context-only navigation', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'anchor\nold before\nseparator\nlater\n' })
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      '-later',
      '+changed later',
      '@@',
      ' anchor',
      '@@',
      '-old before',
      '+changed before',
      '*** End Patch',
    ].join('\n')

    await edit(cwd, patch)

    expect(await contents(cwd)).toBe('anchor\nchanged before\nseparator\nchanged later\n')
  })

  test('inserts immediately after a context-only navigation block', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'anchor one\nanchor two\ntail\n' })
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      ' anchor one',
      ' anchor two',
      '@@',
      '+inserted',
      '*** End Patch',
    ].join('\n')

    await edit(cwd, patch)

    expect(await contents(cwd)).toBe('anchor one\nanchor two\ninserted\ntail\n')
  })

  test('rejects context-only update operations but accepts insert-only hunks', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'anchor\ntail\n' })

    await expect(
      edit(
        cwd,
        `*** Begin Patch
*** Update File: file.txt
@@
 anchor
*** End Patch`,
      ),
    ).rejects.toThrow('contains only context rows')

    await edit(
      cwd,
      `*** Begin Patch
*** Update File: file.txt
@@ anchor
+inserted
*** End Patch`,
    )
    expect(await contents(cwd)).toBe('anchor\ninserted\ntail\n')
  })

  test('allows navigation inside a replacement while protecting later mutations', async () => {
    const successCwd = await createWorkspace({
      'file.txt': 'start\nanchor\nend\nafter old\n',
    })
    const successPatch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      '-start',
      '-anchor',
      '-end',
      '+replacement',
      '@@',
      ' anchor',
      '@@',
      '-after old',
      '+after new',
      '*** End Patch',
    ].join('\n')

    await edit(successCwd, successPatch)
    expect(await contents(successCwd)).toBe('replacement\nafter new\n')

    const overlapCwd = await createWorkspace({
      'file.txt': 'start\nanchor\nend\nafter old\n',
    })
    const overlapPatch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      '-start',
      '-anchor',
      '-end',
      '+replacement',
      '@@',
      ' anchor',
      '@@',
      '-anchor',
      '+changed anchor',
      '*** End Patch',
    ].join('\n')

    await expect(edit(overlapCwd, overlapPatch)).rejects.toThrow('overlaps an earlier hunk')
  })

  test('uses trailing-empty-line retry for context-only navigation', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'earlier\nseparator\nlater\n' })
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      '-later',
      '+changed later',
      '@@',
      ' earlier',
      '',
      '@@',
      '-separator',
      '+changed separator',
      '*** End Patch',
    ].join('\n')

    await edit(cwd, patch)

    expect(await contents(cwd)).toBe('earlier\nchanged separator\nchanged later\n')
  })

  test('honors end-of-file on context-only navigation', async () => {
    const successCwd = await createWorkspace({ 'file.txt': 'start\ntail\n' })
    const successPatch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      ' tail',
      '*** End of File',
      '@@',
      '-start',
      '+changed start',
      '*** End Patch',
    ].join('\n')

    await edit(successCwd, successPatch)
    expect(await contents(successCwd)).toBe('changed start\ntail\n')

    const failureCwd = await createWorkspace({ 'file.txt': 'target\nnot tail\nlater\n' })
    const failurePatch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      ' target',
      '*** End of File',
      '@@',
      '-later',
      '+changed later',
      '*** End Patch',
    ].join('\n')

    await expect(edit(failureCwd, failurePatch)).rejects.toThrow('only matches at the file tail')
  })

  test('allows a later update operation to target text created by an earlier one', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'old\n' })

    await edit(
      cwd,
      `*** Begin Patch
*** Update File: file.txt
@@
-old
+intermediate
*** Update File: file.txt
@@
-intermediate
+final
*** End Patch`,
    )

    expect(await contents(cwd)).toBe('final\n')
  })

  test('moves a file without requiring a content-changing hunk', async () => {
    const cwd = await createWorkspace({ 'source.txt': 'content without a trailing newline' })

    await edit(
      cwd,
      `*** Begin Patch
*** Update File: source.txt
*** Move to: destination.txt
*** End Patch`,
    )

    expect(await contents(cwd, 'destination.txt')).toBe('content without a trailing newline')
    await expect(readFile(join(cwd, 'source.txt'), 'utf8')).rejects.toThrow()
  })

  test('moves a file after verifying context-only navigation', async () => {
    const original = 'anchor  \ncontent without a trailing newline'
    const cwd = await createWorkspace({ 'source.txt': original })
    const patch = [
      '*** Begin Patch',
      '*** Update File: source.txt',
      '*** Move to: destination.txt',
      '@@',
      ' anchor',
      ' content without a trailing newline',
      '*** End Patch',
    ].join('\n')

    await edit(cwd, patch)

    expect(await contents(cwd, 'destination.txt')).toBe(original)
    await expect(readFile(join(cwd, 'source.txt'), 'utf8')).rejects.toThrow()
  })

  test('preserves the order of insert-only hunks at the same position', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'anchor\ntail\n' })

    await edit(
      cwd,
      `*** Begin Patch
*** Update File: file.txt
@@ anchor
+first
@@ anchor
+second
*** End Patch`,
    )

    expect(await contents(cwd)).toBe('anchor\nfirst\nsecond\ntail\n')
  })

  test('supports an insert-only end-of-file hunk', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'start\n' })

    await edit(
      cwd,
      `*** Begin Patch
*** Update File: file.txt
@@
+end
*** End of File
*** End Patch`,
    )

    expect(await contents(cwd)).toBe('start\nend\n')
  })

  test('preserves CRLF line endings', async () => {
    const cwd = await createWorkspace({ 'file.txt': 'first\r\nold\r\nlast\r\n' })

    await edit(
      cwd,
      `*** Begin Patch
*** Update File: file.txt
@@
-old
+new
*** End Patch`,
    )

    expect(await contents(cwd)).toBe('first\r\nnew\r\nlast\r\n')
  })
})
