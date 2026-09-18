import type { CodexLabAppServerAttestationExpected } from './codex-lab-app-server-attestation-contract'
import {
  exactRecord,
  invalid,
  isAbsent,
  isEmptyOrAbsentRecord,
  record,
  type ValidationFailure
} from './codex-lab-app-server-value'

export function validateCodexLabPermissionConfig(
  value: unknown,
  expected: CodexLabAppServerAttestationExpected
): ValidationFailure | null {
  const permissions = exactRecord(value, [expected.permissionProfileId])
  const profile = permissions
    ? knownRecord(permissions[expected.permissionProfileId], [
        'description',
        'extends',
        'filesystem',
        'network',
        'workspace_roots'
      ])
    : null
  if (
    !profile ||
    !nonEmptyString(profile.description) ||
    profile.extends !== ':read-only' ||
    !isAbsent(profile.filesystem) ||
    !isAbsent(profile.workspace_roots)
  ) {
    return invalid(`config.permissions.${expected.permissionProfileId}`)
  }
  return validateNetwork(profile.network, expected)
}

function validateNetwork(
  value: unknown,
  expected: CodexLabAppServerAttestationExpected
): ValidationFailure | null {
  const profileId = expected.permissionProfileId
  const network = knownRecord(value, [
    'enabled',
    'proxy_url',
    'enable_socks5',
    'socks_url',
    'enable_socks5_udp',
    'allow_local_binding',
    'allow_upstream_proxy',
    'dangerously_allow_non_loopback_proxy',
    'dangerously_allow_all_unix_sockets',
    'mode',
    'domains',
    'unix_sockets',
    'mitm'
  ])
  if (
    !network ||
    network.enabled !== true ||
    !isAbsent(network.proxy_url) ||
    !isAbsent(network.enable_socks5) ||
    !isAbsent(network.socks_url) ||
    !isAbsent(network.enable_socks5_udp) ||
    network.allow_local_binding !== false ||
    network.allow_upstream_proxy !== false ||
    !(
      isAbsent(network.dangerously_allow_non_loopback_proxy) ||
      network.dangerously_allow_non_loopback_proxy === false
    ) ||
    network.dangerously_allow_all_unix_sockets !== false ||
    !isAbsent(network.mode) ||
    !isEmptyOrAbsentRecord(network.domains) ||
    !isAbsent(network.mitm) ||
    !exactUnixSocket(network.unix_sockets, expected.gatewaySocketPath)
  ) {
    return invalid(`config.permissions.${profileId}.network`)
  }
  return null
}

function knownRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const object = record(value)
  if (!object || Object.keys(object).some((key) => !keys.includes(key))) {
    return null
  }
  return object
}

function exactUnixSocket(value: unknown, path: string): boolean {
  const sockets = exactRecord(value, [path])
  return sockets?.[path] === 'allow'
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
