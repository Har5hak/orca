import { parseCodexLabLaunchReceipt } from '../../lab-profile/codex-lab-launch-receipt'
import type { CodexLabGatewayPublicReceipt } from './lab-runtime-custody-contract'
import { normalizeCodexLabGatewayPublicReceipt } from './lab-runtime-custody-json-evidence'

export function parseGatewayReceipt(
  serialized: string | null,
  dispatchId: string
): CodexLabGatewayPublicReceipt | null {
  if (serialized === null) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new Error('Codex laboratory runtime gateway receipt is malformed.')
  }
  return normalizeCodexLabGatewayPublicReceipt(parsed, dispatchId)
}

export function parseLaunchReceipt(serialized: string | null, dispatchId: string) {
  if (serialized === null) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new Error('Codex laboratory launch receipt is malformed.')
  }
  return parseCodexLabLaunchReceipt(parsed, dispatchId)
}
