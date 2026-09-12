const annotateData = JSON.parse(document.getElementById('annotate-data').textContent || '{}')

const defaultTheme = {
  appearance: 'dark',
  bg: '#0b1020',
  panel: '#111827',
  hover: '#1f2937',
  border: '#263244',
  text: '#e5e7eb',
  strong: '#f8fafc',
  muted: '#9ca3af',
  dim: '#64748b',
  accent: '#60a5fa',
  success: '#34d399',
  error: '#fb7185',
}
const theme = { ...defaultTheme, ...(annotateData.theme || {}) }

for (const [key, value] of Object.entries({
  bg: theme.bg,
  panel: theme.panel,
  hover: theme.hover,
  border: theme.border,
  text: theme.text,
  strong: theme.strong,
  muted: theme.muted,
  accent: theme.accent,
  success: theme.success,
  error: theme.error,
})) {
  document.documentElement.style.setProperty(`--color-review-${key}`, value)
}
document.documentElement.style.colorScheme = theme.appearance

const state = {
  overallComment: '',
  comments: [],
}

const windowTitleEl = document.getElementById('window-title')
const sourceHintEl = document.getElementById('source-hint')
const summaryEl = document.getElementById('summary')
const contentEl = document.getElementById('markdown-content')
const overallCommentButton = document.getElementById('overall-comment-button')
const copyButton = document.getElementById('copy-button')
const cancelButton = document.getElementById('cancel-button')
const submitButton = document.getElementById('submit-button')

windowTitleEl.textContent = annotateData.title || 'Annotate turn'
sourceHintEl.textContent = annotateData.sourceHint || 'Annotate the latest assistant response.'

function escapeHtml(value) {
  return String(value).replace(
    /[&<>'"]/g,
    char =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;',
      })[char],
  )
}

function hasSubmittableFeedback() {
  return (
    state.overallComment.trim().length > 0 ||
    state.comments.some(comment => comment.body.trim().length > 0)
  )
}

function textToCopy() {
  return window.getSelection()?.toString() || annotateData.text || ''
}

async function copyText(text) {
  if (!text) return

  if (window.glimpse?.send) {
    window.glimpse.send({ type: 'copy-text', text })
    return
  }

  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
}

function updateSummary() {
  const filledComments = state.comments.filter(comment => comment.body.trim().length > 0).length
  const drafts = state.comments.length - filledComments
  summaryEl.textContent = `${filledComments} comment(s)${drafts > 0 ? ` • ${drafts} draft(s)` : ''}${state.overallComment ? ' • overall note' : ''}`
  submitButton.disabled = !hasSubmittableFeedback()
}

function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function createCommentElement(comment) {
  const container = document.createElement('div')
  container.className = 'annotate-comment'
  const lineLabel = comment.quote
    ? `“${escapeHtml(truncate(comment.quote, 80))}”`
    : comment.endLine > comment.line
      ? `Lines ${comment.line}–${comment.endLine}`
      : `Line ${comment.line}`
  container.innerHTML = `
    <div class="mb-2 flex items-center justify-between gap-3">
      <div class="min-w-0 truncate text-xs font-semibold text-review-text">${lineLabel} • ${escapeHtml(annotateData.sourceLabel || 'latest response')}</div>
      <button data-action="delete" class="cursor-pointer rounded-md border border-transparent bg-transparent px-2 py-1 text-xs font-medium text-review-muted hover:bg-review-error/10 hover:text-review-error">Delete</button>
    </div>
    <textarea rows="2" class="min-h-[44px] w-full resize-y rounded-md border border-review-border bg-review-bg px-3 py-1.5 text-sm text-review-text outline-none focus:border-review-accent focus:ring-1 focus:ring-review-accent" placeholder="Leave a comment"></textarea>
  `
  const textarea = container.querySelector('textarea')
  textarea.addEventListener('input', () => {
    comment.body = textarea.value
    updateSummary()
  })
  textarea.addEventListener('keydown', event => {
    if (event.key === 'Escape' && textarea.value.trim() === '') deleteButton.click()
  })
  const deleteButton = container.querySelector("[data-action='delete']")
  deleteButton.addEventListener('click', () => {
    state.comments = state.comments.filter(item => item.id !== comment.id)
    if (!state.comments.some(item => item.anchor === comment.anchor)) {
      comment.anchor.classList.remove('has-comment')
    }
    container.closest('.annotate-comment-row')?.remove()
    container.remove()
    updateSummary()
  })
  return container
}

function placeCard(anchor, card) {
  if (anchor.tagName === 'LI') {
    anchor.append(card)
    return
  }
  let after = anchor
  if (anchor.tagName === 'TR') {
    const row = document.createElement('tr')
    row.className = 'annotate-comment-row'
    const cell = document.createElement('td')
    cell.colSpan = anchor.children.length
    cell.append(card)
    row.append(cell)
    card = row
    while (after.nextElementSibling?.classList.contains('annotate-comment-row')) after = after.nextElementSibling
  } else {
    while (after.nextElementSibling?.classList.contains('annotate-comment')) after = after.nextElementSibling
  }
  after.after(card)
}

function addComment(anchor, line, endLine, quote) {
  if (quote == null) {
    const existing = state.comments.find(
      comment => comment.quote == null && comment.line === line && comment.endLine === endLine,
    )
    if (existing) {
      existing.textarea.focus()
      return
    }
  }

  const comment = {
    id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
    line,
    endLine,
    quote,
    body: '',
    anchor,
  }
  state.comments.push(comment)
  const card = createCommentElement(comment)
  comment.textarea = card.querySelector('textarea')
  anchor.classList.add('has-comment')
  placeCard(anchor, card)
  updateSummary()
  setTimeout(() => comment.textarea.focus(), 50)
}

function anchorRange(anchor) {
  return { line: Number(anchor.dataset.lineStart), endLine: Number(anchor.dataset.lineEnd) }
}

let hoveredAnchor = null

contentEl.addEventListener('mouseover', event => {
  if (event.target.closest('.annotate-comment')) return
  const anchor = event.target.closest('.md-anchor')
  if (!anchor) return
  hoveredAnchor?.classList.remove('is-hover')
  hoveredAnchor = anchor
  anchor.classList.add('is-hover')
})

contentEl.addEventListener('mouseleave', () => {
  hoveredAnchor?.classList.remove('is-hover')
  hoveredAnchor = null
})

contentEl.addEventListener('click', event => {
  if (event.target.closest('.annotate-comment, a')) return
  if (!window.getSelection().isCollapsed) return
  const anchor = event.target.closest('.md-anchor')
  if (!anchor) return
  const { line, endLine } = anchorRange(anchor)
  addComment(anchor, line, endLine, null)
})

const selectionButton = document.createElement('button')
selectionButton.className = 'selection-comment-button'
selectionButton.textContent = 'Comment'
selectionButton.hidden = true
document.body.appendChild(selectionButton)
let pendingSelection = null

function anchorForNode(node) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
  if (element?.closest('.annotate-comment')) return null
  return element?.closest('.md-anchor') ?? null
}

function selectionTarget(selection) {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const start = anchorForNode(range.startContainer)
  const end = anchorForNode(range.endContainer)
  if (!start || !end) return null
  const text = selection.toString().trim()
  if (!text) return null
  return {
    anchor: end,
    line: anchorRange(start).line,
    endLine: anchorRange(end).endLine,
    quote: start === end ? text : null,
  }
}

document.addEventListener('mouseup', event => {
  if (event.target === selectionButton) return
  setTimeout(() => {
    const selection = window.getSelection()
    const target = selectionTarget(selection)
    if (!target) {
      selectionButton.hidden = true
      pendingSelection = null
      return
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    selectionButton.style.left = `${Math.max(8, Math.min(rect.right, window.innerWidth - 110))}px`
    selectionButton.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 40)}px`
    pendingSelection = target
    selectionButton.hidden = false
  })
})

selectionButton.addEventListener('mousedown', event => event.preventDefault())
selectionButton.addEventListener('click', () => {
  if (!pendingSelection) return
  const { anchor, line, endLine, quote } = pendingSelection
  pendingSelection = null
  selectionButton.hidden = true
  window.getSelection()?.removeAllRanges()
  addComment(anchor, line, endLine, quote)
})

document.addEventListener(
  'scroll',
  () => {
    selectionButton.hidden = true
  },
  true,
)

const ANCHOR_TOKENS = new Set(['heading_open', 'paragraph_open', 'list_item_open', 'tr_open', 'hr'])

function markAnchors(mdState) {
  for (const token of mdState.tokens) {
    if (!token.map || !ANCHOR_TOKENS.has(token.type)) continue
    token.attrJoin('class', 'md-anchor')
    token.attrSet('data-line-start', String(token.map[0] + 1))
    token.attrSet('data-line-end', String(token.map[1]))
  }
}

function renderCodeLines(token, firstLine) {
  const lines = token.content === '' ? [] : token.content.replace(/\n$/, '').split('\n')
  const html = lines
    .map((text, index) => {
      const line = firstLine + index
      return `<div class="md-line md-anchor" data-line-start="${line}" data-line-end="${line}">${escapeHtml(text)}</div>`
    })
    .join('')
  return `<div class="md-code">${html}</div>`
}

function renderMarkdown() {
  const md = window.markdownit.default({ linkify: true })
  md.core.ruler.push('anchors', markAnchors)
  md.renderer.rules.fence = (tokens, index) => renderCodeLines(tokens[index], tokens[index].map[0] + 2)
  md.renderer.rules.code_block = (tokens, index) => renderCodeLines(tokens[index], tokens[index].map[0] + 1)
  contentEl.insertAdjacentHTML('afterbegin', md.render(annotateData.text || ''))
}

function showTextModal(options) {
  const backdrop = document.createElement('div')
  backdrop.className = 'review-modal-backdrop'
  backdrop.innerHTML = `
    <div class="review-modal-card">
      <div class="mb-2 text-base font-semibold text-review-strong">${escapeHtml(options.title)}</div>
      <div class="mb-4 text-sm text-review-muted">${escapeHtml(options.description)}</div>
      <textarea id="annotate-modal-text" class="min-h-48 w-full resize-y rounded-md border border-review-border bg-review-bg px-3 py-2 text-sm text-review-text outline-none focus:border-review-accent focus:ring-1 focus:ring-review-accent">${escapeHtml(options.initialValue || '')}</textarea>
      <div class="mt-4 flex justify-end gap-2">
        <button id="annotate-modal-cancel" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-4 py-2 text-sm font-medium text-review-text hover:opacity-90">Cancel</button>
        <button id="annotate-modal-save" class="cursor-pointer rounded-md border border-review-border bg-review-success px-4 py-2 text-sm font-medium text-white hover:opacity-90">${escapeHtml(options.saveLabel || 'Save')}</button>
      </div>
    </div>
  `
  document.body.appendChild(backdrop)
  const textarea = backdrop.querySelector('#annotate-modal-text')
  const close = () => backdrop.remove()
  backdrop.querySelector('#annotate-modal-cancel').addEventListener('click', close)
  backdrop.querySelector('#annotate-modal-save').addEventListener('click', () => {
    options.onSave(textarea.value.trim())
    close()
  })
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) close()
  })
  textarea.focus()
}

function failRenderer(message) {
  document.body.innerHTML = `<div class="p-6 text-sm text-review-error">${escapeHtml(message)}</div>`
  window.glimpse?.send({ type: 'renderer-error', message })
}

submitButton.addEventListener('click', () => {
  if (!hasSubmittableFeedback()) return

  window.glimpse.send({
    type: 'submit',
    overallComment: state.overallComment.trim(),
    comments: state.comments
      .map(({ anchor, textarea, ...comment }) => ({ ...comment, body: comment.body.trim() }))
      .filter(comment => comment.body.length > 0),
  })
  window.glimpse.close()
})

cancelButton.addEventListener('click', () => {
  window.glimpse.send({ type: 'cancel' })
  window.glimpse.close()
})

copyButton.addEventListener('click', () => {
  void copyText(textToCopy())
})

overallCommentButton.addEventListener('click', () => {
  showTextModal({
    title: 'Overall annotation note',
    description: 'This note is prepended to the generated prompt above the line comments.',
    initialValue: state.overallComment,
    saveLabel: 'Save note',
    onSave: value => {
      state.overallComment = value
      updateSummary()
    },
  })
})

try {
  renderMarkdown()
  updateSummary()
} catch (error) {
  failRenderer(error?.message || String(error))
}
