import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE_ROOT = join(process.cwd(), 'src')
const THIS_TEST = 'main/codex/codex-lab-external-chatgpt-auth-import-boundary.test.ts'

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

function productionConsumersOf(moduleBasename: string): string[] {
  return consumersOf(moduleBasename).filter(
    (path) => !path.endsWith('.test.ts') && !path.endsWith('-test-support.ts')
  )
}

describe('Codex lab external ChatGPT auth import boundary', () => {
  it('keeps low-level mint lifecycle private to the in-memory registry', () => {
    expect(productionConsumersOf('codex-lab-external-chatgpt-auth-authority-internal')).toEqual([
      'main/runtime/orchestration/lab-profile/codex-lab-external-chatgpt-auth-registry-state.ts'
    ])
  })

  it('keeps authority state behind public and internal facades', () => {
    expect(productionConsumersOf('codex-lab-external-chatgpt-auth-authority-state')).toEqual([
      'main/codex/codex-lab-external-chatgpt-auth-authority-internal.ts',
      'main/codex/codex-lab-external-chatgpt-auth-authority.ts'
    ])
    expect(productionConsumersOf('codex-lab-external-chatgpt-auth-registry-state')).toEqual([
      'main/runtime/orchestration/lab-profile/codex-lab-external-chatgpt-auth-registry-internal.ts',
      'main/runtime/orchestration/lab-profile/codex-lab-external-chatgpt-auth-registry.ts',
      'main/runtime/orchestration/lab-profile/codex-lab-external-chatgpt-auth-resolver.ts'
    ])
  })

  it('limits host lifecycle authority to mint state and structured launch custody', () => {
    expect(productionConsumersOf('codex-lab-external-chatgpt-auth-host-lifecycle')).toEqual([
      'main/codex/codex-lab-external-chatgpt-auth-authority-state.ts',
      'main/codex/codex-structured-launch-resolution.ts'
    ])
  })

  it('limits production consumers to the explicit registration and resolver wiring', () => {
    expect(productionConsumersOf('codex-lab-external-chatgpt-auth-registry-internal')).toEqual([
      'main/codex/codex-lab-external-chatgpt-auth-registration.ts',
      'main/codex/codex-structured-launch-resolution.ts'
    ])
    expect(productionConsumersOf('codex-lab-external-chatgpt-auth-resolver')).toEqual([
      'main/codex/codex-structured-launch-resolution.ts'
    ])
  })

  it('does not route auth authority into persistence, launch plans, environments, or journals', () => {
    const consumers = productionConsumersOf('codex-lab-external-chatgpt-auth-authority')
    expect(consumers.some((path) => path.includes('/db/'))).toBe(false)
    expect(consumers.some((path) => path.includes('journal'))).toBe(false)
    expect(consumers.some((path) => path.includes('launch-contract'))).toBe(false)
    expect(consumers.some((path) => path.includes('sealed-launch-plan'))).toBe(false)
  })
})
