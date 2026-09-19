import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'
import {
  CODEX_LAB_DYNAMIC_TOOL_BINDINGS,
  CODEX_LAB_DYNAMIC_TOOL_SPECS
} from '../../../codex/codex-lab-dynamic-tool-contract'
import {
  CODEX_LAB_PERMISSION_PROFILE_ID,
  DISABLED_CODEX_LAB_FEATURES,
  ENABLED_CODEX_LAB_CONFINEMENT_FEATURES
} from './codex-lab-launch-policy'

const SHA256 = /^[a-f0-9]{64}$/u
const SUSPICIOUS_KEY =
  /(?:authorization|bearer|credential|dcap|gateway.?access|password|secret|token|api.?key)/iu
const SUSPICIOUS_VALUE =
  /(?:\bbearer\s+|\blgw1_|\bdcap_|\bsk-[A-Za-z0-9]|access[_-]?token|refresh[_-]?token|private[_-]?key)/iu

export function assertSecretFree(value: unknown, seen = new Set<object>()): void {
  if (typeof value === 'string') {
    if (SUSPICIOUS_VALUE.test(value)) {
      throw new Error('Codex laboratory launch receipt contains secret-derived material.')
    }
    return
  }
  if (!value || typeof value !== 'object') {
    return
  }
  if (seen.has(value)) {
    throw new Error('Codex laboratory launch receipt must be acyclic.')
  }
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || SUSPICIOUS_KEY.test(key)) {
      throw new Error('Codex laboratory launch receipt contains a forbidden field.')
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) {
      throw new Error('Codex laboratory launch receipt must use data fields.')
    }
    assertSecretFree(descriptor.value, seen)
  }
  seen.delete(value)
}

export function requireExactObject(
  value: unknown,
  field: string,
  expectedKeys: readonly string[]
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Codex laboratory launch receipt ${field} must be an object.`)
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`Codex laboratory launch receipt ${field} fields are invalid.`)
  }
  const snapshot: Record<string, unknown> = {}
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new Error(`Codex laboratory launch receipt ${field} must use data fields.`)
    }
    snapshot[key] = descriptor.value
  }
  return snapshot
}

export function requireExactArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Codex laboratory launch receipt ${field} must be an array.`)
  }
  const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index))
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== expectedKeys.length + 1 ||
    keys.at(-1) !== 'length' ||
    keys.slice(0, -1).some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`Codex laboratory launch receipt ${field} fields are invalid.`)
  }
  return expectedKeys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new Error(`Codex laboratory launch receipt ${field} must use data fields.`)
    }
    return descriptor.value
  })
}

export function allSha256(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[] = Object.keys(value)
): boolean {
  return keys.every((key) => isSha256(value[key]))
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value)
}

export function isSafeLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/%+-]{0,511}$/u.test(value) &&
    !SUSPICIOUS_VALUE.test(value)
  )
}

export function isDecimalIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)
}

export function isGitObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)
}

export function isCanonicalAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && normalize(value) === value
}

export function sameStrings(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function buildAttestedPolicyContract(input: {
  worktreePath: unknown
  configSha256: unknown
  capacityPolicySha256: unknown
}) {
  return Object.freeze({
    schema: 'orca.codex-lab-attested-policy-contract.v1' as const,
    configSha256: input.configSha256,
    capacityPolicySha256: input.capacityPolicySha256,
    approvalPolicy: 'never' as const,
    permissionProfileId: CODEX_LAB_PERMISSION_PROFILE_ID,
    runtimeWorkspaceRoots: Object.freeze([input.worktreePath]),
    environmentMode: 'exact' as const,
    accountRoute: 'chatgpt-workspace' as const,
    managedRequirements: 'absent-or-compatible' as const,
    disabledFeatures: DISABLED_CODEX_LAB_FEATURES,
    enabledFeatures: ENABLED_CODEX_LAB_CONFINEMENT_FEATURES,
    dynamicToolBindings: CODEX_LAB_DYNAMIC_TOOL_BINDINGS,
    dynamicToolSpecsSha256: sha256(JSON.stringify(CODEX_LAB_DYNAMIC_TOOL_SPECS)),
    outOfBandMethods: 'not-requested-by-attestation-probe' as const
  })
}

export function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object') {
    return value
  }
  if (!Object.isFrozen(value)) {
    Object.freeze(value)
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, key))
  }
  return value
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
