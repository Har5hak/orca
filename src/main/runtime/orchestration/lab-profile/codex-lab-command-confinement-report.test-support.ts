import {
  CODEX_LAB_COMMAND_CONFINEMENT_SCHEMA_VERSION,
  type CodexLabCommandConfinementPreflightInput,
  type CodexLabCommandConfinementProbeReport
} from './codex-lab-command-confinement-contract'

export function buildExpectedConfinementProbeReport(
  input: CodexLabCommandConfinementPreflightInput
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
        result: 'succeeded'
      },
      unixConnectDenied: {
        path: controls.network.unixConnectDenied.path,
        challengeSha256: controls.network.unixConnectDenied.challengeSha256,
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
