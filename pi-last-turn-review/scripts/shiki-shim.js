// Replaces the full `shiki` bundle (249 grammars) with the languages a code review is likely to hit.
// Unlisted languages render as plain text. Specifiers must be literal so esbuild inlines them.
export * from '@shikijs/core'
export { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
export { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import { createBundledHighlighter, createSingletonShorthands } from '@shikijs/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

export const bundledLanguages = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  markdown: () => import('@shikijs/langs/markdown'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  html: () => import('@shikijs/langs/html'),
  xml: () => import('@shikijs/langs/xml'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  fish: () => import('@shikijs/langs/fish'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  rust: () => import('@shikijs/langs/rust'),
  java: () => import('@shikijs/langs/java'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  python: () => import('@shikijs/langs/python'),
  go: () => import('@shikijs/langs/go'),
  csharp: () => import('@shikijs/langs/csharp'),
  sql: () => import('@shikijs/langs/sql'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  diff: () => import('@shikijs/langs/diff'),
}
export const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages,
  themes: {},
  engine: () => createOnigurumaEngine(import('shiki/wasm')),
})
export const { codeToHtml } = createSingletonShorthands(createHighlighter)
