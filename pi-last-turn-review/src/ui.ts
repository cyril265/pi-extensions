import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AnnotateWindowData, ReviewWindowData } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const webDir = join(__dirname, '..', 'web')
const read = (name: string): string => readFileSync(join(webDir, name), 'utf8')

function escapeForInlineScript(value: string): string {
  return value.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}

function escapeScriptText(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script')
}

function fill(html: string, slots: Record<string, string>): string {
  return Object.entries(slots).reduce((result, [slot, value]) => result.replace(slot, () => value), html)
}

export function buildReviewHtml(data: ReviewWindowData): string {
  return fill(read('index.html'), {
    __STYLES__: read('vendor/styles.css'),
    __DIFFS_JS__: escapeScriptText(read('vendor/diffs.js')),
    __DIFFS_WORKER_JS__: escapeScriptText(read('vendor/diffs-worker.js')),
    __INLINE_DATA__: escapeForInlineScript(JSON.stringify(data)),
    __INLINE_JS__: read('app.js'),
  })
}

export function buildAnnotateHtml(data: AnnotateWindowData): string {
  return fill(read('annotate.html'), {
    __STYLES__: read('vendor/styles.css'),
    __MARKDOWN_IT_JS__: escapeScriptText(read('vendor/markdown-it.js')),
    __INLINE_DATA__: escapeForInlineScript(JSON.stringify(data)),
    __INLINE_JS__: read('annotate.js'),
  })
}
