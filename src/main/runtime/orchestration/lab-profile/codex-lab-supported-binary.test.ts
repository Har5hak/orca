import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  resolveSupportedCodexLabExecutable,
  SUPPORTED_CODEX_LAB_RELEASE,
  type CodexLabSupportedBinaryHost
} from './codex-lab-supported-binary'

const HOME = '/Users/tester'
const RELEASE_ROOT = `${HOME}/.codex/packages/standalone/releases/${SUPPORTED_CODEX_LAB_RELEASE.version}-${SUPPORTED_CODEX_LAB_RELEASE.target}`
const EXECUTABLE = `${RELEASE_ROOT}/bin/codex`

function host(overrides: Partial<CodexLabSupportedBinaryHost> = {}): CodexLabSupportedBinaryHost {
  return Object.freeze({
    platform: 'darwin',
    architecture: 'arm64',
    homePath: HOME,
    readUtf8: () =>
      JSON.stringify({
        layoutVersion: 1,
        version: SUPPORTED_CODEX_LAB_RELEASE.version,
        target: SUPPORTED_CODEX_LAB_RELEASE.target,
        variant: 'codex',
        entrypoint: 'bin/codex'
      }),
    realpath: (path) => path,
    ...overrides
  })
}

describe('supported Codex laboratory binary', () => {
  it('resolves only the exact standalone release path with its independent digest pin', () => {
    expect(resolveSupportedCodexLabExecutable(host())).toEqual({
      path: EXECUTABLE,
      pinnedSha256: SUPPORTED_CODEX_LAB_RELEASE.binarySha256
    })
  })

  it.each([
    ['version', '0.154.0'],
    ['target', 'x86_64-apple-darwin'],
    ['variant', 'app-server'],
    ['entrypoint', 'codex']
  ])('refuses a package manifest with a different %s', (field, value) => {
    const candidate = {
      layoutVersion: 1,
      version: SUPPORTED_CODEX_LAB_RELEASE.version,
      target: SUPPORTED_CODEX_LAB_RELEASE.target,
      variant: 'codex',
      entrypoint: 'bin/codex',
      [field]: value
    }
    expect(() =>
      resolveSupportedCodexLabExecutable(host({ readUtf8: () => JSON.stringify(candidate) }))
    ).toThrow('does not match the laboratory pin')
  })

  it('refuses a mutable or redirected executable path', () => {
    expect(() =>
      resolveSupportedCodexLabExecutable(
        host({ realpath: () => '/Applications/ChatGPT.app/Contents/Resources/codex' })
      )
    ).toThrow('path is not canonical')
  })

  it.each([
    ['linux', 'arm64'],
    ['darwin', 'x64']
  ] as const)('fails closed on unsupported host %s/%s', (platform, architecture) => {
    expect(() => resolveSupportedCodexLabExecutable(host({ platform, architecture }))).toThrow(
      'supports only Apple Silicon macOS'
    )
  })

  it.runIf(process.env.ORCA_TEST_HOST_CODEX_LAB_BINARY === '1')(
    'matches the installed host binary to the reviewed release pin',
    () => {
      const executable = resolveSupportedCodexLabExecutable()
      const observed = createHash('sha256').update(readFileSync(executable.path)).digest('hex')

      expect(observed).toBe(executable.pinnedSha256)
    }
  )
})
