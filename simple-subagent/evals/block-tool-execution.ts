import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function (pi: ExtensionAPI) {
  pi.on('tool_call', () => ({
    block: true,
    reason: 'Prompting eval captured the tool call',
    terminate: true,
  }))
}
