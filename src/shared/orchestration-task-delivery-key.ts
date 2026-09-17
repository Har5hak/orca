export const TASK_DELIVERY_KEY_MAX_LENGTH = 512
export const TASK_DELIVERY_CONTRACT_VERSION = 1
export const TASK_DELIVERY_KEY_LENGTH_GUIDANCE = `--delivery-key must contain between 1 and ${TASK_DELIVERY_KEY_MAX_LENGTH} Unicode code points.`
export const TASK_DELIVERY_KEY_NUL_GUIDANCE = '--delivery-key must not contain NUL characters.'
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

export type TaskDeliveryReceipt = {
  delivery_key: string
  contract_sha256: string
  task_id: string
  run_id: string
  disposition: 'created' | 'adopted'
}

export type RootTaskDeliveryContract = {
  version: typeof TASK_DELIVERY_CONTRACT_VERSION
  spec: string
  dependencies: string[]
}

export function isValidTaskDeliveryKey(value: unknown): value is string {
  return typeof value === 'string' && isValidTaskDeliveryKeyLength(value) && !value.includes('\0')
}

export function isValidTaskDeliveryKeyLength(value: string): boolean {
  let codePoints = 0
  for (const _codePoint of value) {
    codePoints += 1
    if (codePoints > TASK_DELIVERY_KEY_MAX_LENGTH) {
      return false
    }
  }
  return codePoints >= 1
}

export function isTaskDeliveryReceipt(value: unknown): value is TaskDeliveryReceipt {
  const receipt = objectRecord(value)
  return Boolean(
    receipt &&
    isValidTaskDeliveryKey(receipt.delivery_key) &&
    typeof receipt.contract_sha256 === 'string' &&
    SHA256_HEX_PATTERN.test(receipt.contract_sha256) &&
    typeof receipt.task_id === 'string' &&
    receipt.task_id.length > 0 &&
    typeof receipt.run_id === 'string' &&
    receipt.run_id.length > 0 &&
    (receipt.disposition === 'created' || receipt.disposition === 'adopted')
  )
}

/** Labels, Run ownership, creator provenance, and lifecycle state are not execution semantics. */
export function buildRootTaskDeliveryContract(input: { spec: string; deps?: readonly string[] }): {
  contract: RootTaskDeliveryContract
  serialized: string
} {
  const contract: RootTaskDeliveryContract = {
    version: TASK_DELIVERY_CONTRACT_VERSION,
    // Exact string contents are intentional: changing instruction whitespace changes the contract.
    spec: input.spec,
    // Readiness checks treat dependencies as a set, so their order and duplicates are not semantic.
    dependencies: [...new Set(input.deps ?? [])].sort()
  }
  return { contract, serialized: JSON.stringify(contract) }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guards above establish a non-array object whose fields remain unknown.
  return value as Record<string, unknown>
}
