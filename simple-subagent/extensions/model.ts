export function resolveEffectiveModel(
  suppliedModel: string | undefined,
  modelAliases: Record<string, string>,
): string | undefined {
  const requestedModel = suppliedModel?.trim() || undefined
  if (!requestedModel) return undefined

  const aliasedModel = Object.hasOwn(modelAliases, requestedModel)
    ? modelAliases[requestedModel]
    : undefined
  if (aliasedModel) return aliasedModel
  if (requestedModel.includes('/')) return requestedModel

  throw new Error(`Unknown model alias "${requestedModel}"`)
}
