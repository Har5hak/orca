import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { PreparedLocalLabWorkerStart } from '../../rpc/methods/orchestration/worker/local-lab-worker-start'
import { CODEX_LAB_RUNTIME_ROOT, type CodexLabLaunchFacts } from './codex-lab-launch-contract'
import { observeNativeCodexLabExecutable } from './codex-lab-command-confinement-live-native-observation'
import type { CodexLabTrustedFileObservation } from './codex-lab-command-confinement-live-contract'

const USAGE_BASED_WORKSPACE_PLAN_TYPES = new Set([
  'self_serve_business_usage_based',
  'enterprise_cbp_usage_based'
])

export type CodexLabLaunchFactsCollectorHost = Readonly<{
  platform: string
  observeExecutable(path: string): CodexLabTrustedFileObservation
  observePath(path: string): 'absent' | 'present'
}>

export function collectCodexLabLaunchFacts(input: {
  prepared: PreparedLocalLabWorkerStart
  gateway: Readonly<{ endpoint: string; credential: string }>
  credential: Readonly<{ workspaceId: string; planType: string }>
  executable: Readonly<{ path: string; pinnedSha256: string }>
  host: CodexLabLaunchFactsCollectorHost
}): CodexLabLaunchFacts {
  const dispatchId = input.prepared.started.dispatch.id
  const dispatchRoot = join(CODEX_LAB_RUNTIME_ROOT, 'dispatches', dispatchId)
  const codexHome = join(dispatchRoot, 'codex-home')
  const fakeHome = join(dispatchRoot, 'fake-home')
  const observedExecutable = input.host.observeExecutable(input.executable.path)
  const observation = input.prepared.observation.observation
  const worktreeKind: CodexLabLaunchFacts['worktree']['kind'] =
    observation.kind === 'git-worktree' ? 'directory' : 'other'
  const authJsonState: CodexLabLaunchFacts['authentication']['authJson']['state'] =
    input.host.observePath(join(codexHome, 'auth.json')) === 'absent' ? 'absent' : 'regular-file'
  const paidWorkspaceRoute = USAGE_BASED_WORKSPACE_PLAN_TYPES.has(input.credential.planType)
  return Object.freeze({
    platform: input.host.platform,
    profile: input.prepared.admission.profile,
    adapter: input.prepared.admission.adapter,
    dispatch: Object.freeze({
      id: dispatchId,
      runtimeRoot: CODEX_LAB_RUNTIME_ROOT,
      codexHomeState: input.host.observePath(codexHome),
      fakeHomeState: input.host.observePath(fakeHome)
    }),
    worktree: Object.freeze({
      identity: observation.worktreeIdentity,
      expectedPath: input.prepared.admission.expectedWorktreePath,
      observedPath: observation.path,
      observedRealPath: observation.realpath,
      kind: worktreeKind,
      disposable: observation.disposable
    }),
    gateway: Object.freeze({
      socketPath: input.gateway.endpoint,
      credential: input.gateway.credential
    }),
    binary: Object.freeze({
      path: input.executable.path,
      observedRealPath: observedExecutable.observedRealPath,
      kind: observedExecutable.kind,
      executable: observedExecutable.executable,
      pinnedSha256: input.executable.pinnedSha256,
      observedSha256: observedExecutable.sha256
    }),
    authentication: Object.freeze({
      loginMethod: 'chatgpt',
      expectedWorkspaceId: input.credential.workspaceId,
      observedWorkspaceId: input.credential.workspaceId,
      subscription: Object.freeze({
        status: paidWorkspaceRoute
          ? 'paid-usage'
          : input.credential.planType
            ? 'active'
            : 'ambiguous',
        scope: 'workspace',
        unambiguous: Boolean(input.credential.planType)
      }),
      authJson: Object.freeze({ state: authJsonState })
    }),
    ambientEnv: Object.freeze({})
  })
}

export function createNativeCodexLabLaunchFactsCollectorHost(): CodexLabLaunchFactsCollectorHost {
  return Object.freeze({
    platform: process.platform,
    observeExecutable: observeNativeCodexLabExecutable,
    observePath(path): 'absent' | 'present' {
      try {
        lstatSync(path)
        return 'present'
      } catch (error) {
        if (isRecord(error) && error.code === 'ENOENT') {
          return 'absent'
        }
        throw error
      }
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
