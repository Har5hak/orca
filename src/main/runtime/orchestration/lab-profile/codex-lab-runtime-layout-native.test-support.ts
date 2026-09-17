import { randomUUID } from 'node:crypto'
import type { CodexLabRuntimeLayoutHost } from './codex-lab-runtime-layout'
import { createNativeCodexLabRuntimeLayoutHostAtRoot } from './codex-lab-runtime-layout-native-internal'

export type NativeCodexLabRuntimeLayoutTestHooks = Readonly<{
  randomId?: () => string
  afterQuarantineAttested?: (quarantinePath: string) => void
}>

export function createNativeCodexLabRuntimeLayoutHostForTest(
  runtimeRoot: string,
  hooks: NativeCodexLabRuntimeLayoutTestHooks = {}
): CodexLabRuntimeLayoutHost {
  const nativeHooks = hooks.afterQuarantineAttested
    ? { afterQuarantineAttested: hooks.afterQuarantineAttested }
    : {}
  return createNativeCodexLabRuntimeLayoutHostAtRoot(
    runtimeRoot,
    hooks.randomId ?? randomUUID,
    nativeHooks
  )
}
