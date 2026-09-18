import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Narrow supply-chain pin for the first attended macOS laboratory canary.
 *
 * The archive digest comes from OpenAI's `codex-package_SHA256SUMS` for rust-v0.155.0. The binary
 * digest was derived from that verified archive, independently of the installed file. Updating
 * Codex therefore requires an explicit reviewed pin change instead of silently trusting PATH or a
 * mutable `current` symlink.
 */
export const SUPPORTED_CODEX_LAB_RELEASE = Object.freeze({
  version: '0.155.0',
  target: 'aarch64-apple-darwin',
  archiveSha256: 'b1411ec00ac410467e05cf8fb5b063cf83632613530201cd4724ef8dd0e9c33f',
  binarySha256: 'b0b14f9c1901c1ec44671094b2dc18b39e4bd8d36a6dc2302cc9d961a7e2a197'
} as const)

export type SupportedCodexLabExecutable = Readonly<{
  path: string
  pinnedSha256: string
}>

export type CodexLabSupportedBinaryHost = Readonly<{
  platform: NodeJS.Platform
  architecture: string
  homePath: string
  readUtf8(path: string): string
  realpath(path: string): string
}>

/** Resolves only the exact checksum-pinned standalone release; PATH is never consulted. */
export function resolveSupportedCodexLabExecutable(
  host: CodexLabSupportedBinaryHost = NATIVE_CODEX_LAB_SUPPORTED_BINARY_HOST
): SupportedCodexLabExecutable {
  if (host.platform !== 'darwin' || host.architecture !== 'arm64') {
    throw new Error('The pinned Codex laboratory executable supports only Apple Silicon macOS.')
  }
  const releaseRoot = join(
    host.homePath,
    '.codex',
    'packages',
    'standalone',
    'releases',
    `${SUPPORTED_CODEX_LAB_RELEASE.version}-${SUPPORTED_CODEX_LAB_RELEASE.target}`
  )
  const packageManifestPath = join(releaseRoot, 'codex-package.json')
  const executablePath = join(releaseRoot, 'bin', 'codex')
  const manifest = parsePackageManifest(host.readUtf8(packageManifestPath))
  if (
    manifest.layoutVersion !== 1 ||
    manifest.version !== SUPPORTED_CODEX_LAB_RELEASE.version ||
    manifest.target !== SUPPORTED_CODEX_LAB_RELEASE.target ||
    manifest.variant !== 'codex' ||
    manifest.entrypoint !== 'bin/codex'
  ) {
    throw new Error('The installed Codex standalone package does not match the laboratory pin.')
  }
  if (host.realpath(executablePath) !== executablePath) {
    throw new Error('The pinned Codex laboratory executable path is not canonical.')
  }
  return Object.freeze({
    path: executablePath,
    pinnedSha256: SUPPORTED_CODEX_LAB_RELEASE.binarySha256
  })
}

function parsePackageManifest(raw: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('The installed Codex standalone package manifest is invalid.')
  }
  if (!isUnknownRecord(parsed)) {
    throw new Error('The installed Codex standalone package manifest is invalid.')
  }
  return parsed
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const NATIVE_CODEX_LAB_SUPPORTED_BINARY_HOST: CodexLabSupportedBinaryHost = Object.freeze({
  platform: process.platform,
  architecture: process.arch,
  homePath: homedir(),
  readUtf8: (path) => readFileSync(path, 'utf8'),
  realpath: (path) => realpathSync(path)
})
