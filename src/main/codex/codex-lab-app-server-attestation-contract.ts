import type { CodexAppServerConnection } from './codex-app-server-connection-types'
import { CODEX_LAB_DYNAMIC_TOOL_BINDINGS } from './codex-lab-dynamic-tool-contract'

export const CODEX_LAB_DYNAMIC_TOOL_GATEWAY_MAP = CODEX_LAB_DYNAMIC_TOOL_BINDINGS

export const CODEX_LAB_ATTESTATION_METHODS = Object.freeze([
  'account/read',
  'config/read',
  'configRequirements/read',
  'permissionProfile/list'
] as const)

export const CODEX_LAB_FORBIDDEN_OUT_OF_BAND_METHODS = Object.freeze([
  'thread/shellCommand',
  'process/*'
] as const)

const ATTESTATION_METHODS = new Set<string>(CODEX_LAB_ATTESTATION_METHODS)

type CodexLabAttestationMethod = (typeof CODEX_LAB_ATTESTATION_METHODS)[number]

export type CodexLabAttestationSurface = Readonly<{
  request(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ): Promise<unknown>
}>

export type CodexLabAppServerAttestationExpected = Readonly<{
  cwd: string
  codexHome: string
  fakeHome: string
  workspaceId: string
  permissionProfileId: string
}>

export type CodexLabAppServerAttestationInput = Readonly<{
  connection: Pick<CodexAppServerConnection, 'request'>
  expected: CodexLabAppServerAttestationExpected
  threadStartParams: unknown
  openedThread: unknown
  timeoutMs?: number
}>

export type CodexLabAppServerAttestationFailureReason =
  | 'thread_request_unverified'
  | 'thread_result_unverified'
  | 'rpc_unavailable'
  | 'response_invalid'
  | 'account_unverified'
  | 'effective_config_broadened'
  | 'requirements_broadened'
  | 'permission_profile_unavailable'
  | 'permission_profile_denied'

export type CodexLabAppServerAttestationResult =
  | Readonly<{
      ready: true
      evidence: Readonly<{
        methods: typeof CODEX_LAB_ATTESTATION_METHODS
        permissionProfileId: string
        permissionProfilePages: number
        managedRequirements: 'absent' | 'compatible'
        accountRoute: 'chatgpt-workspace'
        dynamicToolGatewayMap: typeof CODEX_LAB_DYNAMIC_TOOL_GATEWAY_MAP
        outOfBandMethods: 'not-requested-by-attestation-probe'
      }>
    }>
  | Readonly<{
      ready: false
      reason: CodexLabAppServerAttestationFailureReason
      field: string
    }>

export class CodexLabAppServerMethodRefusedError extends Error {
  readonly method: string

  constructor(method: string) {
    super(`Codex laboratory app-server surface refuses ${method}`)
    this.name = 'CodexLabAppServerMethodRefusedError'
    this.method = method
  }
}

export function createCodexLabAttestationSurface(
  upstream: Pick<CodexAppServerConnection, 'request'>
): CodexLabAttestationSurface {
  return Object.freeze({
    request(
      method: string,
      params?: Record<string, unknown>,
      options?: { timeoutMs?: number }
    ): Promise<unknown> {
      if (!ATTESTATION_METHODS.has(method)) {
        return Promise.reject(new CodexLabAppServerMethodRefusedError(method))
      }
      return upstream.request(method, params, options)
    }
  })
}

export function isCodexLabAttestationMethod(method: string): method is CodexLabAttestationMethod {
  return ATTESTATION_METHODS.has(method)
}
