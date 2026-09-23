import type { LinearWorkspaceCandidate } from '../../shared/linear/agent-access'
import type { LinearWorkspace } from '../../shared/linear/workspace-types'
import { linearError } from './issue-context-errors'

export function resolveWorkspaceSelector(
  selectors: {
    workspaceId?: string | null
    organizationUrlKey?: string | null
  },
  workspaces: LinearWorkspace[]
): LinearWorkspace | null {
  if (workspaces.length === 0) {
    return null
  }
  const normalizedWorkspace = selectors.workspaceId?.toLocaleLowerCase()
  const byId = normalizedWorkspace
    ? workspaces.find((workspace) => workspace.id.toLocaleLowerCase() === normalizedWorkspace)
    : null
  const byName =
    normalizedWorkspace && !byId
      ? workspaces.filter(
          (workspace) => workspace.organizationName.toLocaleLowerCase() === normalizedWorkspace
        )
      : []
  if (byName.length > 1) {
    throw ambiguousWorkspaceInput(byName, selectors.workspaceId ?? '')
  }
  const byWorkspace = byId ?? byName[0] ?? null
  const byOrg = selectors.organizationUrlKey
    ? workspaces.find((workspace) => workspace.organizationUrlKey === selectors.organizationUrlKey)
    : null

  if (selectors.workspaceId && !byWorkspace) {
    throw unknownWorkspace(selectors.workspaceId)
  }
  if (selectors.organizationUrlKey && !byOrg) {
    throw linearError(
      'linear_invalid_workspace',
      `Linear organization ${selectors.organizationUrlKey} is not connected.`,
      {
        nextSteps: ['Connect that Linear workspace or pass --workspace for a connected workspace.']
      }
    )
  }
  if (byWorkspace && byOrg && byWorkspace.id !== byOrg.id) {
    throw linearError('linear_invalid_workspace', 'The issue URL and --workspace do not match.', {
      nextSteps: [
        `Retry with --workspace ${byOrg.id} or use an issue URL from ${byWorkspace.organizationName}.`
      ]
    })
  }
  return byWorkspace ?? byOrg ?? null
}

function ambiguousWorkspaceInput(
  workspaces: LinearWorkspace[],
  input: string
): ReturnType<typeof linearError> {
  const candidates: LinearWorkspaceCandidate[] = workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.organizationName
  }))
  return linearError(
    'linear_workspace_ambiguous',
    `Multiple Linear workspaces exactly matched ${input}.`,
    {
      candidates,
      nextSteps: candidates.map(
        (candidate) => `Retry with --workspace ${candidate.id} for ${candidate.name}.`
      )
    }
  )
}

export function unknownWorkspace(workspaceId: string): ReturnType<typeof linearError> {
  return linearError('linear_invalid_workspace', `Unknown Linear workspace ${workspaceId}.`, {
    nextSteps: ['Run `orca linear search <query> --workspace all --json` to inspect workspace ids.']
  })
}

export function ambiguousWorkspace(
  workspaces: LinearWorkspace[],
  identifier: string
): ReturnType<typeof linearError> {
  const candidates: LinearWorkspaceCandidate[] = workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.organizationName
  }))
  return linearError(
    'linear_workspace_ambiguous',
    `Linear issue ${identifier} exists in more than one workspace.`,
    {
      candidates,
      nextSteps: candidates.map(
        (candidate) => `Retry with --workspace ${candidate.id} for ${candidate.name}.`
      )
    }
  )
}
