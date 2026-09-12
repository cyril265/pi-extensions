const { CodeView, parseDiffFromFile, getOrCreateWorkerPoolSingleton } = window.PierreDiffs

const workerSource = new Blob([document.getElementById('diffs-worker-source').textContent], { type: 'text/javascript' })
const workerPool = getOrCreateWorkerPoolSingleton({
  poolOptions: { workerFactory: () => new Worker(URL.createObjectURL(workerSource)) },
  highlighterOptions: { preferredHighlighter: 'shiki-wasm' },
})

const reviewData = JSON.parse(document.getElementById('diff-review-data').textContent)
const reviewTheme = reviewData.theme

const root = document.documentElement
root.style.colorScheme = reviewTheme.appearance
for (const [key, value] of Object.entries(reviewTheme)) {
  if (key === 'appearance') continue
  const cssName = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
  root.style.setProperty(`--color-review-${cssName}`, value)
}

const state = {
  comments: [],
  overallComment: '',
  collapsedDirs: {},
  reviewedFiles: {},
  collapsedFiles: {},
  sidebarCollapsed: false,
  fileFilter: '',
  fileDiffs: {},
  fileErrors: {},
  versions: {},
  activeFileId: reviewData.files[0].id,
}

const el = id => document.getElementById(id)
const sidebarEl = el('sidebar')
const sidebarSearchInputEl = el('sidebar-search-input')
const toggleSidebarButton = el('toggle-sidebar-button')
const fileTreeEl = el('file-tree')
const summaryEl = el('summary')
const codeViewEl = el('code-view')
const submitButton = el('submit-button')
const toggleStyleButton = el('toggle-style-button')
const toggleWrapButton = el('toggle-wrap-button')
const toggleUnchangedButton = el('toggle-unchanged-button')
const undoButton = el('undo-button')

el('repo-root').textContent = reviewData.repoRoot
el('window-title').textContent = reviewData.title
el('sidebar-title').textContent = reviewData.scopeLabel
el('mode-hint').textContent = reviewData.scopeHint
undoButton.classList.toggle('hidden', reviewData.mode !== 'last-turn')

const fileById = new Map(reviewData.files.map(file => [file.id, file]))

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function newId() {
  return `${Date.now()}:${Math.random().toString(16).slice(2)}`
}

function commentsForFile(fileId) {
  return state.comments.filter(comment => comment.fileId === fileId)
}

function fileSide(file) {
  return file.comparison.hasModified ? 'modified' : 'original'
}

function toCommentSide(annotationSide, file) {
  if (annotationSide === 'deletions') return 'original'
  if (annotationSide === 'additions') return 'modified'
  return fileSide(file)
}

function toAnnotationSide(comment) {
  const side = comment.side === 'file' ? fileSide(fileById.get(comment.fileId)) : comment.side
  return side === 'original' ? 'deletions' : 'additions'
}

function formatCommentTitle(comment) {
  if (comment.side === 'file') return 'File comment'
  const range =
    comment.endLine !== comment.startLine
      ? `L${comment.startLine}-L${comment.endLine}`
      : `L${comment.startLine}`
  return `${comment.side === 'original' ? 'Old' : 'New'} ${range}`
}

function removeComment(commentId) {
  const comment = state.comments.find(item => item.id === commentId)
  state.comments = state.comments.filter(item => item.id !== commentId)
  refreshItem(comment.fileId)
  renderTree()
}

function addComment(comment) {
  state.comments.push(comment)
  refreshItem(comment.fileId)
  renderTree()
}

function renderComment(comment) {
  const container = document.createElement('div')
  container.className = 'review-comment'
  container.innerHTML = `
    <div class="mb-2 flex items-center justify-between gap-3">
      <div class="text-xs font-semibold text-review-text">${escapeHtml(formatCommentTitle(comment))}</div>
      <button data-action="delete" class="cursor-pointer rounded-md border border-transparent px-2 py-1 text-xs font-medium text-review-muted hover:bg-review-error/10 hover:text-review-error">Delete</button>
    </div>
    <textarea class="scrollbar-thin min-h-[76px] w-full resize-y rounded-md border border-review-border bg-review-bg px-3 py-2 text-sm text-review-text outline-none focus:border-review-accent focus:ring-1 focus:ring-review-accent" placeholder="Leave a comment"></textarea>
  `
  const textarea = container.querySelector('textarea')
  textarea.value = comment.body
  textarea.addEventListener('input', () => {
    comment.body = textarea.value
  })
  textarea.addEventListener('keydown', event => {
    if (event.key === 'Escape' && textarea.value.trim() === '') removeComment(comment.id)
  })
  container.querySelector('[data-action="delete"]').addEventListener('click', () => {
    removeComment(comment.id)
  })
  if (comment.body === '') requestAnimationFrame(() => textarea.focus())
  return container
}

function renderHeaderActions(_fileDiff, context) {
  const fileId = context.item.id
  const reviewed = state.reviewedFiles[fileId] === true
  const collapsed = state.collapsedFiles[fileId] === true
  const container = document.createElement('div')
  container.className = 'flex items-center gap-2 font-sans'
  container.innerHTML = `
    <button data-action="file-comment" class="cursor-pointer rounded border border-review-border bg-review-panel px-2 py-0.5 text-[11px] font-medium text-review-text hover:bg-review-hover">File comment</button>
    <button data-action="reviewed" class="cursor-pointer rounded border px-2 py-0.5 text-[11px] font-medium ${reviewed ? 'border-review-success/40 bg-review-success/15 text-review-success' : 'border-review-border bg-review-panel text-review-text hover:bg-review-hover'}">${reviewed ? 'Reviewed' : 'Mark reviewed'}</button>
    <button data-action="collapse" class="cursor-pointer rounded border border-review-border bg-review-panel px-2 py-0.5 text-[11px] font-medium text-review-text hover:bg-review-hover">${collapsed ? 'Expand' : 'Collapse'}</button>
  `
  container.querySelector('[data-action="file-comment"]').addEventListener('click', () => {
    addComment({
      id: newId(),
      fileId,
      scope: 'review',
      side: 'file',
      startLine: null,
      endLine: null,
      body: '',
    })
  })
  container.querySelector('[data-action="reviewed"]').addEventListener('click', () => {
    const next = !reviewed
    state.reviewedFiles[fileId] = next
    state.collapsedFiles[fileId] = next
    refreshItem(fileId)
    renderTree()
  })
  container.querySelector('[data-action="collapse"]').addEventListener('click', () => {
    state.collapsedFiles[fileId] = !collapsed
    refreshItem(fileId)
  })
  return container
}

const viewOptions = {
  theme: { light: 'pierre-light', dark: 'pierre-dark' },
  themeType: reviewTheme.appearance,
  preferredHighlighter: 'shiki-wasm',
  diffStyle: 'unified',
  overflow: 'wrap',
  expandUnchanged: false,
  stickyHeaders: true,
  enableLineSelection: true,
  renderAnnotation: annotation => renderComment(annotation.metadata),
  renderHeaderMetadata: renderHeaderActions,
  onLineSelectionEnd(range, context) {
    if (range == null) return
    const file = fileById.get(context.item.id)
    addComment({
      id: newId(),
      fileId: file.id,
      scope: 'review',
      side: toCommentSide(range.side, file),
      startLine: Math.min(range.start, range.end),
      endLine: Math.max(range.start, range.end),
      body: '',
    })
    codeView.clearSelectedLines()
  },
}
const codeView = new CodeView(viewOptions, workerPool)
codeView.setup(codeViewEl)

function isLoaded(file) {
  return state.fileDiffs[file.id] != null || state.fileErrors[file.id] != null
}

function buildItem(fileId) {
  const version = state.versions[fileId] ?? 0
  const error = state.fileErrors[fileId]
  if (error != null) {
    return { id: fileId, type: 'file', version, file: { name: fileById.get(fileId).path, contents: `Failed to load: ${error}` } }
  }
  return {
    id: fileId,
    type: 'diff',
    fileDiff: state.fileDiffs[fileId],
    version,
    collapsed: state.collapsedFiles[fileId] === true,
    annotations: commentsForFile(fileId).map(comment => ({
      side: toAnnotationSide(comment),
      lineNumber: comment.side === 'file' ? 0 : comment.endLine,
      metadata: comment,
    })),
  }
}

function refreshItem(fileId) {
  state.versions[fileId] = (state.versions[fileId] ?? 0) + 1
  codeView.updateItem(buildItem(fileId))
}

function syncItems() {
  codeView.setItems(reviewData.files.filter(isLoaded).map(file => buildItem(file.id)))
}

function requestAllFiles() {
  for (const file of reviewData.files) {
    window.glimpse.send({ type: 'request-file', requestId: newId(), fileId: file.id, scope: 'review' })
  }
}

window.__reviewReceive = message => {
  const file = fileById.get(message.fileId)
  if (message.type === 'file-data') {
    const { comparison } = file
    const oldFile = comparison.hasOriginal
      ? { name: comparison.oldPath, contents: message.originalContent }
      : null
    const newFile = comparison.hasModified
      ? { name: comparison.newPath, contents: message.modifiedContent }
      : null
    state.fileDiffs[file.id] = parseDiffFromFile(oldFile, newFile)
    syncItems()
  }
  if (message.type === 'file-error') {
    state.fileErrors[file.id] = message.message
    syncItems()
  }
  renderTree()
}

function scrollToFile(fileId) {
  state.activeFileId = fileId
  codeView.scrollTo({ type: 'item', id: fileId, align: 'start' })
  renderTree()
}

codeView.subscribeToScroll(scrollTop => {
  const threshold = scrollTop + codeViewEl.clientHeight / 3
  const loaded = reviewData.files.filter(isLoaded)
  let active = loaded[0]
  for (const file of loaded) {
    if (codeView.getTopForItem(file.id) <= threshold) active = file
  }
  if (active != null && active.id !== state.activeFileId) {
    state.activeFileId = active.id
    renderTree()
  }
})

function statusBadgeClass(status) {
  switch (status) {
    case 'added':
      return 'text-review-success'
    case 'deleted':
      return 'text-review-error'
    case 'renamed':
      return 'text-review-warning'
    default:
      return 'text-review-accent'
  }
}

function getBaseName(path) {
  return path.slice(path.lastIndexOf('/') + 1)
}

function normalizeQuery(query) {
  return query.trim().toLowerCase().replace(/\s+/g, '')
}

function scoreSubsequence(query, candidate) {
  let queryIndex = 0
  let score = 0
  let firstMatchIndex = -1
  let previousMatchIndex = -2

  for (let i = 0; i < candidate.length && queryIndex < query.length; i += 1) {
    if (candidate[i] !== query[queryIndex]) continue
    if (firstMatchIndex === -1) firstMatchIndex = i
    score += 10
    if (i === previousMatchIndex + 1) score += 8
    const previousChar = i > 0 ? candidate[i - 1] : ''
    if (i === 0 || '/_-.'.includes(previousChar)) score += 12
    previousMatchIndex = i
    queryIndex += 1
  }

  if (queryIndex !== query.length) return -1
  return score + Math.max(0, 20 - firstMatchIndex)
}

function getFileSearchScore(query, file) {
  const path = file.path.toLowerCase()
  const baseName = getBaseName(path)
  const pathScore = scoreSubsequence(query, path)
  const baseScore = scoreSubsequence(query, baseName)
  let score = Math.max(pathScore, baseScore >= 0 ? baseScore + 40 : -1)
  if (score < 0) return -1
  if (baseName === query) score += 200
  else if (baseName.startsWith(query)) score += 120
  else if (path.includes(query)) score += 35
  return score
}

function getFilteredFiles() {
  const query = normalizeQuery(state.fileFilter)
  if (query === '') return reviewData.files
  return reviewData.files
    .map(file => ({ file, score: getFileSearchScore(query, file) }))
    .filter(entry => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
    .map(entry => entry.file)
}

function buildTree(files) {
  const rootNode = { children: new Map() }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = rootNode
    let currentPath = ''
    parts.forEach((part, index) => {
      const isLeaf = index === parts.length - 1
      currentPath = currentPath ? `${currentPath}/${part}` : part
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          path: currentPath,
          kind: isLeaf ? 'file' : 'dir',
          children: new Map(),
          file: isLeaf ? file : null,
        })
      }
      node = node.children.get(part)
    })
  }
  return rootNode
}

function fileMarker(file) {
  if (state.reviewedFiles[file.id]) return '<span class="shrink-0 text-[10px] text-review-success">●</span>'
  if (state.fileErrors[file.id]) return '<span class="shrink-0 text-[10px] text-review-error">!</span>'
  if (!isLoaded(file)) return '<span class="shrink-0 text-[10px] text-review-accent">…</span>'
  return '<span class="shrink-0 text-[10px] text-transparent">●</span>'
}

function fileBadges(file) {
  const count = commentsForFile(file.id).length
  const status = file.comparison.status
  return `
    <span class="flex shrink-0 items-center gap-1.5">
      ${count > 0 ? `<span class="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-review-badge px-1 text-[10px] font-medium text-review-text">${count}</span>` : ''}
      <span class="font-medium ${statusBadgeClass(status)}">${status.charAt(0).toUpperCase()}</span>
    </span>
  `
}

function fileRowClass(file, extra) {
  const active = file.id === state.activeFileId
  return [
    'group flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[13px]',
    active ? 'bg-review-active text-review-strong' : 'text-review-text hover:bg-review-hover',
    extra,
  ].join(' ')
}

function renderTreeNode(node, depth) {
  const children = [...node.children.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  for (const child of children) {
    const row = document.createElement('button')
    row.type = 'button'

    if (child.kind === 'dir') {
      const collapsed = state.collapsedDirs[child.path] === true
      row.className =
        'group flex w-full items-center gap-1.5 px-2 py-1 text-left text-[13px] text-review-text hover:bg-review-hover'
      row.style.paddingLeft = `${depth * 12 + 8}px`
      row.innerHTML = `
        <svg class="h-4 w-4 shrink-0 text-review-muted transition-transform ${collapsed ? '-rotate-90' : ''}" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12.78 6.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 7.28a.749.749 0 0 1 1.06-1.06L8 9.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"></path>
        </svg>
        <span class="truncate">${escapeHtml(child.name)}</span>
      `
      row.addEventListener('click', () => {
        state.collapsedDirs[child.path] = !collapsed
        renderTree()
      })
      fileTreeEl.appendChild(row)
      if (!collapsed) renderTreeNode(child, depth + 1)
      continue
    }

    const file = child.file
    row.className = fileRowClass(file, '')
    row.style.paddingLeft = `${depth * 12 + 26}px`
    row.innerHTML = `
      <span class="flex min-w-0 items-center gap-1.5 truncate">
        ${fileMarker(file)}
        <span class="truncate">${escapeHtml(child.name)}</span>
      </span>
      ${fileBadges(file)}
    `
    row.addEventListener('click', () => scrollToFile(file.id))
    fileTreeEl.appendChild(row)
  }
}

function renderSearchResults(files) {
  for (const file of files) {
    const parentPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
    const row = document.createElement('button')
    row.type = 'button'
    row.className = fileRowClass(file, 'rounded-md py-2')
    row.innerHTML = `
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-1.5">
          ${fileMarker(file)}
          <span class="truncate">${escapeHtml(getBaseName(file.path))}</span>
        </span>
        <span class="mt-0.5 block truncate pl-[14px] text-[11px] text-review-muted">${escapeHtml(parentPath)}</span>
      </span>
      ${fileBadges(file)}
    `
    row.addEventListener('click', () => scrollToFile(file.id))
    fileTreeEl.appendChild(row)
  }
}

function renderTree() {
  fileTreeEl.innerHTML = ''
  const visibleFiles = getFilteredFiles()

  if (visibleFiles.length === 0) {
    fileTreeEl.innerHTML = `<div class="px-3 py-4 text-sm text-review-muted">No files match <span class="text-review-text">${escapeHtml(state.fileFilter.trim())}</span>.</div>`
  } else if (state.fileFilter.trim() !== '') {
    renderSearchResults(visibleFiles)
  } else {
    renderTreeNode(buildTree(visibleFiles), 0)
  }

  const reviewedCount = reviewData.files.filter(file => state.reviewedFiles[file.id]).length
  summaryEl.textContent = [
    `${reviewedCount}/${reviewData.files.length} reviewed`,
    `${state.comments.length} comment(s)`,
    state.overallComment !== '' ? 'overall note' : null,
  ]
    .filter(Boolean)
    .join(' • ')
}

function updateToolbar() {
  toggleStyleButton.textContent = viewOptions.diffStyle === 'split' ? 'Unified view' : 'Split view'
  toggleWrapButton.textContent = `Wrap: ${viewOptions.overflow === 'wrap' ? 'on' : 'off'}`
  toggleUnchangedButton.textContent = viewOptions.expandUnchanged ? 'Show changes only' : 'Show full files'
  toggleSidebarButton.textContent = state.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'
  const width = state.sidebarCollapsed ? '0px' : '280px'
  sidebarEl.style.width = width
  sidebarEl.style.minWidth = width
  sidebarEl.style.flexBasis = width
  sidebarEl.style.borderRightWidth = state.sidebarCollapsed ? '0px' : '1px'
}

function applyViewOptions() {
  codeView.setOptions({ ...viewOptions })
  updateToolbar()
}

function showOverallCommentModal() {
  const backdrop = document.createElement('div')
  backdrop.className = 'review-modal-backdrop'
  backdrop.innerHTML = `
    <div class="review-modal-card">
      <div class="mb-2 text-base font-semibold text-review-strong">Overall review note</div>
      <div class="mb-4 text-sm text-review-muted">This note goes above the inline comments in the generated prompt.</div>
      <textarea class="scrollbar-thin min-h-48 w-full resize-y rounded-md border border-review-border bg-review-bg px-3 py-2 text-sm text-review-text outline-none focus:border-review-accent focus:ring-1 focus:ring-review-accent"></textarea>
      <div class="mt-4 flex justify-end gap-2">
        <button data-action="cancel" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-4 py-2 text-sm font-medium text-review-text hover:opacity-90">Cancel</button>
        <button data-action="save" class="cursor-pointer rounded-md border border-review-border bg-review-success px-4 py-2 text-sm font-medium text-white hover:opacity-90">Save note</button>
      </div>
    </div>
  `
  document.body.appendChild(backdrop)
  const textarea = backdrop.querySelector('textarea')
  textarea.value = state.overallComment
  const close = () => backdrop.remove()
  backdrop.querySelector('[data-action="cancel"]').addEventListener('click', close)
  backdrop.querySelector('[data-action="save"]').addEventListener('click', () => {
    state.overallComment = textarea.value.trim()
    renderTree()
    close()
  })
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) close()
  })
  textarea.focus()
}

function submitReview() {
  window.glimpse.send({
    type: 'submit',
    overallComment: state.overallComment,
    comments: state.comments
      .map(comment => ({ ...comment, body: comment.body.trim() }))
      .filter(comment => comment.body !== ''),
  })
  window.glimpse.close()
}

function moveActiveFile(delta) {
  const files = getFilteredFiles()
  const index = files.findIndex(file => file.id === state.activeFileId)
  const next = files[Math.min(files.length - 1, Math.max(0, index + delta))]
  if (next != null) scrollToFile(next.id)
}

submitButton.addEventListener('click', submitReview)
el('cancel-button').addEventListener('click', () => {
  window.glimpse.send({ type: 'cancel' })
  window.glimpse.close()
})
undoButton.addEventListener('click', () => {
  window.glimpse.send({ type: 'undo' })
  window.glimpse.close()
})
el('overall-comment-button').addEventListener('click', showOverallCommentModal)
toggleStyleButton.addEventListener('click', () => {
  viewOptions.diffStyle = viewOptions.diffStyle === 'split' ? 'unified' : 'split'
  applyViewOptions()
})
toggleWrapButton.addEventListener('click', () => {
  viewOptions.overflow = viewOptions.overflow === 'wrap' ? 'scroll' : 'wrap'
  applyViewOptions()
})
toggleUnchangedButton.addEventListener('click', () => {
  viewOptions.expandUnchanged = !viewOptions.expandUnchanged
  applyViewOptions()
})
toggleSidebarButton.addEventListener('click', () => {
  state.sidebarCollapsed = !state.sidebarCollapsed
  updateToolbar()
})
sidebarSearchInputEl.addEventListener('input', () => {
  state.fileFilter = sidebarSearchInputEl.value
  renderTree()
})
sidebarSearchInputEl.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    sidebarSearchInputEl.value = ''
    state.fileFilter = ''
    renderTree()
  }
})

document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    submitReview()
    return
  }
  const tag = event.target.tagName
  if (tag === 'TEXTAREA' || tag === 'INPUT') return
  if (event.key === 'j') moveActiveFile(1)
  if (event.key === 'k') moveActiveFile(-1)
})

updateToolbar()
renderTree()
requestAllFiles()
