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
    ? exactRecord(permissions[expected.permissionProfileId], [
        'description',
        'extends',
        'workspace_roots',
        'filesystem',
        'network'
      ])
    : null
  if (!profile || !nonEmptyString(profile.description) || profile.extends !== ':read-only') {
    return invalid(`config.permissions.${expected.permissionProfileId}`)
  }
  const roots = exactRecord(profile.workspace_roots, [expected.cwd])
  if (!roots || roots[expected.cwd] !== true) {
    return invalid(`config.permissions.${expected.permissionProfileId}.workspace_roots`)
  }
  const filesystemFailure = validateFilesystem(profile.filesystem, expected.permissionProfileId)
  if (filesystemFailure) {
    return filesystemFailure
  }
  return validateNetwork(profile.network, expected.permissionProfileId)
}

function validateFilesystem(value: unknown, profileId: string): ValidationFailure | null {
  const filesystem = knownRecord(value, [
    'glob_scan_max_depth',
    ':root',
    ':minimal',
    ':tmpdir',
    ':slash_tmp',
    ':workspace_roots'
  ])
  const workspace = filesystem ? exactRecord(filesystem[':workspace_roots'], ['.']) : null
  if (
    !filesystem ||
    !isAbsent(filesystem.glob_scan_max_depth) ||
    filesystem[':root'] !== 'deny' ||
    filesystem[':minimal'] !== 'read' ||
    filesystem[':tmpdir'] !== 'deny' ||
    filesystem[':slash_tmp'] !== 'deny' ||
    workspace?.['.'] !== 'read'
  ) {
    return invalid(`config.permissions.${profileId}.filesystem`)
  }
  return null
}

function validateNetwork(value: unknown, profileId: string): ValidationFailure | null {
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
    network.enabled !== false ||
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
    !emptyRecord(network.unix_sockets)
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

function emptyRecord(value: unknown): boolean {
  const object = record(value)
  return Boolean(object && Object.keys(object).length === 0)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
