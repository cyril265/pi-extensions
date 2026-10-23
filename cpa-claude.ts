import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const baseUrl = 'http://127.0.0.1:8317'

export default function cpaClaude(pi: ExtensionAPI): void {
  pi.registerProvider('cpa-claude', {
    name: 'CLIProxyAPI Claude',
    baseUrl,
    api: 'anthropic-messages',
    models: getBuiltinModels('anthropic').map(model => ({
      ...model,
      name: `${model.name} (CPA)`,
      baseUrl,
    })),
  })
}
