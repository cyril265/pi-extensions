import type { Message } from '@earendil-works/pi-ai'
import type { PiJsonEvent, ToolDisplayItem } from './types.ts'

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    const textParts = message.content
      .filter(part => part.type === 'text')
      .map(part => part.text)
    if (textParts.length > 0) return textParts.join('')
  }
  return ''
}

function asToolArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {}
}

export function cloneToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(args)) as Record<string, unknown>
  } catch {
    return { ...args }
  }
}

export function getToolDisplayItems(messages: Message[]): ToolDisplayItem[] {
  const items: ToolDisplayItem[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.content) {
      if (part.type !== 'toolCall') continue
      const toolPart = part as { name?: string; arguments?: unknown }
      if (toolPart.name)
        items.push({
          name: toolPart.name,
          args: asToolArgs(toolPart.arguments),
        })
    }
  }
  return items
}

export function getEventToolDisplayItem(event: PiJsonEvent): ToolDisplayItem | undefined {
  if (event.type !== 'tool_execution_start' || !event.toolName) return undefined
  return { name: event.toolName, args: asToolArgs(event.args) }
}

export function dedupeToolDisplayItems(items: ToolDisplayItem[]): ToolDisplayItem[] {
  const deduped: ToolDisplayItem[] = []
  let previous = ''
  for (const item of items) {
    const key = `${item.name}:${JSON.stringify(item.args)}`
    if (key === previous) continue
    previous = key
    deduped.push(item)
  }
  return deduped
}
