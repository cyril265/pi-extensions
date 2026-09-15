import assert from 'node:assert/strict'
import { open } from 'glimpseui'
import { buildAnnotateHtml } from '../src/ui.ts'
import type { ReviewTheme } from '../src/types.ts'

const theme: ReviewTheme = { appearance: 'dark', bg: '#0b1020', panel: '#111827', hover: '#1f2937', active: '#243044', badge: '#1e293b', border: '#263244', text: '#e5e7eb', strong: '#f8fafc', muted: '#9ca3af', dim: '#6b7280', accent: '#60a5fa', success: '#34d399', error: '#fb7185', warning: '#fbbf24', diffAdded: '#22c55e', diffRemoved: '#ef4444' }

const text = [
  '# Title',            // 1
  '',                   // 2
  'First paragraph',    // 3
  'continues here.',    // 4
  '',                   // 5
  '- item one',         // 6
  '- item two',         // 7
  '  - nested',         // 8
  '',                   // 9
  '```ts',              // 10
  'const a = 1',        // 11
  '',                   // 12
  'const b = 2',        // 13
  '```',                // 14
  '',                   // 15
  '| h1 | h2 |',        // 16
  '| -- | -- |',        // 17
  '| r1 | x  |',        // 18
  '| r2 | y  |',        // 19
  '',                   // 20
  '> quoted line',      // 21
  '',                   // 22
  'Last paragraph.',    // 23
  '',                   // 24
  '```',                // 25
  '```',                // 26
].join('\n')

const html = buildAnnotateHtml({ title: 'Annotate', sourceLabel: 'assistant', sourceHint: 'hint', theme, text })
const win = open(html, { width: 1200, height: 900, title: 'annotate smoke' })

const script = `(() => {
  const log = t => window.glimpse.send({ type: 'log', text: t })
  const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  const type = (textarea, value) => {
    textarea.value = value
    textarea.dispatchEvent(new Event('input'))
  }
  const content = document.getElementById('markdown-content')
  const anchors = [...content.querySelectorAll('.md-anchor')].map(a => a.tagName + ':' + a.dataset.lineStart + '-' + a.dataset.lineEnd)
  log('anchors ' + anchors.join(' '))
  log('empty fence has no lines: ' + (content.querySelectorAll('.md-code')[1].children.length === 0))

  const li = content.querySelectorAll('li')[1]
  click(li)
  click(li)
  log('second click focuses existing card instead of adding: ' + (li.querySelectorAll(':scope > .annotate-comment').length === 1))
  log('li card inside li: ' + (li.querySelector('.annotate-comment') != null))
  type(li.querySelector('.annotate-comment textarea'), 'li comment')

  const nested = content.querySelector('li li')
  click(nested)
  const nestedTextarea = nested.querySelector('.annotate-comment textarea')
  nestedTextarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  log('escape removes empty card: ' + (nested.querySelector('.annotate-comment') == null && !nested.classList.contains('has-comment')))

  const codeLine = content.querySelectorAll('.md-line')[2]
  click(codeLine)
  log('code card after line: ' + codeLine.nextElementSibling.classList.contains('annotate-comment'))
  type(codeLine.nextElementSibling.querySelector('textarea'), 'code comment')

  const tr = content.querySelectorAll('tbody tr')[1]
  click(tr.firstElementChild)
  log('row card in table row: ' + tr.nextElementSibling.classList.contains('annotate-comment-row'))
  type(tr.nextElementSibling.querySelector('textarea'), 'row comment')

  const p1 = content.querySelector('p')
  const p2 = content.querySelector('blockquote p')
  const range = document.createRange()
  range.setStart(p1.firstChild, 6)
  range.setEnd(p2.firstChild, 6)
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  setTimeout(() => {
    const button = document.querySelector('.selection-comment-button')
    log('selection button visible: ' + !button.hidden)
    button.click()
    log('span card in blockquote: ' + (p2.parentElement.querySelector('.annotate-comment') != null))
    type(p2.parentElement.querySelector('.annotate-comment textarea'), 'span comment')

    const r2 = document.createRange()
    r2.setStart(p2.firstChild, 0)
    r2.setEnd(p2.firstChild, 6)
    selection.removeAllRanges()
    selection.addRange(r2)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    setTimeout(() => {
      button.click()
      type(p2.parentElement.querySelectorAll('.annotate-comment textarea')[1], 'quote comment')
      document.querySelector('#submit-button').click()
    }, 50)

  }, 50)
})()`

const logs: string[] = []
win.on('message', (message: any) => {
  if (message.type === 'log') {
    logs.push(message.text)
    console.log(message.text)
    return
  }
  if (message.type !== 'submit') return
  console.log(JSON.stringify(message, null, 2))
  assert.equal(logs.filter(line => line.endsWith(': false')).length, 0)
  const byBody = Object.fromEntries(message.comments.map((c: any) => [c.body, c]))
  assert.deepEqual([byBody['li comment'].line, byBody['li comment'].endLine], [7, 9])
  assert.deepEqual([byBody['code comment'].line, byBody['code comment'].endLine], [13, 13])
  assert.deepEqual([byBody['row comment'].line, byBody['row comment'].endLine], [19, 19])
  assert.deepEqual([byBody['span comment'].line, byBody['span comment'].endLine, byBody['span comment'].quote], [3, 21, null])
  assert.deepEqual([byBody['quote comment'].line, byBody['quote comment'].endLine, byBody['quote comment'].quote], [21, 21, 'quoted'])
  for (const c of message.comments) assert.equal('anchor' in c || 'textarea' in c, false)
  console.log('OK')
  process.exit(0)
})

setTimeout(() => win.send(script), 2000)
setTimeout(() => {
  console.error('timeout')
  process.exit(1)
}, 15000)
