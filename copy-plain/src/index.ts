import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent'
import { copyPlainWithHtml } from './clipboard.ts'
import { markdownToHtmlDocument, markdownToPlainText } from './format.ts'

type TextBlock = {
  type?: string
  text?: string
}

type AssistantMessage = {
  role?: string
  content?: unknown
  stopReason?: string
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand('copy-plain', {
    description: 'Copy the last assistant message as clean plain text with rich HTML fallback',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const markdown = getLastAssistantText(ctx.sessionManager.getBranch())
      if (!markdown) {
        ctx.ui.notify('No agent messages to copy yet.', 'warning')
        return
      }

      const plain = markdownToPlainText(markdown)
      const html = markdownToHtmlDocument(markdown)

      try {
        const result = await copyPlainWithHtml(plain, html)
        if (result.mode === 'rich') {
          ctx.ui.notify('Copied clean plain text with rich HTML fallback.', 'info')
          return
        }

        const reason =
          result.reason === 'html-unsupported'
            ? 'Rich HTML clipboard is only available on macOS.'
            : 'Rich HTML write failed; copied clean plain text instead.'
        ctx.ui.notify(`Copied clean plain text. ${reason}`, 'info')
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      }
    },
  })
}

function getLastAssistantText(entries: readonly SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry || entry.type !== 'message') continue

    const message = entry.message as AssistantMessage
    if (message.role !== 'assistant') continue
    const isEmptyAbort =
      message.stopReason === 'aborted' &&
      Array.isArray(message.content) &&
      message.content.length === 0
    if (isEmptyAbort) continue

    const text = textContent(message.content).trim()
    if (text) return text
  }

  return undefined
}

function textContent(content: unknown): string {
  if (!Array.isArray(content)) return ''

  let text = ''
  for (const block of content) {
    const textBlock = block as TextBlock
    if (textBlock.type === 'text' && typeof textBlock.text === 'string') {
      text += textBlock.text
    }
  }

  return text
}
