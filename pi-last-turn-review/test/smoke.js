const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const containerWithText = text => [...document.querySelectorAll('diffs-container')].find(c => c.shadowRoot && c.shadowRoot.textContent.includes(text))
const sidebarClick = async name => {
  ;[...document.querySelectorAll('#file-tree button')].find(b => b.textContent.includes(name)).click()
  await sleep(800)
}
const pointer = (target, type, x, y, extra = {}) =>
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, ...extra }))
const center = element => {
  const rect = element.getBoundingClientRect()
  return [rect.left + rect.width / 2, rect.top + rect.height / 2]
}
const cardTitle = textarea => textarea.parentElement.querySelector('div').textContent.trim().split(/\s+/).slice(0, -1).join(' ')
const emptyCard = () => [...document.querySelectorAll('.review-comment textarea')].find(t => t.value === '')
const fill = (textarea, text) => {
  textarea.value = text
  textarea.dispatchEvent(new Event('input'))
}
const commentOnLines = async (container, fromLine, toLine) => {
  const from = container.shadowRoot.querySelector(`[data-column-number="${fromLine}"]`)
  const to = container.shadowRoot.querySelector(`[data-column-number="${toLine}"]`)
  const [x, y] = center(from)
  pointer(from, 'pointerdown', x, y)
  await sleep(50)
  const [x2, y2] = center(to)
  pointer(document, 'pointermove', x2, y2)
  await sleep(50)
  pointer(document, 'pointerup', x2, y2)
  await sleep(300)
}

await sidebarClick('new.ts')
await commentOnLines(containerWithText('export const b'), 2, 3)
log('range card: ' + cardTitle(emptyCard()))
fill(emptyCard(), 'Range comment on new lines')

await sidebarClick('gone.ts')
const goneTs = containerWithText('export function gone')
await commentOnLines(goneTs, 2, 2)
log('old-side card: ' + cardTitle(emptyCard()))
fill(emptyCard(), 'Why remove this?')

goneTs.querySelector('[data-action="file-comment"]').click()
await sleep(300)
log('file card: ' + cardTitle(emptyCard()))
fill(emptyCard(), 'File level note')

await sidebarClick('app.js')
containerWithText('web/app.js').querySelector('[data-action="reviewed"]').click()
await sleep(300)
log('summary: ' + document.getElementById('summary').textContent)

document.getElementById('toggle-style-button').click()
await sleep(1000)
await sidebarClick('gone.ts')
const visible = [...document.querySelectorAll('.review-comment')].filter(c => c.getBoundingClientRect().height > 0)
log('visible cards after split toggle: ' + visible.length)

await sidebarClick('broken.zig')
log('error item: ' + (containerWithText('Failed to load: git show failed') != null))

document.getElementById('submit-button').click()
