import type {
  CodexLabRuntimeCleanupResource,
  CodexLabRuntimeCustody,
  CodexLabRuntimeCustodyState
} from './lab-runtime-custody-contract'

const RESOURCE_LEVELS: readonly Readonly<{
  resource: CodexLabRuntimeCleanupResource
  level: number
}>[] = Object.freeze([
  Object.freeze({ resource: 'layout', level: 1 }),
  Object.freeze({ resource: 'provider', level: 2 }),
  Object.freeze({ resource: 'gateway', level: 3 }),
  Object.freeze({ resource: 'auth', level: 4 })
])

const ACTIVE_LEVELS: Readonly<Partial<Record<CodexLabRuntimeCustodyState, number>>> = Object.freeze(
  {
    planned: 0,
    authority_attached: 0,
    layout_prepared: 1,
    provider_reserved: 2,
    gateway_started: 3,
    external_auth_installed: 4,
    provider_attached: 4,
    ready: 4
  }
)

export function requireCodexLabRuntimeCustodyInvariants(row: CodexLabRuntimeCustody): void {
  const layoutParts = [
    row.runtimeParentIdentity !== null,
    row.runtimeRootIdentity !== null,
    row.configSha256 !== null
  ]
  if (layoutParts.some(Boolean) && !layoutParts.every(Boolean)) {
    throw new Error('Codex laboratory runtime layout evidence is incomplete.')
  }
  const evidence = [
    layoutParts.every(Boolean),
    row.provider !== null,
    row.gatewayReceipt !== null,
    row.auth !== null
  ]
  const firstMissing = evidence.indexOf(false)
  const level = firstMissing === -1 ? evidence.length : firstMissing
  if (evidence.slice(level).some(Boolean)) {
    throw new Error('Codex laboratory runtime custody evidence has a lifecycle gap.')
  }
  const expectedActiveLevel = ACTIVE_LEVELS[row.state]
  if (expectedActiveLevel !== undefined && level !== expectedActiveLevel) {
    throw new Error('Codex laboratory runtime custody evidence does not match its state.')
  }
  for (const { resource, level: obligationLevel } of RESOURCE_LEVELS) {
    const cleanup = row.cleanup[resource]
    const created = obligationLevel <= level
    if (created !== (cleanup.state !== 'not_created')) {
      throw new Error('Codex laboratory runtime cleanup obligations do not match its evidence.')
    }
    if (
      expectedActiveLevel !== undefined &&
      cleanup.state !== (created ? 'pending' : 'not_created')
    ) {
      throw new Error('Active Codex laboratory runtime cleanup state is invalid.')
    }
    if (row.state === 'released' && cleanup.state !== (created ? 'released' : 'not_created')) {
      throw new Error('Released Codex laboratory runtime cleanup state is invalid.')
    }
  }
}
