import type { ProcessSpec } from '../../../../shared/child-process/run-process'
import {
  CODEX_LAB_COMMAND_CONFINEMENT_MAX_OUTPUT_BYTES,
  CODEX_LAB_COMMAND_CONFINEMENT_SCHEMA_VERSION,
  CODEX_LAB_COMMAND_CONFINEMENT_TIMEOUT_MS,
  type CodexLabCommandConfinementControlEvidence,
  type CodexLabCommandConfinementPreflightInput,
  type CodexLabCommandConfinementProbeReport,
  type CodexLabProbeIdentityCandidate
} from './codex-lab-command-confinement-contract'
import type { CodexLabCommandConfinementTargets } from './codex-lab-command-confinement-preflight'
import { CODEX_LAB_PERMISSION_PROFILE_ID } from './codex-lab-launch-policy'
import type { PreparedCodexLabRuntimeLayout } from './codex-lab-runtime-layout'

const LOOPBACK_HOST = '127.0.0.1' as const
const PRIVATE_TMP_ROOT = '/private/tmp' as const

export function buildCodexLabCommandConfinementProcessSpec(
  plan: CodexLabCommandConfinementPreflightInput['plan'],
  prepared: PreparedCodexLabRuntimeLayout,
  probe: CodexLabProbeIdentityCandidate,
  controls: CodexLabCommandConfinementControlEvidence,
  targets: CodexLabCommandConfinementTargets,
  runNonce: string
): ProcessSpec {
  const options = (...pairs: readonly (readonly [string, string])[]): string[] => pairs.flat()
  return Object.freeze({
    program: plan.executable,
    args: Object.freeze([
      'sandbox',
      '--include-managed-config',
      '-P',
      CODEX_LAB_PERMISSION_PROFILE_ID,
      '-C',
      plan.cwd,
      '--',
      probe.path,
      ...probe.argvPrefix,
      ...options(
        ['--schema-version', String(CODEX_LAB_COMMAND_CONFINEMENT_SCHEMA_VERSION)],
        ['--run-nonce', runNonce],
        ['--probe-path', probe.path],
        ['--worktree-identity', plan.worktreeIdentity],
        ['--worktree-path', plan.cwd],
        ['--worktree-read-target', controls.worktreeRead.target],
        ['--worktree-read-sha256', controls.worktreeRead.sha256],
        ['--worktree-write-target', targets.worktreeWrite],
        ['--write-payload', runNonce],
        ['--dispatch-root', prepared.dispatchRoot],
        ['--config-path', prepared.configPath],
        ['--config-sha256', prepared.configSha256],
        ['--codex-home', plan.runtimePaths.codexHome],
        ['--codex-home-write-target', targets.codexHomeWrite],
        ['--fake-home', plan.runtimePaths.fakeHome],
        ['--fake-home-write-target', targets.fakeHomeWrite],
        ['--private-tmp-write-target', targets.privateTmpWrite],
        ['--outside-root-write-target', targets.outsideRootWrite],
        ['--tcp-connect-host', LOOPBACK_HOST],
        ['--tcp-connect-port', String(controls.network.tcpConnect.port)],
        ['--tcp-connect-challenge', controls.network.tcpConnect.challengeToken],
        ['--tcp-bind-host', LOOPBACK_HOST],
        ['--tcp-bind-port', '0'],
        ['--unix-connect-path', plan.gatewaySocketPath],
        ['--unix-connect-challenge', controls.network.unixConnect.challengeToken],
        ['--unix-connect-denied-path', targets.unixConnectDenied],
        ['--unix-connect-denied-challenge', controls.network.unixConnectDenied.challengeToken],
        ['--unix-bind-path', targets.unixBind]
      )
    ]),
    cwd: plan.cwd,
    env: Object.freeze({
      CODEX_HOME: plan.runtimePaths.codexHome,
      HOME: plan.runtimePaths.fakeHome
    }),
    timeoutMs: CODEX_LAB_COMMAND_CONFINEMENT_TIMEOUT_MS,
    maxOutputBytes: CODEX_LAB_COMMAND_CONFINEMENT_MAX_OUTPUT_BYTES,
    terminationBarrier: true
  })
}

export function buildExpectedCodexLabCommandConfinementReport(
  plan: CodexLabCommandConfinementPreflightInput['plan'],
  prepared: PreparedCodexLabRuntimeLayout,
  probe: CodexLabProbeIdentityCandidate,
  controls: CodexLabCommandConfinementControlEvidence,
  targets: CodexLabCommandConfinementTargets
): CodexLabCommandConfinementProbeReport {
  const deniedWrite = (root: string, target: string) =>
    Object.freeze({
      root,
      target,
      syscall: 'open(O_CREAT|O_EXCL|O_WRONLY)' as const,
      result: 'denied-by-sandbox' as const,
      errno: 'EPERM' as const
    })
  return deepFreeze({
    schemaVersion: CODEX_LAB_COMMAND_CONFINEMENT_SCHEMA_VERSION,
    probe: {
      path: probe.path,
      sha256: probe.observedSha256,
      device: probe.device,
      inode: probe.inode,
      identityTrust: 'candidate-only' as const
    },
    layout: {
      dispatchId: prepared.dispatchId,
      dispatchRoot: prepared.dispatchRoot,
      dispatchRootIdentity: prepared.dispatchRootIdentity,
      codexHomeIdentity: prepared.codexHomeIdentity,
      fakeHomeIdentity: prepared.fakeHomeIdentity,
      configIdentity: prepared.configIdentity,
      configSha256: prepared.configSha256
    },
    worktree: {
      identity: plan.worktreeIdentity,
      path: plan.cwd,
      read: {
        target: controls.worktreeRead.target,
        sha256: controls.worktreeRead.sha256,
        syscall: 'open(O_RDONLY)' as const,
        result: 'succeeded' as const
      },
      write: deniedWrite(plan.cwd, targets.worktreeWrite)
    },
    writes: {
      codexHome: deniedWrite(plan.runtimePaths.codexHome, targets.codexHomeWrite),
      fakeHome: deniedWrite(plan.runtimePaths.fakeHome, targets.fakeHomeWrite),
      privateTmp: deniedWrite(PRIVATE_TMP_ROOT, targets.privateTmpWrite),
      outsideRoot: deniedWrite(controls.writes.outsideRoot.parent.path, targets.outsideRootWrite)
    },
    network: {
      tcpConnect: {
        host: LOOPBACK_HOST,
        port: controls.network.tcpConnect.port,
        challengeSha256: controls.network.tcpConnect.challengeSha256,
        syscall: 'connect(AF_INET,SOCK_STREAM)' as const,
        result: 'denied-by-sandbox' as const,
        errno: 'EPERM' as const
      },
      tcpBind: {
        host: LOOPBACK_HOST,
        port: 0 as const,
        syscall: 'bind(AF_INET,SOCK_STREAM)' as const,
        result: 'denied-by-sandbox' as const,
        errno: 'EPERM' as const
      },
      unixConnect: {
        path: plan.gatewaySocketPath,
        challengeSha256: controls.network.unixConnect.challengeSha256,
        syscall: 'connect(AF_UNIX,SOCK_STREAM)' as const,
        result: 'succeeded' as const
      },
      unixConnectDenied: {
        path: targets.unixConnectDenied,
        challengeSha256: controls.network.unixConnectDenied.challengeSha256,
        syscall: 'connect(AF_UNIX,SOCK_STREAM)' as const,
        result: 'denied-by-sandbox' as const,
        errno: 'EPERM' as const
      },
      unixBind: {
        path: targets.unixBind,
        syscall: 'bind(AF_UNIX,SOCK_STREAM)' as const,
        result: 'denied-by-sandbox' as const,
        errno: 'EPERM' as const
      }
    }
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
