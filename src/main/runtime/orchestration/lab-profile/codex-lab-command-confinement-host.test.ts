import { existsSync, mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withHostCompatibilityInput } from './codex-lab-command-confinement-host.test-support'
import { CODEX_LAB_RUNTIME_ROOT } from './codex-lab-launch-contract'

const TRUE_BINARY = realpathSync('/usr/bin/true')

describe('Codex laboratory command-confinement host fixture', () => {
  it('removes only its exact owned fixture after success', async () => {
    let dispatchRoot: string | undefined
    const result = await withHostCompatibilityInput(TRUE_BINARY, ({ dispatchRoot: root }) => {
      dispatchRoot = root
      expect(dirname(root)).toBe(join(CODEX_LAB_RUNTIME_ROOT, 'dispatches'))
      expect(basename(root)).toMatch(/^compat-/u)
      expect(existsSync(root)).toBe(true)
      return 'finished'
    })

    expect(result).toBe('finished')
    expect(dispatchRoot).toBeDefined()
    expect(existsSync(dispatchRoot ?? '')).toBe(false)
  })

  it('removes only its exact owned fixture when the callback fails', async () => {
    let dispatchRoot: string | undefined
    const binaryBefore = statSync(TRUE_BINARY)
    await expect(
      withHostCompatibilityInput(TRUE_BINARY, ({ dispatchRoot: root, input }) => {
        dispatchRoot = root
        expect(existsSync(root)).toBe(true)
        const generatedRoot = join(input.plan.runtimePaths.codexHome, 'tmp', 'arg0', 'generated')
        mkdirSync(generatedRoot, { recursive: true })
        writeFileSync(join(generatedRoot, '.lock'), '')
        symlinkSync(TRUE_BINARY, join(generatedRoot, 'codex-helper'))
        throw new Error('deliberate host-fixture callback failure')
      })
    ).rejects.toThrow('deliberate host-fixture callback failure')

    expect(dispatchRoot).toBeDefined()
    expect(existsSync(dispatchRoot ?? '')).toBe(false)
    const binaryAfter = statSync(TRUE_BINARY)
    expect({ device: binaryAfter.dev, inode: binaryAfter.ino }).toEqual({
      device: binaryBefore.dev,
      inode: binaryBefore.ino
    })
  })
})
