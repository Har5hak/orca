import { ORCHESTRATION_FLEET_PAGE_MAX } from '../../../../../../shared/orchestration-fleet-projection'

const FLEET_SNAPSHOT_WIRE_FIELD_MAX_LENGTH = 512

export type FederatedFleetObservation = {
  status: 'live' | 'unverifiable' | 'exited'
  exactWorker: boolean
  reason?: string
}

export function decodeFederatedFleetSnapshot(
  value: unknown,
  expectedDispatchIds: readonly string[]
): {
  runtimeEpoch: string
  items: { dispatchId: string; observation: FederatedFleetObservation }[]
} | null {
  if (
    !isRecord(value) ||
    !isWireIdentifier(value.runtimeEpoch) ||
    !Array.isArray(value.items) ||
    value.items.length !== expectedDispatchIds.length ||
    value.items.length > ORCHESTRATION_FLEET_PAGE_MAX
  ) {
    return null
  }
  const expected = new Set(expectedDispatchIds)
  const seen = new Set<string>()
  const items: { dispatchId: string; observation: FederatedFleetObservation }[] = []
  for (const candidate of value.items) {
    if (!isRecord(candidate) || typeof candidate.dispatchId !== 'string') {
      return null
    }
    const dispatchId = candidate.dispatchId
    if (!expected.has(dispatchId) || seen.has(dispatchId) || !isRecord(candidate.observation)) {
      return null
    }
    const observation = candidate.observation
    const status = observation.status
    const reason = observation.reason
    if (
      !isFleetObservationStatus(status) ||
      typeof observation.exactWorker !== 'boolean' ||
      (reason !== undefined && !isBoundedWireText(reason)) ||
      ((status === 'live' || status === 'exited') &&
        (observation.exactWorker !== true || reason !== undefined)) ||
      (reason !== undefined && status !== 'unverifiable')
    ) {
      return null
    }
    seen.add(dispatchId)
    items.push({
      dispatchId,
      observation: {
        status,
        exactWorker: observation.exactWorker,
        ...(reason !== undefined ? { reason } : {})
      }
    })
  }
  return seen.size === expected.size ? { runtimeEpoch: value.runtimeEpoch, items } : null
}

export function hostIndeterminateItems(
  dispatchIds: readonly string[]
): { dispatchId: string; observation: FederatedFleetObservation }[] {
  return dispatchIds.map((dispatchId) => ({
    dispatchId,
    observation: { status: 'unverifiable', exactWorker: false, reason: 'host_indeterminate' }
  }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFleetObservationStatus(value: unknown): value is FederatedFleetObservation['status'] {
  return value === 'live' || value === 'unverifiable' || value === 'exited'
}

function isWireIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= FLEET_SNAPSHOT_WIRE_FIELD_MAX_LENGTH &&
    value.trim() === value &&
    isBoundedWireText(value)
  )
}

function isBoundedWireText(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > FLEET_SNAPSHOT_WIRE_FIELD_MAX_LENGTH) {
    return false
  }
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return !(
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    )
  })
}
