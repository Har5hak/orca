import { randomBytes } from 'node:crypto'
import type { CodexLabLiveConfinementHost } from './codex-lab-command-confinement-live-contract'
import { executeNativeCodexLabExactSpec } from './codex-lab-command-confinement-live-native-executor'
import {
  assertNativeCodexLabFilesystemControlsUnchanged,
  collectNativeCodexLabFilesystemControls
} from './codex-lab-command-confinement-live-native-filesystem'
import { openNativeCodexLabNetworkSession } from './codex-lab-command-confinement-live-native-network'
import {
  observeNativeCodexLabExecutable,
  observeNativeCodexLabLayout
} from './codex-lab-command-confinement-live-native-observation'

export function createNativeCodexLabLiveConfinementHost(): CodexLabLiveConfinementHost {
  if (process.platform !== 'darwin') {
    throw new Error('live Codex laboratory confinement is currently supported only on macOS')
  }
  return Object.freeze({
    randomNonce: () => randomBytes(16).toString('hex'),
    observeExecutable: observeNativeCodexLabExecutable,
    observeLayout: observeNativeCodexLabLayout,
    async openControlSession(args) {
      const filesystem = collectNativeCodexLabFilesystemControls(args)
      const network = await openNativeCodexLabNetworkSession({
        ...args,
        privateTmp: filesystem.privateTmp,
        tcpChallenge: randomBytes(16).toString('hex'),
        unixChallenge: randomBytes(16).toString('hex'),
        deniedUnixChallenge: randomBytes(16).toString('hex')
      })
      return Object.freeze({
        controls: deepFreeze({
          phase: 'completed-before-sandbox' as const,
          worktreeRead: filesystem.worktreeRead,
          writes: filesystem.writes,
          network: network.network
        }),
        assertPostExecution(report) {
          network.assertPostExecution(report)
          assertNativeCodexLabFilesystemControlsUnchanged({
            ...args,
            controls: filesystem
          })
        },
        close: network.close
      })
    },
    executeExact: executeNativeCodexLabExactSpec
  })
}

function deepFreeze<T extends object>(value: T): Readonly<T> {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') {
      deepFreeze(nested)
    }
  }
  return Object.freeze(value)
}
