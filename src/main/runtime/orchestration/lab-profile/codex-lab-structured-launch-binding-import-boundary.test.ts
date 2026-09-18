import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE_ROOT = join(process.cwd(), 'src')
const THIS_TEST =
  'main/runtime/orchestration/lab-profile/codex-lab-structured-launch-binding-import-boundary.test.ts'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return sourceFiles(path)
    }
    return entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name) ? [path] : []
  })
}

function consumersOf(moduleBasename: string): string[] {
  return sourceFiles(SOURCE_ROOT)
    .filter((path) => readFileSync(path, 'utf8').includes(moduleBasename))
    .map((path) => relative(SOURCE_ROOT, path).split(sep).join('/'))
    .filter((path) => path !== THIS_TEST)
    .sort()
}

describe('Codex lab structured binding registry import boundary', () => {
  it('limits the mutation facade to the worker-session boundary and scoped test support', () => {
    expect(consumersOf('codex-lab-structured-launch-binding-registry-internal')).toEqual([
      'main/runtime/orchestration/lab-profile/codex-lab-structured-launch-binding-test-support.ts',
      'main/runtime/rpc/methods/orchestration-structured-worker-session.ts'
    ])
  })

  it('limits authority-bearing reads to the structured Codex launch resolver', () => {
    expect(consumersOf('codex-lab-structured-launch-binding-resolver')).toEqual([
      'main/codex/codex-structured-launch-resolution.ts'
    ])
  })

  it('limits the mutable state module to its read-only, resolver, and mutation facades', () => {
    expect(consumersOf('codex-lab-structured-launch-binding-registry-state')).toEqual([
      'main/runtime/orchestration/lab-profile/codex-lab-structured-launch-binding-registry-internal.ts',
      'main/runtime/orchestration/lab-profile/codex-lab-structured-launch-binding-registry.ts',
      'main/runtime/orchestration/lab-profile/codex-lab-structured-launch-binding-resolver.ts'
    ])
  })

  it('limits scoped test-support consumers to executable test modules', () => {
    const productionConsumers = consumersOf(
      'codex-lab-structured-launch-binding-test-support'
    ).filter((path) => !path.endsWith('.test.ts'))

    expect(productionConsumers).toEqual([])
  })
})
