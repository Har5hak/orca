import { join } from 'node:path'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { CODEX_LAB_RUNTIME_ROOT } from '../../../../orchestration/lab-profile/codex-lab-launch-contract'
import {
  mintLabGatewayPolicy,
  type LabGatewayBinding,
  type LabGatewayPolicy
} from '../../../../orchestration/lab-profile/dispatch-gateway-policy'
import { createLabGatewayLifecycleResolver } from '../../../../orchestration/lab-profile/dispatch-gateway-lifecycle-resolver'
import { createOrcaLabGatewayRpcInvoker } from '../../../../orchestration/lab-profile/dispatch-gateway-rpc-invoker'
import {
  LabDispatchGatewayServer,
  type LabDispatchGatewayServerOptions,
  type LabGatewayServerReceipt
} from '../../../../orchestration/lab-profile/dispatch-gateway-server'
import type { StructuredWorkerIdentity } from '../../../../structured-worker-identity'
import type { PreparedLocalLabWorkerStart } from './local-lab-worker-start'
import type { LocalCodexLabGatewayAuthority } from './local-codex-lab-launch-authority'

type LocalCodexLabGatewayServer = Readonly<{
  start(): Promise<LabGatewayServerReceipt>
  stop(): Promise<void>
}>

export type LocalCodexLabGatewayAuthorityHost = Readonly<{
  mintPolicy(binding: LabGatewayBinding): Readonly<{
    credential: string
    policy: LabGatewayPolicy
  }>
  createLifecycleResolver(input: {
    db: OrchestrationDb
    runtimeEpoch: string
    profileId: string
  }): LabDispatchGatewayServerOptions['resolveLifecycle']
  createRpcInvoker(runtime: OrcaRuntimeService): LabDispatchGatewayServerOptions['invokeRpc']
  createServer(options: LabDispatchGatewayServerOptions): LocalCodexLabGatewayServer
}>

/**
 * Mints one process-local gateway authority for an already admitted laboratory Dispatch.
 *
 * Construction is side-effect free: the Unix socket is not opened until `start()`. That lets the
 * launch composer materialize and attest the exact 0700 Dispatch root before publication while
 * still preserving the required gateway -> external auth -> provider launch order.
 */
export function createLocalCodexLabGatewayAuthority(
  input: Readonly<{
    prepared: PreparedLocalLabWorkerStart
    identity: Readonly<StructuredWorkerIdentity>
    dispatchCapability: string
    runtime: OrcaRuntimeService
    db: OrchestrationDb
  }>,
  host: LocalCodexLabGatewayAuthorityHost = NATIVE_LOCAL_CODEX_LAB_GATEWAY_HOST
): LocalCodexLabGatewayAuthority {
  const dispatchId = input.prepared.started.dispatch.id
  const binding = Object.freeze({
    runId: input.prepared.started.dispatch.run_id,
    taskId: input.prepared.started.dispatch.task_id,
    dispatchId,
    terminalHandle: input.identity.handle,
    terminalPaneKey: input.identity.paneKey
  })
  const minted = host.mintPolicy(binding)
  const endpoint = join(CODEX_LAB_RUNTIME_ROOT, 'dispatches', dispatchId, 'gateway.sock')
  const server = host.createServer({
    endpoint,
    policy: minted.policy,
    processIncarnation: input.identity.processIncarnation,
    dispatchCapability: input.dispatchCapability,
    resolveLifecycle: host.createLifecycleResolver({
      db: input.db,
      runtimeEpoch: input.runtime.getRuntimeId(),
      profileId: input.prepared.admission.profile
    }),
    invokeRpc: host.createRpcInvoker(input.runtime)
  })

  return Object.freeze({
    endpoint,
    credential: minted.credential,
    start: () => server.start(),
    stop: () => server.stop()
  })
}

const NATIVE_LOCAL_CODEX_LAB_GATEWAY_HOST: LocalCodexLabGatewayAuthorityHost = Object.freeze({
  mintPolicy: (binding) => mintLabGatewayPolicy(binding),
  createLifecycleResolver: (input) => createLabGatewayLifecycleResolver(input),
  createRpcInvoker: (runtime) => createOrcaLabGatewayRpcInvoker(runtime),
  createServer: (options) => new LabDispatchGatewayServer(options)
})
