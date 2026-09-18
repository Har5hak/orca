import type { CodexLabLiveConfinementHost } from './codex-lab-command-confinement-live-contract'
import { CODEX_LAB_LIVE_PROBE_EXECUTABLE } from './codex-lab-command-confinement-live-probe'
import {
  verifyCodexLabHostPrerequisites,
  type CodexLabHostPrerequisiteReceipt
} from './codex-lab-host-prerequisites'
import { SUPPORTED_CODEX_LAB_RELEASE } from './codex-lab-supported-binary'

const CODEX_PATH =
  '/Users/lab/.codex/packages/standalone/releases/0.155.0-aarch64-apple-darwin/bin/codex'

export function verifiedCodexLabHostPrerequisiteReceipt(): CodexLabHostPrerequisiteReceipt {
  const unavailable = (): never => {
    throw new Error(
      'test confinement host method must not execute during prerequisite verification'
    )
  }
  const unavailableAsync = async (): Promise<never> => unavailable()
  const confinementHost = {
    randomNonce: unavailable,
    observeExecutable: unavailable,
    observeLayout: unavailable,
    openControlSession: unavailableAsync,
    executeExact: unavailableAsync
  } satisfies CodexLabLiveConfinementHost
  return verifyCodexLabHostPrerequisites({
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
    createConfinementHost: () => confinementHost
  })
}
