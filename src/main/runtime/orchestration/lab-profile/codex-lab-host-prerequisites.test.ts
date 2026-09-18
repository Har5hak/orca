import { describe, expect, it, vi } from 'vitest'
import type { CodexLabLiveConfinementHost } from './codex-lab-command-confinement-live-contract'
import { CODEX_LAB_LIVE_PROBE_EXECUTABLE } from './codex-lab-command-confinement-live-probe'
import {
  isValidCodexLabHostPrerequisiteReceipt,
  verifyCodexLabHostPrerequisites,
  type CodexLabHostPrerequisiteVerifierHost
} from './codex-lab-host-prerequisites'
import { SUPPORTED_CODEX_LAB_RELEASE } from './codex-lab-supported-binary'

const CODEX_PATH =
  '/Users/lab/.codex/packages/standalone/releases/0.155.0-aarch64-apple-darwin/bin/codex'

function verifierHost(
  overrides: Partial<CodexLabHostPrerequisiteVerifierHost> = {}
): CodexLabHostPrerequisiteVerifierHost {
  const confinementHost: CodexLabLiveConfinementHost = {
    randomNonce: vi.fn(),
    observeExecutable: vi.fn(),
    observeLayout: vi.fn(),
    openControlSession: vi.fn(),
    executeExact: vi.fn()
  }
  return {
    platform: 'darwin',
    architecture: 'arm64',
    resolveExecutable: () => ({
      path: CODEX_PATH,
      pinnedSha256: SUPPORTED_CODEX_LAB_RELEASE.binarySha256
    }),
    observeExecutable: (path) => ({
      path,
      observedRealPath: path,
      kind: 'regular-file',
      executable: true,
      identity: { device: '1', inode: path === CODEX_PATH ? '2' : '3' },
      sha256:
        path === CODEX_LAB_LIVE_PROBE_EXECUTABLE
          ? 'a'.repeat(64)
          : SUPPORTED_CODEX_LAB_RELEASE.binarySha256
    }),
    createConfinementHost: () => confinementHost,
    ...overrides
  }
}

describe('Codex laboratory host prerequisites', () => {
  it('issues an unforgeable process-wide receipt without requiring a Dispatch', () => {
    const receipt = verifyCodexLabHostPrerequisites(verifierHost())

    expect(receipt).toMatchObject({
      schema: 'orca.codex-lab-host-prerequisites.v1',
      platform: 'darwin',
      architecture: 'arm64',
      implementation: 'native-macos-v1',
      codexExecutableSha256: SUPPORTED_CODEX_LAB_RELEASE.binarySha256,
      probeExecutablePath: '/usr/bin/ruby'
    })
    expect(isValidCodexLabHostPrerequisiteReceipt(receipt)).toBe(true)
    expect(isValidCodexLabHostPrerequisiteReceipt({ ...receipt })).toBe(false)
  })

  it('refuses an unsupported host before publishing readiness', () => {
    expect(() => verifyCodexLabHostPrerequisites(verifierHost({ platform: 'linux' }))).toThrow(
      'require Apple Silicon macOS'
    )
  })

  it('refuses a binary that does not match the independent release pin', () => {
    const base = verifierHost()
    expect(() =>
      verifyCodexLabHostPrerequisites(
        verifierHost({
          observeExecutable: (path) => ({
            ...base.observeExecutable(path),
            sha256: path === CODEX_PATH ? 'f'.repeat(64) : 'a'.repeat(64)
          })
        })
      )
    ).toThrow('does not match the supported laboratory pin')
  })
})
