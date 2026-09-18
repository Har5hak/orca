import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { CodexLabCommandConfinementPreflightInput } from './codex-lab-command-confinement-contract'
import {
  createExactRootCleanupLease,
  type ExactRootCleanupLease
} from './codex-lab-command-confinement-host-cleanup.test-support'
import { confinementInput } from './codex-lab-command-confinement.test-support'
import {
  CODEX_LAB_RUNTIME_ROOT,
  CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
  LAB_READONLY_SUPERVISED_PROFILE_ID,
  type CodexLabLaunchFacts
} from './codex-lab-launch-contract'
import { buildSealedCodexLabLaunchPlan } from './codex-sealed-launch-plan'

type HostCompatibilityOwnership = {
  cleanupLease?: ExactRootCleanupLease
}

export type CodexLabHostCompatibilityFixture = Readonly<{
  input: CodexLabCommandConfinementPreflightInput
  dispatchRoot: string
}>

export async function withHostCompatibilityInput<T>(
  binaryPath: string,
  executeFixture: (fixture: CodexLabHostCompatibilityFixture) => Promise<T> | T
): Promise<T> {
  const ownership: HostCompatibilityOwnership = {}
  try {
    const input = materializeHostCompatibilityInput(binaryPath, ownership)
    const dispatchRoot = ownership.cleanupLease?.dispatchRoot
    if (!dispatchRoot) {
      throw new Error('host compatibility dispatch root identity was not captured')
    }
    return await executeFixture(Object.freeze({ input, dispatchRoot }))
  } finally {
    ownership.cleanupLease?.cleanup()
  }
}

function materializeHostCompatibilityInput(
  binaryPath: string,
  ownership: HostCompatibilityOwnership
): CodexLabCommandConfinementPreflightInput {
  const binary = statSync(binaryPath)
  if (!binary.isFile() || (binary.mode & 0o111) === 0) {
    throw new Error('host compatibility binary must be an executable regular file')
  }
  const worktreePath = realpathSync(process.cwd())
  const dispatchId = `compat-${randomUUID()}`
  const binarySha256 = fileSha256(binaryPath)
  const facts: CodexLabLaunchFacts = {
    platform: 'darwin',
    profile: LAB_READONLY_SUPERVISED_PROFILE_ID,
    adapter: CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
    dispatch: {
      id: dispatchId,
      runtimeRoot: CODEX_LAB_RUNTIME_ROOT,
      codexHomeState: 'absent',
      fakeHomeState: 'absent'
    },
    worktree: {
      identity: `wt2:local:${dispatchId}`,
      expectedPath: worktreePath,
      observedPath: worktreePath,
      observedRealPath: worktreePath,
      kind: 'directory',
      disposable: true
    },
    gateway: {
      socketPath: join(CODEX_LAB_RUNTIME_ROOT, 'dispatches', dispatchId, 'gateway.sock'),
      credential: `lgw1_${'g'.repeat(43)}`
    },
    binary: {
      path: binaryPath,
      observedRealPath: binaryPath,
      kind: 'regular-file',
      executable: true,
      pinnedSha256: binarySha256,
      observedSha256: binarySha256
    },
    authentication: {
      loginMethod: 'chatgpt',
      expectedWorkspaceId: '018f47a2-9d72-7cc1-b046-7a2868411f42',
      observedWorkspaceId: '018f47a2-9d72-7cc1-b046-7a2868411f42',
      subscription: { status: 'active', scope: 'workspace', unambiguous: true },
      authJson: { state: 'absent' }
    },
    ambientEnv: {}
  }
  const plan = buildSealedCodexLabLaunchPlan(facts)
  const plannedDispatchRoot = dirname(plan.runtimePaths.codexHome)
  const dispatchesRoot = dirname(plannedDispatchRoot)
  mkdirSync(dispatchesRoot, { recursive: true, mode: 0o700 })
  const cleanupLease = createExactRootCleanupLease(dispatchId)
  ownership.cleanupLease = cleanupLease
  const dispatchRoot = cleanupLease.dispatchRoot
  if (dispatchRoot !== plannedDispatchRoot) {
    throw new Error('host compatibility cleanup root differs from the sealed launch plan')
  }
  mkdirSync(plan.runtimePaths.codexHome, { mode: 0o700 })
  cleanupLease.record(plan.runtimePaths.codexHome, 'directory')
  mkdirSync(plan.runtimePaths.fakeHome, { mode: 0o700 })
  cleanupLease.record(plan.runtimePaths.fakeHome, 'directory')
  chmodSync(dispatchRoot, 0o700)
  chmodSync(plan.runtimePaths.codexHome, 0o700)
  chmodSync(plan.runtimePaths.fakeHome, 0o700)
  const configPath = join(plan.runtimePaths.codexHome, 'config.toml')
  writeFileSync(configPath, plan.configToml, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  cleanupLease.record(configPath, 'file')

  const probePath = realpathSync('/usr/bin/true')
  const probe = statSync(probePath)
  if (!probe.isFile() || (probe.mode & 0o111) === 0) {
    throw new Error('host compatibility probe must be an executable regular file')
  }
  const probeSha256 = fileSha256(probePath)
  return confinementInput({
    plan,
    preparedLayout: {
      schemaVersion: 1,
      dispatchId,
      dispatchesRootIdentity: identityAt(dispatchesRoot),
      dispatchRoot,
      dispatchRootIdentity: identityAt(dispatchRoot),
      codexHome: plan.runtimePaths.codexHome,
      codexHomeIdentity: identityAt(plan.runtimePaths.codexHome),
      fakeHome: plan.runtimePaths.fakeHome,
      fakeHomeIdentity: identityAt(plan.runtimePaths.fakeHome),
      configPath,
      configIdentity: identityAt(configPath),
      configSha256: plan.receiptInputs.configSha256
    },
    probeIdentityCandidate: {
      path: probePath,
      observedRealPath: probePath,
      kind: 'regular-file',
      executable: true,
      expectedSha256Candidate: probeSha256,
      observedSha256: probeSha256,
      ...identityAt(probePath)
    }
  })
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function identityAt(path: string): Readonly<{ device: string; inode: string }> {
  const stat = lstatSync(path)
  return { device: String(stat.dev), inode: String(stat.ino) }
}
