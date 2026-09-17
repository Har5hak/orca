export type ValidationFailure = Readonly<{ field: string }>

export function invalid(field: string): ValidationFailure {
  return { field }
}

export function isAbsent(value: unknown): value is null | undefined {
  return value === null || value === undefined
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

export function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  )
}

export function exactRecord(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> | null {
  const object = record(value)
  if (!object) {
    return null
  }
  const actual = Object.keys(object).sort()
  const expected = [...keys].sort()
  return sameStrings(actual, expected) ? object : null
}

export function isEmptyOrAbsentRecord(value: unknown): boolean {
  if (isAbsent(value)) {
    return true
  }
  const object = record(value)
  return Boolean(object && Object.keys(object).length === 0)
}

export function containsEnablingValue(value: unknown): boolean {
  if (value === true) {
    return true
  }
  if (typeof value === 'string') {
    return ['allow', 'enabled', 'write', 'danger-full-access'].includes(value)
  }
  if (Array.isArray(value)) {
    return value.some(containsEnablingValue)
  }
  const object = record(value)
  return object ? Object.values(object).some(containsEnablingValue) : false
}
