import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { ProcessResult } from '../../../../shared/child-process/run-process'
import {
  CODEX_LAB_COMMAND_CONFINEMENT_SCHEMA_VERSION,
  type CodexLabCommandConfinementControlEvidence,
  type CodexLabCommandConfinementPreflightInput,
  type CodexLabCommandConfinementProbeReport,
  type CodexLabFreshWriteControlEvidence,
  type CodexLabObservedDirectory,
  type CodexLabObservedPathIdentity,
  type CodexLabProbeIdentityCandidate
} from './codex-lab-command-confinement-contract'
import { sealedHostPlan } from './codex-lab-host-fake.test-support'
import type { SealedCodexLabLaunchPlan } from './codex-lab-launch-contract'
import type { PreparedCodexLabRuntimeLayout } from './codex-lab-runtime-layout'

export const CONFINEMENT_PROBE_SHA256 = 'b'.repeat(64)
export const CONFINEMENT_RUN_NONCE = '7'.repeat(32)
export const CONFINEMENT_TCP_CHALLENGE = '8'.repeat(32)
export const CONFINEMENT_UNIX_CHALLENGE = '9'.repeat(32)
export const CONFINEMENT_TCP_CONNECT_PORT = 43_117
export const CONFINEMENT_OUTSIDE_PARENT =
  '/Users/lab/Library/Application Support/Orca/confinement-controls'

const WORKTREE_READ_SHA256 = 'c'.repeat(64)
const DEVICE = '16777234'

export function confinementProbeCandidate(
  overrides: Partial<CodexLabProbeIdentityCandidate> = {}
): CodexLabProbeIdentityCandidate {
  return {
    path: '/Applications/Orca.app/Contents/Helpers/orca-codex-lab-confinement-probe',
    observedRealPath: '/Applications/Orca.app/Contents/Helpers/orca-codex-lab-confinement-probe',
    kind: 'regular-file',
    executable: true,
    expectedSha256Candidate: CONFINEMENT_PROBE_SHA256,
    observedSha256: CONFINEMENT_PROBE_SHA256,
    device: DEVICE,
    inode: '981247',
    ...overrides
  }
}

export function preparedConfinementLayout(
  plan: SealedCodexLabLaunchPlan = sealedHostPlan(),
  overrides: Partial<PreparedCodexLabRuntimeLayout> = {}
): PreparedCodexLabRuntimeLayout {
  const dispatchRoot = dirname(plan.runtimePaths.codexHome)
  return {
    schemaVersion: 1,
    dispatchId: plan.dispatchId,
    dispatchesRootIdentity: identity('101'),
    dispatchRoot,
    dispatchRootIdentity: identity('102'),
    codexHome: plan.runtimePaths.codexHome,
    codexHomeIdentity: identity('103'),
    fakeHome: plan.runtimePaths.fakeHome,
    fakeHomeIdentity: identity('104'),
    configPath: join(plan.runtimePaths.codexHome, 'config.toml'),
    configIdentity: identity('105'),
    configSha256: plan.receiptInputs.configSha256,
    ...overrides
  }
}

export function confinementControls(
  plan: SealedCodexLabLaunchPlan = sealedHostPlan(),
  prepared: PreparedCodexLabRuntimeLayout = preparedConfinementLayout(plan),
  runNonce = CONFINEMENT_RUN_NONCE
): CodexLabCommandConfinementControlEvidence {
  const basename = `.orca-command-confinement-${plan.dispatchId}-${runNonce}`
  const payloadSha256 = sha256(runNonce)
  const privateTmp = directory('/private/tmp', identity('201'))
  return {
    phase: 'completed-before-sandbox',
    worktreeRead: {
      operation: 'open-read-hash',
      target: join(plan.cwd, 'README.md'),
      observedRealPath: join(plan.cwd, 'README.md'),
      kind: 'regular-file',
      identity: identity('301'),
      sha256: WORKTREE_READ_SHA256,
      result: 'succeeded'
    },
    writes: {
      worktree: writeControl(
        directory(plan.cwd, identity('202')),
        join(plan.cwd, `${basename}.write`),
        payloadSha256
      ),
      codexHome: writeControl(
        directory(prepared.codexHome, prepared.codexHomeIdentity),
        join(prepared.codexHome, `${basename}.write`),
        payloadSha256
      ),
      fakeHome: writeControl(
        directory(prepared.fakeHome, prepared.fakeHomeIdentity),
        join(prepared.fakeHome, `${basename}.write`),
        payloadSha256
      ),
      privateTmp: writeControl(
        privateTmp,
        join('/private/tmp', `${basename}.write`),
        payloadSha256
      ),
      outsideRoot: writeControl(
        directory(CONFINEMENT_OUTSIDE_PARENT, identity('203')),
        join(CONFINEMENT_OUTSIDE_PARENT, `${basename}.write`),
        payloadSha256
      )
    },
    network: {
      tcpConnect: {
        host: '127.0.0.1',
        port: CONFINEMENT_TCP_CONNECT_PORT,
        listener: 'confirmed-live',
        challengeToken: CONFINEMENT_TCP_CHALLENGE,
        challengeSha256: sha256(CONFINEMENT_TCP_CHALLENGE),
        connect: 'succeeded',
        challengeExchange: 'succeeded'
      },
      tcpBind: {
        host: '127.0.0.1',
        port: 0,
        bind: 'succeeded',
        listen: 'succeeded',
        close: 'succeeded'
      },
      unixConnect: {
        path: plan.gatewaySocketPath,
        listener: 'confirmed-live',
        challengeToken: CONFINEMENT_UNIX_CHALLENGE,
        challengeSha256: sha256(CONFINEMENT_UNIX_CHALLENGE),
        connect: 'succeeded',
        challengeExchange: 'succeeded'
      },
      unixBind: {
        operation: 'bind-listen-close-unlink',
        parent: privateTmp,
        path: join('/private/tmp', `${basename}.sock`),
        targetBefore: 'absent',
        bind: 'succeeded',
        listen: 'succeeded',
        close: 'succeeded',
        unlink: 'succeeded',
        targetAfter: 'absent'
      }
    }
  }
}

export function confinementInput(
  overrides: Partial<CodexLabCommandConfinementPreflightInput> = {}
): CodexLabCommandConfinementPreflightInput {
  const plan = overrides.plan ?? sealedHostPlan()
  const preparedLayout = overrides.preparedLayout ?? preparedConfinementLayout(plan)
  const runNonce = overrides.runNonce ?? CONFINEMENT_RUN_NONCE
  return {
    plan,
    preparedLayout,
    probeIdentityCandidate: confinementProbeCandidate(),
    runNonce,
    controls: confinementControls(plan, preparedLayout, runNonce),
    ...overrides
  }
}

export function expectedConfinementProbeReport(
  input: CodexLabCommandConfinementPreflightInput = confinementInput()
): CodexLabCommandConfinementProbeReport {
  const { plan, preparedLayout, probeIdentityCandidate: probe, controls } = input
  const deniedWrite = (root: string, target: string) => ({
    root,
    target,
    syscall: 'open(O_CREAT|O_EXCL|O_WRONLY)' as const,
    result: 'denied-by-sandbox' as const,
    errno: 'EPERM' as const
  })
  return {
    schemaVersion: CODEX_LAB_COMMAND_CONFINEMENT_SCHEMA_VERSION,
    probe: {
      path: probe.path,
      sha256: probe.observedSha256,
      device: probe.device,
      inode: probe.inode,
      identityTrust: 'candidate-only'
    },
    layout: {
      dispatchId: preparedLayout.dispatchId,
      dispatchRoot: preparedLayout.dispatchRoot,
      dispatchRootIdentity: preparedLayout.dispatchRootIdentity,
      codexHomeIdentity: preparedLayout.codexHomeIdentity,
      fakeHomeIdentity: preparedLayout.fakeHomeIdentity,
      configIdentity: preparedLayout.configIdentity,
      configSha256: preparedLayout.configSha256
    },
    worktree: {
      identity: plan.worktreeIdentity,
      path: plan.cwd,
      read: {
        target: controls.worktreeRead.target,
        sha256: controls.worktreeRead.sha256,
        syscall: 'open(O_RDONLY)',
        result: 'succeeded'
      },
      write: deniedWrite(plan.cwd, controls.writes.worktree.target)
    },
    writes: {
      codexHome: deniedWrite(plan.runtimePaths.codexHome, controls.writes.codexHome.target),
      fakeHome: deniedWrite(plan.runtimePaths.fakeHome, controls.writes.fakeHome.target),
      privateTmp: deniedWrite('/private/tmp', controls.writes.privateTmp.target),
      outsideRoot: deniedWrite(
        controls.writes.outsideRoot.parent.path,
        controls.writes.outsideRoot.target
      )
    },
    network: {
      tcpConnect: {
        host: '127.0.0.1',
        port: controls.network.tcpConnect.port,
        challengeSha256: controls.network.tcpConnect.challengeSha256,
        syscall: 'connect(AF_INET,SOCK_STREAM)',
        result: 'denied-by-sandbox',
        errno: 'EPERM'
      },
      tcpBind: {
        host: '127.0.0.1',
        port: 0,
        syscall: 'bind(AF_INET,SOCK_STREAM)',
        result: 'denied-by-sandbox',
        errno: 'EPERM'
      },
      unixConnect: {
        path: plan.gatewaySocketPath,
        challengeSha256: controls.network.unixConnect.challengeSha256,
        syscall: 'connect(AF_UNIX,SOCK_STREAM)',
        result: 'denied-by-sandbox',
        errno: 'EPERM'
      },
      unixBind: {
        path: controls.network.unixBind.path,
        syscall: 'bind(AF_UNIX,SOCK_STREAM)',
        result: 'denied-by-sandbox',
        errno: 'EPERM'
      }
    }
  }
}

function directory(
  path: string,
  observedIdentity: CodexLabObservedPathIdentity
): CodexLabObservedDirectory {
  return {
    path,
    observedRealPath: path,
    kind: 'directory',
    ownedByCurrentUser: true,
    identity: observedIdentity
  }
}

function writeControl(
  parent: CodexLabObservedDirectory,
  target: string,
  payloadSha256: string
): CodexLabFreshWriteControlEvidence {
  return {
    operation: 'exclusive-create-write-read-unlink',
    parent,
    target,
    targetBefore: 'absent',
    exclusiveCreate: 'succeeded',
    readBack: 'succeeded',
    payloadSha256,
    unlink: 'succeeded',
    targetAfter: 'absent'
  }
}

function identity(inode: string): CodexLabObservedPathIdentity {
  return { device: DEVICE, inode }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function successfulProbeResult(stdout: string): ProcessResult {
  return {
    code: 0,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
    outputTruncated: false
  }
}
