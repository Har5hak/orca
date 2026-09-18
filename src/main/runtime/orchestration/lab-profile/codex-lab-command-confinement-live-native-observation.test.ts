import { lstatSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withHostCompatibilityInput } from './codex-lab-command-confinement-host.test-support'
import { createNativeCodexLabLiveConfinementHost } from './codex-lab-command-confinement-live-native'

describe('native Codex laboratory layout observation', () => {
  it.runIf(process.platform === 'darwin')(
    'refuses auth.json injected after the prepared layout was attested',
    async () => {
      await withHostCompatibilityInput(realpathSync(process.execPath), async ({ input }) => {
        const host = createNativeCodexLabLiveConfinementHost()
        expect(host.observeLayout(input.preparedLayout).authJson).toBe('absent')
        const authPath = join(input.preparedLayout.codexHome, 'auth.json')

        withExactOwnedRegularFile(authPath, '{}', () => {
          expect(() => host.observeLayout(input.preparedLayout)).toThrow(
            'confinement auth.json must remain absent'
          )
        })
      })
    }
  )
})

function withExactOwnedRegularFile(path: string, contents: string, execute: () => void): void {
  writeFileSync(path, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const created = lstatSync(path, { bigint: true })
  let primaryError: unknown
  try {
    execute()
  } catch (error) {
    primaryError = error
  }
  let cleanupError: unknown
  try {
    const observed = lstatSync(path, { bigint: true })
    if (
      !observed.isFile() ||
      observed.isSymbolicLink() ||
      observed.dev !== created.dev ||
      observed.ino !== created.ino
    ) {
      throw new Error('refusing to clean a replaced test-owned auth.json')
    }
    unlinkSync(path)
  } catch (error) {
    cleanupError = error
  }
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      'auth.json injection assertion and exact cleanup both failed'
    )
  }
  if (primaryError) {
    throw primaryError
  }
  if (cleanupError) {
    throw cleanupError
  }
}
