import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
  LAB_READONLY_SUPERVISED_PROFILE_ID,
  type CodexLabLaunchFacts,
  type SealedCodexLabLaunchPlan
} from './codex-lab-launch-contract'
import { buildSealedCodexLabLaunchPlan } from './codex-sealed-launch-plan'
import {
  buildExpectedCodexLabEffectivePolicy,
  buildExpectedCodexLabRuntimeObservations,
  type CodexLabEffectivePolicyObservation,
  type CodexLabEffectivePolicyProbeRequest,
  type CodexLabHost,
  type CodexLabRuntimeProbeRequest,
  type CodexLabRuntimeObservations,
  type CodexLabSpawnRequest
} from './codex-lab-host-executor-contract'

const SHA256_A = 'a'.repeat(64)
const WORKSPACE_ID = '018f47a2-9d72-7cc1-b046-7a2868411f42'

export function sealedHostPlan(): SealedCodexLabLaunchPlan {
  const facts: CodexLabLaunchFacts = {
    platform: 'darwin',
    profile: LAB_READONLY_SUPERVISED_PROFILE_ID,
    adapter: CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
    dispatch: {
      id: 'dispatch-757-host-1',
      runtimeRoot: '/private/tmp/orca-lab/runtime',
      codexHomeState: 'absent',
      fakeHomeState: 'absent'
    },
    worktree: {
      identity: 'wt2:local:disposable-host-instance',
      expectedPath: '/private/tmp/orca-lab/disposable-worktree',
      observedPath: '/private/tmp/orca-lab/disposable-worktree',
      observedRealPath: '/private/tmp/orca-lab/disposable-worktree',
      kind: 'directory',
      disposable: true
    },
    gateway: {
      socketPath: '/private/tmp/orca-lab/runtime/dispatches/dispatch-757-host-1/gateway.sock',
      credential: `lgw1_${'g'.repeat(43)}`
    },
    binary: {
      path: '/Applications/ChatGPT.app/Contents/Resources/codex',
      observedRealPath: '/Applications/ChatGPT.app/Contents/Resources/codex',
      kind: 'regular-file',
      executable: true,
      pinnedSha256: SHA256_A,
      observedSha256: SHA256_A
    },
    authentication: {
      keyringAvailable: true,
      keyringBackend: 'macos-keychain',
      loginMethod: 'chatgpt',
      expectedWorkspaceId: WORKSPACE_ID,
      observedWorkspaceId: WORKSPACE_ID,
      subscription: { status: 'active', scope: 'workspace', unambiguous: true },
      authJson: { state: 'absent' }
    },
    ambientEnv: {}
  }
  return buildSealedCodexLabLaunchPlan(facts)
}

export class FakeCodexLabHost implements CodexLabHost {
  readonly calls: string[] = []
  readonly effectiveProbeRequests: CodexLabEffectivePolicyProbeRequest[] = []
  readonly runtimeProbeRequests: CodexLabRuntimeProbeRequest[] = []
  readonly spawnRequests: CodexLabSpawnRequest[] = []
  readonly failOperations = new Set<string>()
  readonly pathKinds = new Map<string, 'directory' | 'file'>()
  readonly pathModes = new Map<string, number>()
  readonly fileContents = new Map<string, string>()
  effectivePolicy: CodexLabEffectivePolicyObservation
  runtimeObservations: CodexLabRuntimeObservations
  configDigestOverride?: string

  constructor(readonly plan: SealedCodexLabLaunchPlan) {
    const dispatchRoot = dirname(plan.runtimePaths.codexHome)
    this.effectivePolicy = buildExpectedCodexLabEffectivePolicy(plan)
    this.runtimeObservations = buildExpectedCodexLabRuntimeObservations(
      plan,
      dispatchRoot,
      'fake-process-757'
    )
  }

  setExistingDispatchRoot(): void {
    const root = dirname(this.plan.runtimePaths.codexHome)
    this.pathKinds.set(root, 'directory')
    this.pathModes.set(root, 0o700)
  }

  async observePath(path: string) {
    this.maybeFail(`observe:${path}`)
    this.calls.push(`observe:${path}`)
    const kind = this.pathKinds.get(path)
    return kind ? { kind, mode: this.pathModes.get(path) ?? 0 } : { kind: 'absent' as const }
  }

  async makeDirectoryExclusive(path: string, mode: number): Promise<void> {
    this.maybeFail(`mkdir:${path}`)
    this.calls.push(`mkdir:${path}:${mode.toString(8)}`)
    if (this.pathKinds.has(path)) {
      throw new Error(`already exists: ${path}`)
    }
    this.pathKinds.set(path, 'directory')
    this.pathModes.set(path, mode)
  }

  async writeFileExclusive(path: string, contents: string, mode: number): Promise<void> {
    this.maybeFail(`write:${path}`)
    this.calls.push(`write:${path}:${mode.toString(8)}`)
    if (this.pathKinds.has(path)) {
      throw new Error(`already exists: ${path}`)
    }
    this.pathKinds.set(path, 'file')
    this.pathModes.set(path, mode)
    this.fileContents.set(path, contents)
  }

  async sha256File(path: string): Promise<string> {
    this.maybeFail(`sha256:${path}`)
    this.calls.push(`sha256:${path}`)
    if (this.configDigestOverride) {
      return this.configDigestOverride
    }
    return createHash('sha256')
      .update(this.fileContents.get(path) ?? '')
      .digest('hex')
  }

  async probeEffectivePolicy(
    request: CodexLabEffectivePolicyProbeRequest
  ): Promise<CodexLabEffectivePolicyObservation> {
    this.maybeFail('probe-effective')
    this.calls.push('probe-effective')
    this.effectiveProbeRequests.push(request)
    return this.effectivePolicy
  }

  async spawnNoShell(request: CodexLabSpawnRequest) {
    this.maybeFail('spawn')
    this.calls.push('spawn')
    this.spawnRequests.push(request)
    return { processId: 'fake-process-757' }
  }

  async probeRuntimeBoundaries(
    request: CodexLabRuntimeProbeRequest
  ): Promise<CodexLabRuntimeObservations> {
    this.maybeFail('probe-runtime')
    this.calls.push('probe-runtime')
    this.runtimeProbeRequests.push(request)
    return this.runtimeObservations
  }

  async terminateProcess(processId: string) {
    this.maybeFail('terminate')
    this.calls.push(`terminate:${processId}`)
    return { evidence: `terminated ${processId}` }
  }

  async removeTree(path: string) {
    this.maybeFail('remove-tree')
    this.calls.push(`remove-tree:${path}`)
    for (const existing of this.pathKinds.keys()) {
      if (existing === path || existing.startsWith(`${path}/`)) {
        this.pathKinds.delete(existing)
        this.pathModes.delete(existing)
        this.fileContents.delete(existing)
      }
    }
    return { evidence: `removed ${path}` }
  }

  configPath(): string {
    return join(this.plan.runtimePaths.codexHome, 'config.toml')
  }

  private maybeFail(operation: string): void {
    if (this.failOperations.has(operation) || this.failOperations.has(operation.split(':')[0])) {
      throw new Error(`fake host failure: ${operation}`)
    }
  }
}
