import { open } from 'glimpseui'
import { buildAnnotateHtml } from '/Users/kpovolotskyy/ai-stuff/pi-extensions/pi-last-turn-review/src/ui.ts'
const theme = { appearance: 'dark', bg: '#0b1020', panel: '#111827', hover: '#1f2937', active: '#243044', badge: '#1e293b', border: '#263244', text: '#e5e7eb', strong: '#f8fafc', muted: '#9ca3af', dim: '#6b7280', accent: '#60a5fa', success: '#34d399', error: '#fb7185', warning: '#fbbf24', diffAdded: '#22c55e', diffRemoved: '#ef4444' }
const html = buildAnnotateHtml({ title: 'Annotate', sourceLabel: 'assistant', sourceHint: 'hint', theme, text: '# Heading\n\nSome **bold** text and a list:\n\n- one\n- two\n\n```ts\nconst x = 1\n```\n' })
const win = open(html, { width: 1200, height: 800, title: 'annotate harness' })
win.on('message', (m: any) => { console.log(JSON.stringify(m).slice(0, 300)); if (m.type === 'cancel') process.exit(0) })
setTimeout(() => win.send(`(() => { const log = t => window.glimpse.send({ type: 'log', text: t }); log('typeof markdownit: ' + typeof window.markdownit + ' default: ' + typeof window.markdownit?.default); log('h1: ' + document.querySelector('h1')?.textContent + ' | strong: ' + document.querySelector('strong')?.textContent + ' | li count: ' + document.querySelectorAll('li').length); window.glimpse.send({ type: 'cancel' }) })()`), 2500)
setTimeout(() => process.exit(1), 10000)
