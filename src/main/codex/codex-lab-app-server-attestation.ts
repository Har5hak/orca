import {
  CODEX_LAB_ATTESTATION_METHODS,
  CODEX_LAB_DYNAMIC_TOOL_GATEWAY_MAP,
  createCodexLabAttestationSurface,
  type CodexLabAppServerAttestationFailureReason,
  type CodexLabAppServerAttestationInput,
  type CodexLabAppServerAttestationResult
} from './codex-lab-app-server-attestation-contract'
import { validateCodexLabAccount } from './codex-lab-app-server-account'
import {
  readCodexLabEffectiveConfig,
  validateCodexLabEffectiveConfig
} from './codex-lab-app-server-effective-config'
import { readCodexLabPermissionProfiles } from './codex-lab-app-server-permission-profiles'
import {
  readCodexLabRequirements,
  validateCodexLabRequirements
} from './codex-lab-app-server-requirements'
import {
  validateCodexLabOpenedThread,
  validateCodexLabThreadStartRequest
} from './codex-lab-app-server-thread-policy'

export * from './codex-lab-app-server-attestation-contract'

export async function probeCodexLabAppServerReadiness(
  input: CodexLabAppServerAttestationInput
): Promise<CodexLabAppServerAttestationResult> {
  const requestFailure = validateCodexLabThreadStartRequest(input.threadStartParams, input.expected)
  if (requestFailure) {
    return notReady('thread_request_unverified', requestFailure.field)
  }
  const threadFailure = validateCodexLabOpenedThread(input.openedThread, input.expected)
  if (threadFailure) {
    return notReady('thread_result_unverified', threadFailure.field)
  }

  const surface = createCodexLabAttestationSurface(input.connection)
  let accountResponse: unknown
  let rateLimitsResponse: unknown
  let configResponse: unknown
  let requirementsResponse: unknown
  try {
    accountResponse = await surface.request('account/read', {}, { timeoutMs: input.timeoutMs })
    rateLimitsResponse = await surface.request('account/rateLimits/read', undefined, {
      timeoutMs: input.timeoutMs
    })
    configResponse = await surface.request(
      'config/read',
      { includeLayers: true, cwd: input.expected.cwd },
      { timeoutMs: input.timeoutMs }
    )
    requirementsResponse = await surface.request('configRequirements/read', undefined, {
      timeoutMs: input.timeoutMs
    })
  } catch {
    return notReady('rpc_unavailable', 'required attestation read')
  }

  const accountValidation = validateCodexLabAccount(
    accountResponse,
    rateLimitsResponse,
    input.expected,
    input.externalAuthReceipt
  )
  if (!accountValidation.ready) {
    return notReady(accountValidation.reason, accountValidation.field)
  }

  const config = readCodexLabEffectiveConfig(configResponse)
  if (!config) {
    return notReady('response_invalid', 'config/read')
  }
  const configFailure = validateCodexLabEffectiveConfig(config, input.expected)
  if (configFailure) {
    return notReady('effective_config_broadened', configFailure.field)
  }

  const requirements = readCodexLabRequirements(requirementsResponse)
  if (requirements === undefined) {
    return notReady('response_invalid', 'configRequirements/read')
  }
  const requirementsFailure = validateCodexLabRequirements(requirements, input.expected)
  if (requirementsFailure) {
    return notReady('requirements_broadened', requirementsFailure.field)
  }

  const profileRead = await readCodexLabPermissionProfiles(
    surface,
    input.expected.cwd,
    input.timeoutMs
  )
  if (profileRead.kind === 'unavailable') {
    return notReady('rpc_unavailable', 'permissionProfile/list')
  }
  if (profileRead.kind === 'invalid') {
    return notReady('response_invalid', profileRead.field)
  }
  const selected = profileRead.profiles.filter(
    (profile) => profile.id === input.expected.permissionProfileId
  )
  if (selected.length !== 1) {
    return notReady('permission_profile_unavailable', 'permissionProfile/list.data')
  }
  if (!selected[0].allowed) {
    return notReady('permission_profile_denied', 'permissionProfile/list.data.allowed')
  }

  return {
    ready: true,
    evidence: {
      methods: CODEX_LAB_ATTESTATION_METHODS,
      permissionProfileId: input.expected.permissionProfileId,
      permissionProfilePages: profileRead.pages,
      managedRequirements: requirements === null ? 'absent' : 'compatible',
      accountRoute: 'chatgpt-workspace',
      capacityRoute: accountValidation.capacityRoute,
      dynamicToolGatewayMap: CODEX_LAB_DYNAMIC_TOOL_GATEWAY_MAP,
      outOfBandMethods: 'not-requested-by-attestation-probe'
    }
  }
}

function notReady(
  reason: CodexLabAppServerAttestationFailureReason,
  field: string
): CodexLabAppServerAttestationResult {
  return { ready: false, reason, field }
}
