import { describe, expect, it } from 'vitest'
import type { LinearWorkspace } from '../../shared/linear/workspace-types'
import { resolveWorkspaceSelector } from './issue-context-workspaces'

function workspace(id: string, organizationName: string): LinearWorkspace {
  return {
    id,
    organizationId: id,
    organizationName,
    displayName: 'Ada',
    email: 'ada@example.com'
  }
}

describe('Linear workspace selectors', () => {
  it('resolves an unambiguous exact workspace name', () => {
    const selected = resolveWorkspaceSelector({ workspaceId: 'second workspace' }, [
      workspace('workspace-1', 'First Workspace'),
      workspace('workspace-2', 'Second Workspace')
    ])

    expect(selected?.id).toBe('workspace-2')
  })

  it('rejects an ambiguous exact workspace name', () => {
    expect(() =>
      resolveWorkspaceSelector({ workspaceId: 'Shared' }, [
        workspace('workspace-1', 'Shared'),
        workspace('workspace-2', 'Shared')
      ])
    ).toThrowError(expect.objectContaining({ code: 'linear_workspace_ambiguous' }))
  })
})
