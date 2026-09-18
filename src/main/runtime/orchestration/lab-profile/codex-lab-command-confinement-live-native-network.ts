import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import type {
  CodexLabCommandConfinementControlEvidence,
  CodexLabCommandConfinementProbeReport,
  CodexLabObservedDirectory,
  CodexLabObservedPathIdentity
} from './codex-lab-command-confinement-contract'
import type { CodexLabCommandConfinementTargets } from './codex-lab-command-confinement-preflight'
import {
  assertNativeCodexLabTrustedDirectoryUnchanged,
  observeNativeCodexLabTrustedDirectory,
  sameNativeCodexLabPathIdentity
} from './codex-lab-command-confinement-live-native-file-controls'
import {
  assertNativeCodexLabSocketIdentity,
  closeNativeCodexLabServer,
  createNativeCodexLabChallengeServer,
  exchangeNativeCodexLabChallenge,
  exerciseNativeCodexLabTcpBind,
  exerciseNativeCodexLabUnixBind,
  listenNativeCodexLabServer,
  nativeCodexLabSocketIdentity,
  unlinkExactNativeCodexLabSocket
} from './codex-lab-command-confinement-live-native-network-controls'
import type { SealedCodexLabLaunchPlan } from './codex-lab-launch-contract'
import type { PreparedCodexLabRuntimeLayout } from './codex-lab-runtime-layout'

const LOOPBACK = '127.0.0.1' as const
export type NativeCodexLabNetworkSession = Readonly<{
  network: CodexLabCommandConfinementControlEvidence['network']
  assertPostExecution(report: CodexLabCommandConfinementProbeReport): void
  close(): Promise<void>
}>

export async function openNativeCodexLabNetworkSession(args: {
  plan: SealedCodexLabLaunchPlan
  preparedLayout: PreparedCodexLabRuntimeLayout
  targets: CodexLabCommandConfinementTargets
  privateTmp: CodexLabObservedDirectory
  tcpChallenge: string
  unixChallenge: string
  deniedUnixChallenge: string
}): Promise<NativeCodexLabNetworkSession> {
  const gatewayParent = observeNativeCodexLabTrustedDirectory(args.preparedLayout.dispatchRoot)
  if (
    !sameNativeCodexLabPathIdentity(
      gatewayParent.identity,
      args.preparedLayout.dispatchRootIdentity
    )
  ) {
    throw new Error('gateway parent identity differs from the prepared layout')
  }
  assertNativeCodexLabTrustedDirectoryUnchanged(args.privateTmp)
  if (
    existsSync(args.plan.gatewaySocketPath) ||
    existsSync(args.targets.unixConnectDenied) ||
    existsSync(args.targets.unixBind)
  ) {
    throw new Error('confinement Unix socket target is not fresh')
  }

  const tcpBind = await exerciseNativeCodexLabTcpBind()
  const unixBind = await exerciseNativeCodexLabUnixBind(args.targets.unixBind, args.privateTmp)
  const tcp = createNativeCodexLabChallengeServer(args.tcpChallenge)
  const unix = createNativeCodexLabChallengeServer(args.unixChallenge)
  const deniedUnix = createNativeCodexLabChallengeServer(args.deniedUnixChallenge)
  let gatewayIdentity: CodexLabObservedPathIdentity | undefined
  let deniedUnixIdentity: CodexLabObservedPathIdentity | undefined
  try {
    await listenNativeCodexLabServer(tcp.server, { host: LOOPBACK, port: 0, exclusive: true })
    const address = tcp.server.address()
    if (!address || typeof address === 'string' || address.address !== LOOPBACK) {
      throw new Error('trusted TCP control listener did not bind exact loopback')
    }
    await listenNativeCodexLabServer(unix.server, {
      path: args.plan.gatewaySocketPath,
      exclusive: true
    })
    gatewayIdentity = nativeCodexLabSocketIdentity(args.plan.gatewaySocketPath)
    await listenNativeCodexLabServer(deniedUnix.server, {
      path: args.targets.unixConnectDenied,
      exclusive: true
    })
    deniedUnixIdentity = nativeCodexLabSocketIdentity(args.targets.unixConnectDenied)
    await exchangeNativeCodexLabChallenge({ host: LOOPBACK, port: address.port }, args.tcpChallenge)
    await exchangeNativeCodexLabChallenge({ path: args.plan.gatewaySocketPath }, args.unixChallenge)
    await exchangeNativeCodexLabChallenge(
      { path: args.targets.unixConnectDenied },
      args.deniedUnixChallenge
    )

    const network = deepFreeze({
      tcpConnect: {
        host: LOOPBACK,
        port: address.port,
        listener: 'confirmed-live' as const,
        challengeToken: args.tcpChallenge,
        challengeSha256: sha256(args.tcpChallenge),
        connect: 'succeeded' as const,
        challengeExchange: 'succeeded' as const
      },
      tcpBind,
      unixConnect: {
        path: args.plan.gatewaySocketPath,
        listener: 'confirmed-live' as const,
        challengeToken: args.unixChallenge,
        challengeSha256: sha256(args.unixChallenge),
        connect: 'succeeded' as const,
        challengeExchange: 'succeeded' as const
      },
      unixConnectDenied: {
        path: args.targets.unixConnectDenied,
        listener: 'confirmed-live' as const,
        challengeToken: args.deniedUnixChallenge,
        challengeSha256: sha256(args.deniedUnixChallenge),
        connect: 'succeeded' as const,
        challengeExchange: 'succeeded' as const
      },
      unixBind
    })
    let closed = false
    return Object.freeze({
      network,
      assertPostExecution(report: CodexLabCommandConfinementProbeReport): void {
        if (closed) {
          throw new Error('trusted confinement listeners are already closed')
        }
        if (
          tcp.state.error ||
          unix.state.error ||
          deniedUnix.state.error ||
          tcp.state.accepted !== 1 ||
          tcp.state.exchanged !== 1 ||
          unix.state.accepted !== 2 ||
          unix.state.exchanged !== 2 ||
          deniedUnix.state.accepted !== 1 ||
          deniedUnix.state.exchanged !== 1 ||
          report.network.tcpConnect.result !== 'denied-by-sandbox' ||
          report.network.unixConnect.result !== 'succeeded' ||
          report.network.unixConnectDenied.result !== 'denied-by-sandbox'
        ) {
          throw new Error('trusted listener custody did not match sandbox network evidence')
        }
        assertNativeCodexLabSocketIdentity(args.plan.gatewaySocketPath, gatewayIdentity!)
        assertNativeCodexLabSocketIdentity(args.targets.unixConnectDenied, deniedUnixIdentity!)
        assertNativeCodexLabTrustedDirectoryUnchanged(gatewayParent)
      },
      async close(): Promise<void> {
        if (closed) {
          return
        }
        closed = true
        const failures: unknown[] = []
        for (const server of [tcp.server, unix.server, deniedUnix.server]) {
          try {
            await closeNativeCodexLabServer(server)
          } catch (error) {
            failures.push(error)
          }
        }
        try {
          unlinkExactNativeCodexLabSocket(
            args.plan.gatewaySocketPath,
            gatewayIdentity!,
            gatewayParent
          )
        } catch (error) {
          failures.push(error)
        }
        try {
          unlinkExactNativeCodexLabSocket(
            args.targets.unixConnectDenied,
            deniedUnixIdentity!,
            args.privateTmp
          )
        } catch (error) {
          failures.push(error)
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, 'trusted confinement listener cleanup failed')
        }
      }
    })
  } catch (error) {
    const failures: unknown[] = [error]
    for (const server of [tcp.server, unix.server, deniedUnix.server]) {
      try {
        await closeNativeCodexLabServer(server)
      } catch (cleanupError) {
        failures.push(cleanupError)
      }
    }
    if (gatewayIdentity) {
      try {
        unlinkExactNativeCodexLabSocket(args.plan.gatewaySocketPath, gatewayIdentity, gatewayParent)
      } catch (cleanupError) {
        failures.push(cleanupError)
      }
    }
    if (deniedUnixIdentity) {
      try {
        unlinkExactNativeCodexLabSocket(
          args.targets.unixConnectDenied,
          deniedUnixIdentity,
          args.privateTmp
        )
      } catch (cleanupError) {
        failures.push(cleanupError)
      }
    }
    throw failures.length === 1
      ? error
      : new AggregateError(failures, 'listener setup and exact cleanup both failed')
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function deepFreeze<T extends object>(value: T): Readonly<T> {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') {
      deepFreeze(nested)
    }
  }
  return Object.freeze(value)
}
