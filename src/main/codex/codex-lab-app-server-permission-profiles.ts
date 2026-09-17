import type { CodexLabAttestationSurface } from './codex-lab-app-server-attestation-contract'
import { exactRecord } from './codex-lab-app-server-value'

const MAX_PERMISSION_PROFILE_PAGES = 20

export type PermissionProfileSummary = Readonly<{
  id: string
  description: string | null
  allowed: boolean
}>

type PermissionProfilePage = Readonly<{
  data: readonly PermissionProfileSummary[]
  nextCursor: string | null
}>

export type PermissionProfileReadResult =
  | Readonly<{
      kind: 'ok'
      profiles: readonly PermissionProfileSummary[]
      pages: number
    }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'invalid'; field: string }>

export async function readCodexLabPermissionProfiles(
  surface: CodexLabAttestationSurface,
  cwd: string,
  timeoutMs?: number
): Promise<PermissionProfileReadResult> {
  const profiles: PermissionProfileSummary[] = []
  const cursors = new Set<string>()
  let cursor: string | null = null
  for (let pageNumber = 1; pageNumber <= MAX_PERMISSION_PROFILE_PAGES; pageNumber += 1) {
    const response = await requestPage(surface, cwd, cursor, timeoutMs)
    if (response.kind === 'unavailable') {
      return response
    }
    const page = parsePermissionProfilePage(response.value)
    if (!page) {
      return { kind: 'invalid', field: 'permissionProfile/list' }
    }
    profiles.push(...page.data)
    if (page.nextCursor === null) {
      return { kind: 'ok', profiles, pages: pageNumber }
    }
    if (cursors.has(page.nextCursor)) {
      return { kind: 'invalid', field: 'permissionProfile/list.nextCursor' }
    }
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  return { kind: 'invalid', field: 'permissionProfile/list.pagination' }
}

async function requestPage(
  surface: CodexLabAttestationSurface,
  cwd: string,
  cursor: string | null,
  timeoutMs?: number
): Promise<Readonly<{ kind: 'ok'; value: unknown }> | Readonly<{ kind: 'unavailable' }>> {
  try {
    const value = await surface.request(
      'permissionProfile/list',
      cursor ? { cwd, cursor } : { cwd },
      { timeoutMs }
    )
    return { kind: 'ok', value }
  } catch {
    return { kind: 'unavailable' }
  }
}

function parsePermissionProfilePage(value: unknown): PermissionProfilePage | null {
  const page = exactRecord(value, ['data', 'nextCursor'])
  if (!page || !Array.isArray(page.data)) {
    return null
  }
  const data: PermissionProfileSummary[] = []
  const ids = new Set<string>()
  for (const entry of page.data) {
    const profile = exactRecord(entry, ['id', 'description', 'allowed'])
    if (!validProfile(profile) || ids.has(profile.id)) {
      return null
    }
    ids.add(profile.id)
    data.push(profile)
  }
  const nextCursor = page.nextCursor
  if (!(nextCursor === null || nonEmptyString(nextCursor))) {
    return null
  }
  return { data, nextCursor }
}

function validProfile(value: Record<string, unknown> | null): value is PermissionProfileSummary {
  return Boolean(
    value &&
    nonEmptyString(value.id) &&
    (typeof value.description === 'string' || value.description === null) &&
    typeof value.allowed === 'boolean'
  )
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
