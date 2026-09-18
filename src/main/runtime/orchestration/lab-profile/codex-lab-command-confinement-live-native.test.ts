import { existsSync, lstatSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { createConnection } from 'node:net'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildCodexLabCommandConfinementTargets,
  runCodexLabCommandConfinementPreflight
} from './codex-lab-command-confinement-preflight'
import type { CodexLabTrustedControlSession } from './codex-lab-command-confinement-live-contract'
import {
  isValidCodexLabHostReadinessReceipt,
  prepareVerifiedCodexLabLaunch
} from './codex-lab-command-confinement-live'
import { createNativeCodexLabLiveConfinementHost } from './codex-lab-command-confinement-live-native'
import {
  expectedConfinementProbeReport,
  successfulProbeResult
} from './codex-lab-command-confinement.test-support'
import { withHostCompatibilityInput } from './codex-lab-command-confinement-host.test-support'

describe('native Codex laboratory trusted control session', () => {
  it.runIf(process.platform === 'darwin')(
    'collects real fresh controls and keeps exact Unix listener custody through proof',
    async () => {
      const outsideRoot = realpathSync(userInfo().homedir)
      let session: CodexLabTrustedControlSession | undefined
      try {
        await withHostCompatibilityInput(realpathSync(process.execPath), async ({ input }) => {
          const host = createNativeCodexLabLiveConfinementHost()
          const runNonce = 'a'.repeat(32)
          const targets = buildCodexLabCommandConfinementTargets(
            input.plan.dispatchId,
            runNonce,
            input.plan.cwd,
            input.plan.runtimePaths,
            outsideRoot
          )
          session = await host.openControlSession({
            plan: input.plan,
            preparedLayout: input.preparedLayout,
            worktreeReadTarget: join(input.plan.cwd, '.git'),
            outsideWriteRoot: outsideRoot,
            runNonce,
            targets
          })
          const liveInput = {
            ...input,
            runNonce,
            controls: session.controls
          }
          const candidate = await runCodexLabCommandConfinementPreflight(liveInput, async () => {
            await exchangeUnixChallenge(
              input.plan.gatewaySocketPath,
              session!.controls.network.unixConnect.challengeToken
            )
            return successfulProbeResult(JSON.stringify(expectedConfinementProbeReport(liveInput)))
          })
          session.assertPostExecution(candidate.probeReport)
          expect(session.controls.writes.privateTmp.parent).toMatchObject({
            path: '/private/tmp',
            custody: 'trusted-local-host'
          })
          await session.close()
          expect(existsSync(input.plan.gatewaySocketPath)).toBe(false)
          for (const target of Object.values(targets)) {
            expect(existsSync(target)).toBe(false)
          }
        })
      } finally {
        await session?.close()
      }
    }
  )

  it.runIf(
    process.platform === 'darwin' && process.env.ORCA_RUN_CODEX_CONFINEMENT_LIVE_HOST_PROOF === '1'
  )('proves the installed Codex sandbox and issues a valid host receipt', async () => {
    const binary = process.env.ORCA_CODEX_COMPATIBILITY_BINARY
    if (!binary) {
      throw new Error('ORCA_CODEX_COMPATIBILITY_BINARY is required for live host proof')
    }
    await withHostCompatibilityInput(realpathSync(binary), async ({ input }) => {
      const nativeHost = createNativeCodexLabLiveConfinementHost()
      let executionError: unknown
      const host = {
        ...nativeHost,
        async executeExact(spec: Parameters<typeof nativeHost.executeExact>[0]) {
          try {
            return await nativeHost.executeExact(spec)
          } catch (error) {
            executionError = error
            throw error
          }
        }
      }
      let prepared
      try {
        prepared = await prepareVerifiedCodexLabLaunch(
          {
            plan: input.plan,
            preparedLayout: input.preparedLayout
          },
          host
        )
      } catch (error) {
        if (executionError) {
          throw new AggregateError([error, executionError], 'live host proof execution failed')
        }
        throw error
      }
      expect(isValidCodexLabHostReadinessReceipt(prepared.receipt)).toBe(true)
      expect(prepared.receipt).toMatchObject({
        controlTrust: 'trusted-local-host',
        probeIdentityTrust: 'host-re-attested',
        dispatchChannel: 'exact-unix-socket-permitted',
        arbitraryNetwork: 'denied',
        forbiddenWrites: 'denied',
        worktreeRead: 'verified',
        processTreeTermination: 'verified'
      })
    })
  })

  it.runIf(process.platform === 'darwin')(
    'refuses a replaced sentinel after execution and cleans only the test-owned symlink',
    async () => {
      const outsideRoot = realpathSync(userInfo().homedir)
      await withHostCompatibilityInput(realpathSync(process.execPath), async ({ input }) => {
        const host = createNativeCodexLabLiveConfinementHost()
        const runNonce = 'b'.repeat(32)
        const targets = buildCodexLabCommandConfinementTargets(
          input.plan.dispatchId,
          runNonce,
          input.plan.cwd,
          input.plan.runtimePaths,
          outsideRoot
        )
        const session = await host.openControlSession({
          plan: input.plan,
          preparedLayout: input.preparedLayout,
          worktreeReadTarget: join(input.plan.cwd, '.git'),
          outsideWriteRoot: outsideRoot,
          runNonce,
          targets
        })
        let ownedSymlink: Readonly<{ device: bigint; inode: bigint }> | undefined
        let primaryError: unknown
        try {
          const liveInput = { ...input, runNonce, controls: session.controls }
          const candidate = await runCodexLabCommandConfinementPreflight(liveInput, async () => {
            await exchangeUnixChallenge(
              input.plan.gatewaySocketPath,
              session.controls.network.unixConnect.challengeToken
            )
            return successfulProbeResult(JSON.stringify(expectedConfinementProbeReport(liveInput)))
          })
          symlinkSync('/private/tmp/orca-confinement-nonexistent', targets.privateTmpWrite)
          const link = lstatSync(targets.privateTmpWrite, { bigint: true })
          ownedSymlink = { device: link.dev, inode: link.ino }

          expect(() => session.assertPostExecution(candidate.probeReport)).toThrow(
            'confinement proof target was replaced or left behind'
          )
        } catch (error) {
          primaryError = error
        }
        let cleanupError: unknown
        try {
          if (ownedSymlink) {
            const observed = lstatSync(targets.privateTmpWrite, { bigint: true })
            if (
              !observed.isSymbolicLink() ||
              observed.dev !== ownedSymlink.device ||
              observed.ino !== ownedSymlink.inode
            ) {
              throw new Error('refusing to clean a replaced test-owned confinement symlink')
            }
            unlinkSync(targets.privateTmpWrite)
          }
          await session.close()
        } catch (error) {
          cleanupError = error
        }
        if (primaryError && cleanupError) {
          throw new AggregateError(
            [primaryError, cleanupError],
            'adversarial sentinel test and exact cleanup both failed'
          )
        }
        if (primaryError) {
          throw primaryError
        }
        if (cleanupError) {
          throw cleanupError
        }
      })
    }
  )

  it.runIf(process.platform === 'darwin')(
    'refuses a host caller that substitutes a different worktree read target',
    async () => {
      const outsideRoot = realpathSync(userInfo().homedir)
      await withHostCompatibilityInput(realpathSync(process.execPath), async ({ input }) => {
        const host = createNativeCodexLabLiveConfinementHost()
        const runNonce = 'c'.repeat(32)
        const targets = buildCodexLabCommandConfinementTargets(
          input.plan.dispatchId,
          runNonce,
          input.plan.cwd,
          input.plan.runtimePaths,
          outsideRoot
        )

        await expect(
          host.openControlSession({
            plan: input.plan,
            preparedLayout: input.preparedLayout,
            worktreeReadTarget: join(input.plan.cwd, 'README.md'),
            outsideWriteRoot: outsideRoot,
            runNonce,
            targets
          })
        ).rejects.toThrow('confinement read proof must use the linked-worktree .git file')
      })
    }
  )
})

function exchangeUnixChallenge(path: string, challenge: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = createConnection({ path })
    socket.once('connect', () => socket.end(challenge))
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.once('error', reject)
    socket.once('end', () => {
      if (Buffer.concat(chunks).toString('utf8') === challenge) {
        resolve()
      } else {
        reject(new Error('Unix challenge response mismatched'))
      }
    })
  })
}
