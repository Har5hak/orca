import { CODEX_LAB_RUNTIME_ROOT } from './codex-lab-launch-contract'
import type { CodexLabRuntimeLayoutHost } from './codex-lab-runtime-layout'
import { createNativeCodexLabRuntimeLayoutHostAtRoot } from './codex-lab-runtime-layout-native-internal'

/** Production construction is deliberately zero-argument and permanently pins the lab root. */
export function createNativeCodexLabRuntimeLayoutHost(): CodexLabRuntimeLayoutHost {
  if (process.platform !== 'darwin') {
    throw new Error('The native Codex laboratory layout is supported only on macOS.')
  }
  return createNativeCodexLabRuntimeLayoutHostAtRoot(CODEX_LAB_RUNTIME_ROOT)
}
