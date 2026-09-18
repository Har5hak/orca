import type { CodexLabRuntimeLayoutHost } from './codex-lab-runtime-layout'
import { createNativeCodexLabRuntimeLayoutHostAtRoot } from './codex-lab-runtime-layout-native-internal'

export type NativeCodexLabRuntimeLayoutTestHooks = Readonly<{
  beforeQuarantineRename?: (quarantinePath: string) => void
  afterQuarantineAttested?: (quarantinePath: string) => void
}>

export function createNativeCodexLabRuntimeLayoutHostForTest(
  runtimeRoot: string,
  hooks: NativeCodexLabRuntimeLayoutTestHooks = {}
): CodexLabRuntimeLayoutHost {
  return createNativeCodexLabRuntimeLayoutHostAtRoot(runtimeRoot, hooks)
}
