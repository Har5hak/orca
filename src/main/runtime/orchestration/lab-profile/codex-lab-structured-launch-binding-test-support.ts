import { createHash } from 'node:crypto'
import {
  CodexLabDynamicToolHost,
  createCodexLabDynamicToolHostFactory,
  type CodexLabDynamicToolHostAttestation,
  type CodexLabDynamicToolHostFactory,
  type CodexLabDynamicToolHostPort,
  type CodexLabDynamicToolGatewayBinding
} from '../../../codex/codex-lab-dynamic-tool-host'
import type { LabGatewayServerReceipt } from './dispatch-gateway-server'
import { createLabGatewayPolicyReceipt } from './dispatch-gateway-policy'
import {
  CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
  LAB_READONLY_SUPERVISED_PROFILE_ID,
  type CodexLabLaunchFacts
} from './codex-lab-launch-contract'
import {
  registerCodexLabStructuredLaunchBinding,
  releaseCodexLabStructuredLaunchBinding
} from './codex-lab-structured-launch-binding-registry-internal'
import type { CodexLabStructuredLaunchBinding } from './codex-lab-structured-launch-binding-registry'
import { buildSealedCodexLabLaunchPlan } from './codex-sealed-launch-plan'
import { codexLabCapacityPolicy } from './codex-lab-usage-authorization'
import { verifyLabWorktreeObservation } from './lab-worktree-observation'

export const TEST_LAB_DISPATCH_ID = 'dispatch-757-structured'
export const TEST_LAB_WORKTREE_IDENTITY = 'wt2:local:disposable-structured'
export const TEST_LAB_WORKTREE_PATH = '/private/tmp/orca-lab/disposable-structured'
export const TEST_LAB_GATEWAY_ENDPOINT =
  '/private/tmp/orca-lab/runtime/dispatches/dispatch-757-structured/gateway.sock'
export const TEST_LAB_GATEWAY_CREDENTIAL = `lgw1_${'g'.repeat(43)}`

export function testCodexLabDynamicToolHostFactory(
  overrides: Readonly<{
    dispatchId?: string
    endpoint?: string
    credential?: string
  }> = {}
): CodexLabDynamicToolHostFactory {
  return createCodexLabDynamicToolHostFactory(testCodexLabDynamicToolGatewayBinding(overrides))
}

export function testCodexLabDynamicToolGatewayBinding(
  overrides: Readonly<{
    dispatchId?: string
    endpoint?: string
    credential?: string
  }> = {}
): CodexLabDynamicToolGatewayBinding {
  const dispatchId = overrides.dispatchId ?? TEST_LAB_DISPATCH_ID
  const endpoint = overrides.endpoint ?? TEST_LAB_GATEWAY_ENDPOINT
  const endpointIdentity = Object.freeze({
    device: '1',
    inode: '757',
    uid: '501',
    mode: '0600' as const,
    type: 'socket' as const
  })
  const policyReceipt = createLabGatewayPolicyReceipt({
    schemaVersion: 1,
    policyId: 'policy-757-structured',
    credentialSha256: sha256(overrides.credential ?? TEST_LAB_GATEWAY_CREDENTIAL),
    binding: {
      runId: 'run-757-structured',
      taskId: 'task-757-structured',
      dispatchId,
      terminalHandle: 'structworker_33333333-3333-4333-8333-333333333333',
      terminalPaneKey:
        'agent-session-11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'
    },
    revoked: false,
    workerDoneAccepted: false,
    terminal: false
  })
  const stableReceipt = Object.freeze({
    schema: 'orca.lab-dispatch-gateway.v1' as const,
    policyId: 'policy-757-structured',
    dispatchId,
    transport: 'unix' as const,
    socketMode: '0600' as const,
    endpointSha256: sha256(endpoint),
    endpointIdentity,
    endpointIdentitySha256: sha256(JSON.stringify(endpointIdentity)),
    processIncarnationSha256: '1'.repeat(64),
    policyReceipt,
    allowedOperations: Object.freeze([
      'worker.status',
      'worker.check',
      'worker.heartbeat',
      'worker.ask',
      'worker.reply.consume',
      'worker.done'
    ] as const),
    lifecycleSource: 'injected-per-request' as const,
    dcapCustody: 'server-only' as const
  })
  const expectedReceipt: LabGatewayServerReceipt = Object.freeze({
    ...stableReceipt,
    receiptSha256: sha256(JSON.stringify(stableReceipt))
  })
  return Object.freeze({
    endpoint,
    credential: overrides.credential ?? TEST_LAB_GATEWAY_CREDENTIAL,
    expectedReceipt
  })
}

export function testCodexLabDynamicToolHostAttestation(
  overrides: Readonly<{
    dispatchId?: string
    endpoint?: string
    credential?: string
  }> = {}
): CodexLabDynamicToolHostAttestation {
  return Object.freeze({
    dispatchId: overrides.dispatchId ?? TEST_LAB_DISPATCH_ID,
    endpointSha256: sha256(overrides.endpoint ?? TEST_LAB_GATEWAY_ENDPOINT),
    gatewayAccessSha256: sha256(overrides.credential ?? TEST_LAB_GATEWAY_CREDENTIAL)
  })
}

export function testCodexLabDynamicToolHost(
  overrides: Parameters<typeof testCodexLabDynamicToolGatewayBinding>[0] = {},
  callGateway?: ConstructorParameters<typeof CodexLabDynamicToolHost>[1]
): CodexLabDynamicToolHostPort {
  return new CodexLabDynamicToolHost(testCodexLabDynamicToolGatewayBinding(overrides), callGateway)
}

export function testCodexLabStructuredLaunchBinding(
  overrides: Readonly<{ dispatchId?: string }> = {}
): CodexLabStructuredLaunchBinding {
  const dispatchId = overrides.dispatchId ?? TEST_LAB_DISPATCH_ID
  const gatewayEndpoint = `/private/tmp/orca-lab/runtime/dispatches/${dispatchId}/gateway.sock`
  const facts: CodexLabLaunchFacts = {
    platform: 'darwin',
    profile: LAB_READONLY_SUPERVISED_PROFILE_ID,
    adapter: CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
    dispatch: {
      id: dispatchId,
      runtimeRoot: '/private/tmp/orca-lab/runtime',
      codexHomeState: 'absent',
      fakeHomeState: 'absent'
    },
    worktree: {
      identity: TEST_LAB_WORKTREE_IDENTITY,
      expectedPath: TEST_LAB_WORKTREE_PATH,
      observedPath: TEST_LAB_WORKTREE_PATH,
      observedRealPath: TEST_LAB_WORKTREE_PATH,
      kind: 'directory',
      disposable: true
    },
    gateway: {
      socketPath: gatewayEndpoint,
      credential: TEST_LAB_GATEWAY_CREDENTIAL
    },
    binary: {
      path: '/Applications/ChatGPT.app/Contents/Resources/codex',
      observedRealPath: '/Applications/ChatGPT.app/Contents/Resources/codex',
      kind: 'regular-file',
      executable: true,
      pinnedSha256: 'a'.repeat(64),
      observedSha256: 'a'.repeat(64)
    },
    authentication: {
      loginMethod: 'chatgpt',
      expectedWorkspaceId: '018f47a2-9d72-7cc1-b046-7a2868411f42',
      observedWorkspaceId: '018f47a2-9d72-7cc1-b046-7a2868411f42',
      subscription: {
        status: 'active',
        scope: 'workspace',
        unambiguous: true,
        planType: 'business'
      },
      capacityPolicy: codexLabCapacityPolicy({
        workspaceId: '018f47a2-9d72-7cc1-b046-7a2868411f42',
        planType: 'business',
        authorization: null
      }),
      authJson: { state: 'absent' }
    },
    ambientEnv: {}
  }
  const plan = buildSealedCodexLabLaunchPlan(facts)
  const worktree = verifyLabWorktreeObservation({
    admission: Object.freeze({
      profile: LAB_READONLY_SUPERVISED_PROFILE_ID,
      adapter: CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
      agent: 'codex',
      maxConcurrency: 1,
      worktreeIdentity: TEST_LAB_WORKTREE_IDENTITY,
      worktreeInstanceId: 'disposable-structured',
      expectedWorktreePath: TEST_LAB_WORKTREE_PATH
    }),
    evidence: {
      lookup: {
        state: 'found',
        selector: `identity:${TEST_LAB_WORKTREE_IDENTITY}`,
        identity: TEST_LAB_WORKTREE_IDENTITY,
        executionHostId: 'local',
        kind: 'git-worktree',
        path: TEST_LAB_WORKTREE_PATH,
        preExisting: true,
        disposable: true
      },
      realpath: {
        state: 'directory',
        requestedPath: TEST_LAB_WORKTREE_PATH,
        canonicalPath: TEST_LAB_WORKTREE_PATH
      },
      git: {
        state: 'observed',
        repositoryRoot: { pinned: TEST_LAB_WORKTREE_PATH, observed: TEST_LAB_WORKTREE_PATH },
        commonDirectory: {
          pinned: '/private/tmp/orca-lab/repository.git',
          observed: '/private/tmp/orca-lab/repository.git'
        },
        headCommit: { pinned: '1'.repeat(40), observed: '1'.repeat(40) },
        treeHash: { pinned: '2'.repeat(40), observed: '2'.repeat(40) },
        statusPorcelainV2: ''
      }
    }
  })
  return Object.freeze({
    dispatchId,
    plan,
    worktree,
    labDynamicToolHostFactory: testCodexLabDynamicToolHostFactory({
      dispatchId,
      endpoint: gatewayEndpoint
    })
  })
}

/** Installs one test binding and returns its idempotent, dispatch-fenced cleanup. */
export function installTestCodexLabStructuredLaunchBinding(
  sessionId: string,
  binding: CodexLabStructuredLaunchBinding
): () => void {
  registerCodexLabStructuredLaunchBinding(sessionId, binding)
  let active = true
  return () => {
    if (!active) {
      return
    }
    active = false
    releaseCodexLabStructuredLaunchBinding(sessionId, binding.dispatchId)
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
