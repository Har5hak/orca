const SAFE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u
const SUSPICIOUS_JSON_KEY =
  /(?:authorization|bearer|credential|dcap|password|secret|token|api.?key)/iu
const SUSPICIOUS_JSON_VALUE =
  /(?:\bbearer\s+|\blgw1_|\bdcap_|\bsk-[A-Za-z0-9]|access[_-]?token|refresh[_-]?token|private[_-]?key)/iu

export function rejectSuspiciousJsonEvidence(value: unknown): void {
  visitJsonEvidence(value, new Set<object>())
}

export function requireExactDataObject(
  value: unknown,
  field: string,
  expectedKeys: readonly string[]
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Codex laboratory runtime custody ${field} must be an object.`)
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    throw new Error(`Codex laboratory runtime custody ${field} fields are invalid.`)
  }
  const snapshot: Record<string, unknown> = {}
  for (const key of expectedKeys) {
    snapshot[key] = requireDataField(value, key, field)
  }
  return Object.freeze(snapshot)
}

export function snapshotExactArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Codex laboratory runtime custody ${field} must be an array.`)
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (
    !lengthDescriptor ||
    !('value' in lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value)
  ) {
    throw new Error(`Codex laboratory runtime custody ${field} is invalid.`)
  }
  const expectedKeys = Array.from({ length: lengthDescriptor.value }, (_, index) => String(index))
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== expectedKeys.length + 1 ||
    keys.some((key) => typeof key !== 'string') ||
    !expectedKeys.every((key) => keys.includes(key)) ||
    !keys.includes('length')
  ) {
    throw new Error(`Codex laboratory runtime custody ${field} is invalid.`)
  }
  return Object.freeze(expectedKeys.map((key) => requireDataField(value, key, field)))
}

export function sameStrings(left: readonly unknown[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function requireSafeCustodyLabel(value: string, field: string): string {
  if (!SAFE_LABEL_PATTERN.test(value) || SUSPICIOUS_JSON_VALUE.test(value)) {
    throw new Error(`Codex laboratory runtime custody ${field} is invalid.`)
  }
  return value
}

function visitJsonEvidence(value: unknown, seen: Set<object>): void {
  if (typeof value === 'string') {
    if (SUSPICIOUS_JSON_VALUE.test(value)) {
      throw new Error('Codex laboratory runtime custody rejected secret-like JSON evidence.')
    }
    return
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return
  }
  if (typeof value !== 'object' || seen.has(value)) {
    throw new Error('Codex laboratory runtime custody JSON evidence is not serializable.')
  }
  seen.add(value)
  if (Array.isArray(value)) {
    visitJsonArray(value, seen)
    seen.delete(value)
    return
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || SUSPICIOUS_JSON_KEY.test(key)) {
      throw new Error('Codex laboratory runtime custody rejected a suspicious JSON evidence key.')
    }
    visitJsonEvidence(requireDataField(value, key, 'JSON evidence'), seen)
  }
  seen.delete(value)
}

function visitJsonArray(value: readonly unknown[], seen: Set<object>): void {
  const keys = Reflect.ownKeys(value)
  const expectedKeys = [...value.keys()].map(String)
  if (
    keys.length !== expectedKeys.length + 1 ||
    keys.at(-1) !== 'length' ||
    keys.slice(0, -1).some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error('Codex laboratory runtime custody JSON evidence array is invalid.')
  }
  for (const key of expectedKeys) {
    visitJsonEvidence(requireDataField(value, key, 'JSON array'), seen)
  }
}

function requireDataField(value: object, key: string, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
    throw new Error(`Codex laboratory runtime custody ${field} must use data fields.`)
  }
  return descriptor.value
}
