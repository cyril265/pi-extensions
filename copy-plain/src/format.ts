const placeholderStart = '\uE000'
const placeholderEnd = '\uE001'

type ListKind = 'ol' | 'ul'

export function markdownToPlainText(markdown: string): string {
  const lines = normalizeLines(markdown).split('\n')
  const plainLines: string[] = []
  let inCodeFence = false

  for (const line of lines) {
    if (isFence(line)) {
      inCodeFence = !inCodeFence
      continue
    }

    if (inCodeFence) {
      plainLines.push(line)
      continue
    }

    if (isTableSeparator(line)) {
      continue
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      plainLines.push(inlineMarkdownToPlain(heading[2] ?? ''))
      continue
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      plainLines.push('────────')
      continue
    }

    const unordered = line.match(/^(\s*)[-*+]\s+(.+)$/)
    if (unordered) {
      const indent = plainIndent(unordered[1] ?? '')
      plainLines.push(`${indent}• ${inlineMarkdownToPlain(unordered[2] ?? '')}`)
      continue
    }

    const ordered = line.match(/^(\s*)(\d+[.)])\s+(.+)$/)
    if (ordered) {
      const indent = plainIndent(ordered[1] ?? '')
      const marker = ordered[2] ?? '1.'
      plainLines.push(`${indent}${marker} ${inlineMarkdownToPlain(ordered[3] ?? '')}`)
      continue
    }

    const quote = line.match(/^\s*>+\s?(.*)$/)
    if (quote) {
      plainLines.push(inlineMarkdownToPlain(quote[1] ?? ''))
      continue
    }

    if (looksLikeTableRow(line)) {
      plainLines.push(
        splitTableCells(line)
          .map(cell => inlineMarkdownToPlain(cell))
          .join('    '),
      )
      continue
    }

    plainLines.push(inlineMarkdownToPlain(line))
  }

  return plainLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function markdownToHtmlDocument(markdown: string): string {
  return [
    '<!doctype html>',
    '<html>',
    '<head><meta charset="utf-8"></head>',
    '<body>',
    markdownToHtmlFragment(markdown),
    '</body>',
    '</html>',
  ].join('\n')
}

function markdownToHtmlFragment(markdown: string): string {
  const lines = normalizeLines(markdown).split('\n')
  const html: string[] = []
  const paragraphLines: string[] = []
  const quoteLines: string[] = []
  let listKind: ListKind | undefined
  let inCodeFence = false
  let codeLanguage: string | undefined
  const codeLines: string[] = []

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return
    html.push(`<p>${inlineMarkdownToHtml(paragraphLines.join(' '))}</p>`)
    paragraphLines.length = 0
  }

  const flushQuote = () => {
    if (quoteLines.length === 0) return
    html.push(`<blockquote><p>${quoteLines.join('<br>')}</p></blockquote>`)
    quoteLines.length = 0
  }

  const flushList = () => {
    if (!listKind) return
    html.push(`</${listKind}>`)
    listKind = undefined
  }

  const flushTextBlocks = () => {
    flushParagraph()
    flushQuote()
    flushList()
  }

  const startList = (kind: ListKind) => {
    flushParagraph()
    flushQuote()
    if (listKind === kind) return
    flushList()
    listKind = kind
    html.push(`<${kind}>`)
  }

  for (const line of lines) {
    const fence = line.match(/^\s*(```|~~~)\s*([^`]*)$/)
    if (inCodeFence) {
      if (fence) {
        const languageAttribute = codeLanguage
          ? ` class="language-${escapeAttribute(codeLanguage)}"`
          : ''
        const code = escapeHtml(codeLines.join('\n'))
        html.push(`<pre><code${languageAttribute}>${code}</code></pre>`)
        inCodeFence = false
        codeLanguage = undefined
        codeLines.length = 0
        continue
      }

      codeLines.push(line)
      continue
    }

    if (fence) {
      flushTextBlocks()
      inCodeFence = true
      codeLanguage = normalizeCodeLanguage(fence[2] ?? '')
      continue
    }

    if (line.trim() === '') {
      flushTextBlocks()
      continue
    }

    if (isTableSeparator(line)) {
      continue
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      flushTextBlocks()
      const level = heading[1]?.length ?? 1
      html.push(`<h${level}>${inlineMarkdownToHtml(heading[2] ?? '')}</h${level}>`)
      continue
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushTextBlocks()
      html.push('<hr>')
      continue
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/)
    if (unordered) {
      startList('ul')
      html.push(`<li>${inlineMarkdownToHtml(unordered[1] ?? '')}</li>`)
      continue
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (ordered) {
      startList('ol')
      html.push(`<li>${inlineMarkdownToHtml(ordered[1] ?? '')}</li>`)
      continue
    }

    const quote = line.match(/^\s*>+\s?(.*)$/)
    if (quote) {
      flushParagraph()
      flushList()
      quoteLines.push(inlineMarkdownToHtml(quote[1] ?? ''))
      continue
    }

    if (looksLikeTableRow(line)) {
      flushTextBlocks()
      const cells = splitTableCells(line)
        .map(cell => `<td>${inlineMarkdownToHtml(cell)}</td>`)
        .join('')
      html.push(`<table><tr>${cells}</tr></table>`)
      continue
    }

    flushQuote()
    flushList()
    paragraphLines.push(line.trim())
  }

  if (inCodeFence) {
    const languageAttribute = codeLanguage
      ? ` class="language-${escapeAttribute(codeLanguage)}"`
      : ''
    const code = escapeHtml(codeLines.join('\n'))
    html.push(`<pre><code${languageAttribute}>${code}</code></pre>`)
  }

  flushTextBlocks()
  return html.join('\n')
}

function inlineMarkdownToPlain(input: string): string {
  let text = input
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match: string, alt: string, url: string) =>
      plainLinkText(alt, url),
    )
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match: string, label: string, url: string) =>
      plainLinkText(label, url),
    )
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/~~([^\n]+?)~~/g, '$1')
    .replace(/\*\*([^\n]+?)\*\*/g, '$1')
    .replace(/(^|[^\w])__([^\n]+?)__([^\w]|$)/g, '$1$2$3')
    .replace(/(^|[^\w])\*([^*\n]+?)\*([^\w]|$)/g, '$1$2$3')
    .replace(/(^|[^\w])_([^_\n]+?)_([^\w]|$)/g, '$1$2$3')

  text = text.replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, '$1')
  return text.trimEnd()
}

function inlineMarkdownToHtml(input: string): string {
  const placeholders: string[] = []
  const placeholder = (value: string) => {
    const token = `${placeholderStart}${placeholders.length}${placeholderEnd}`
    placeholders.push(value)
    return token
  }

  let text = input
    .replace(/`([^`\n]+)`/g, (_match: string, code: string) =>
      placeholder(`<code>${escapeHtml(code)}</code>`),
    )
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match: string, alt: string, url: string) =>
      placeholder(htmlLinkText(alt, url)),
    )
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match: string, label: string, url: string) =>
      placeholder(htmlLinkText(label, url)),
    )

  text = escapeHtml(text)
    .replace(/~~([^\n]+?)~~/g, '<s>$1</s>')
    .replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(
      /(^|[^\w])__([^\n]+?)__([^\w]|$)/g,
      (_match, prefix: string, content: string, suffix: string) =>
        `${prefix}<strong>${content}</strong>${suffix}`,
    )
    .replace(/(^|[^\w])\*([^*\n]+?)\*([^\w]|$)/g, '$1<em>$2</em>$3')
    .replace(/(^|[^\w])_([^_\n]+?)_([^\w]|$)/g, '$1<em>$2</em>$3')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, '$1')

  const placeholderPattern = new RegExp(`${placeholderStart}(\\d+)${placeholderEnd}`, 'g')
  return text.replace(placeholderPattern, (_match: string, index: string) => {
    const value = placeholders[Number.parseInt(index, 10)]
    return value ?? ''
  })
}

function plainLinkText(label: string, url: string): string {
  const cleanLabel = inlineMarkdownToPlain(label).trim()
  const cleanUrl = stripLinkTitle(url).trim()
  if (!cleanLabel) return cleanUrl
  if (cleanLabel === cleanUrl) return cleanUrl
  return `${cleanLabel} (${cleanUrl})`
}

function htmlLinkText(label: string, url: string): string {
  const cleanLabel = label.trim()
  const cleanUrl = stripLinkTitle(url).trim()
  const safeUrl = safeHref(cleanUrl)
  const text = escapeHtml(cleanLabel || cleanUrl)

  if (!safeUrl) {
    return cleanLabel ? `${text} (${escapeHtml(cleanUrl)})` : escapeHtml(cleanUrl)
  }

  return `<a href="${escapeAttribute(safeUrl)}">${text}</a>`
}

function safeHref(url: string): string | undefined {
  if (/^(https?:|mailto:)/i.test(url)) return url
  return undefined
}

function stripLinkTitle(url: string): string {
  return url.replace(/\s+["'][^"']+["']\s*$/, '')
}

function normalizeLines(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

function isFence(line: string): boolean {
  return /^\s*(```|~~~)/.test(line)
}

function normalizeCodeLanguage(value: string): string | undefined {
  const language = value.trim().split(/\s+/, 1)[0]
  return language || undefined
}

function plainIndent(indent: string): string {
  return indent.replace(/\t/g, '  ')
}

function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.slice(1, -1).includes('|')
}

function splitTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim())
}

function isTableSeparator(line: string): boolean {
  if (!looksLikeTableRow(line)) return false
  return splitTableCells(line).every(cell => /^:?-{3,}:?$/.test(cell))
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeAttribute(value: string): string {
  return escapeHtml(value)
}
