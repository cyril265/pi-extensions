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

function createCommentElement(comment, blockEl) {
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
  container.querySelector("[data-action='delete']").addEventListener('click', () => {
    state.comments = state.comments.filter(item => item.id !== comment.id)
    if (!state.comments.some(item => item.line === comment.line)) {
      blockEl.classList.remove('has-comment')
    }
    container.remove()
    updateSummary()
  })
  return container
}

function addComment(blockEl, quote) {
  const line = Number(blockEl.dataset.lineStart)
  if (quote == null) {
    const existing = state.comments.find(comment => comment.line === line && comment.quote == null)
    if (existing) {
      blockEl.nextElementSibling?.querySelector('textarea')?.focus()
      return
    }
  }

  const comment = {
    id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
    line,
    endLine: Number(blockEl.dataset.lineEnd),
    quote,
    body: '',
  }
  state.comments.push(comment)
  const commentEl = createCommentElement(comment, blockEl)
  blockEl.classList.add('has-comment')
  let anchor = blockEl
  while (anchor.nextElementSibling?.classList.contains('annotate-comment')) {
    anchor = anchor.nextElementSibling
  }
  anchor.after(commentEl)
  updateSummary()
  setTimeout(() => commentEl.querySelector('textarea').focus(), 50)
}

const selectionButton = document.createElement('button')
selectionButton.className = 'selection-comment-button'
selectionButton.textContent = 'Comment'
selectionButton.hidden = true
document.body.appendChild(selectionButton)
let pendingSelection = null

function blockForSelection(selection) {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const node = selection.getRangeAt(0).commonAncestorContainer
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
  return element?.closest('.md-block') ?? null
}

document.addEventListener('mouseup', event => {
  if (event.target === selectionButton) return
  setTimeout(() => {
    const selection = window.getSelection()
    const blockEl = blockForSelection(selection)
    const quote = selection?.toString().trim()
    if (!blockEl || !quote) {
      selectionButton.hidden = true
      pendingSelection = null
      return
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    selectionButton.style.left = `${Math.max(8, Math.min(rect.right, window.innerWidth - 110))}px`
    selectionButton.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 40)}px`
    pendingSelection = { blockEl, quote }
    selectionButton.hidden = false
  })
})

selectionButton.addEventListener('mousedown', event => event.preventDefault())
selectionButton.addEventListener('click', () => {
  if (!pendingSelection) return
  const { blockEl, quote } = pendingSelection
  pendingSelection = null
  selectionButton.hidden = true
  window.getSelection()?.removeAllRanges()
  addComment(blockEl, quote)
})

document.addEventListener(
  'scroll',
  () => {
    selectionButton.hidden = true
  },
  true,
)

function groupTopLevelBlocks(tokens) {
  const blocks = []
  let index = 0
  while (index < tokens.length) {
    const start = index
    if (tokens[index].nesting === 1) {
      let depth = 0
      do {
        depth += tokens[index].nesting
        index++
      } while (depth > 0 && index < tokens.length)
    } else {
      index++
    }
    blocks.push(tokens.slice(start, index))
  }
  return blocks
}

function renderMarkdown() {
  if (!window.markdownit) throw new Error('markdown-it unavailable.')
  const md = window.markdownit({ linkify: true })
  const blocks = groupTopLevelBlocks(md.parse(annotateData.text || '', {}))

  for (const blockTokens of blocks) {
    const map = blockTokens[0].map
    if (!map) continue
    const wrapper = document.createElement('div')
    wrapper.className = 'md-block'
    wrapper.dataset.lineStart = String(map[0] + 1)
    wrapper.dataset.lineEnd = String(map[1])
    wrapper.innerHTML = md.renderer.render(blockTokens, md.options, {})

    const addButton = document.createElement('button')
    addButton.className = 'md-block-add'
    addButton.title = 'Add comment'
    addButton.textContent = '+'
    addButton.addEventListener('click', () => addComment(wrapper, null))
    wrapper.prepend(addButton)

    contentEl.appendChild(wrapper)
  }
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
      .map(comment => ({ ...comment, body: comment.body.trim() }))
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
