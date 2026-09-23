import type { LinearProjectMilestoneSummary } from '../../shared/linear/project-types'
import type { LinearLabel } from '../../shared/linear/workspace-types'
import { getClients } from './client'
import { LinearWriteFailure, runLinearWrite } from './linear-issue-write-support'

const PROJECT_MILESTONES_QUERY = `
  query OrcaLinearProjectMilestones($id: String!, $first: Int!, $after: String) {
    project(id: $id) {
      projectMilestones(first: $first, after: $after) {
        nodes { id name status targetDate progress }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`

type ProjectMilestonesResponse = {
  project?: {
    projectMilestones?: {
      nodes?: LinearProjectMilestoneSummary[] | null
      pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null
    } | null
  } | null
}

export async function listProjectMilestonesForAgent(
  projectId: string,
  workspaceId: string
): Promise<LinearProjectMilestoneSummary[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    throw new LinearWriteFailure('failed', 'Not connected to Linear')
  }
  return runLinearWrite(entry, undefined, async (client) => {
    const milestones: LinearProjectMilestoneSummary[] = []
    let after: string | undefined
    while (true) {
      const result = await client.client.rawRequest<
        ProjectMilestonesResponse,
        Record<string, unknown>
      >(PROJECT_MILESTONES_QUERY, { id: projectId, first: 50, ...(after ? { after } : {}) })
      const connection = result.data?.project?.projectMilestones
      if (!result.data?.project) {
        throw new Error('Project was not found')
      }
      const nodes = connection?.nodes ?? []
      milestones.push(...nodes)
      const nextCursor = connection?.pageInfo?.endCursor ?? undefined
      if (
        !connection?.pageInfo?.hasNextPage ||
        !nextCursor ||
        nextCursor === after ||
        nodes.length === 0
      ) {
        return milestones
      }
      after = nextCursor
    }
  })
}

export async function updateLabelDescriptionForAgent(
  labelId: string,
  description: string,
  workspaceId: string,
  options: { signal?: AbortSignal } = {}
): Promise<LinearLabel> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    throw new LinearWriteFailure('failed', 'Not connected to Linear')
  }
  return runLinearWrite(entry, options.signal, async (client) => {
    const result = await (await client.issueLabel(labelId)).update({ description })
    if (!result.success) {
      throw new LinearWriteFailure('failed', 'Linear label update failed')
    }
    const label = await client.issueLabel(labelId)
    if ((label.description ?? '') !== description) {
      throw new LinearWriteFailure('unconfirmed', 'Linear label update could not be confirmed')
    }
    return {
      id: label.id,
      name: label.name,
      color: label.color,
      description: label.description ?? null
    }
  })
}
