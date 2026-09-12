import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function (pi: ExtensionAPI) {
  pi.on('before_provider_request', (event, ctx) => {
    if (ctx.model?.provider !== 'anthropic' || ctx.model.id !== 'claude-fable-5-1') return

    const payload = event.payload
    if (typeof payload !== 'object' || payload === null || !('thinking' in payload)) return

    const thinking = payload.thinking
    if (typeof thinking !== 'object' || thinking === null || !('block_binding' in thinking)) return

    Reflect.deleteProperty(thinking, 'block_binding')
  })
}
