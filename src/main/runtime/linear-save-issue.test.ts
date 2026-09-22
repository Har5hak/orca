import { afterEach, describe, expect, it, vi } from 'vitest'
import { LINEAR_WRITE_BODY_CAP } from '../../shared/linear/agent-access'
import * as linearTeams from '../linear/teams'
import * as linearAdmin from '../linear/linear-admin-mutations'
import * as linearIssueMutations from '../linear/linear-issue-mutations'
import { OrchestrationDb } from './orchestration/db/orchestration-db'
import { OrcaRuntimeService } from './orca-runtime'

const issue = {
  id: 'issue-1',
  identifier: 'ENG-1',
  title: 'Existing title',
  description: 'Existing description',
  url: 'https://linear.app/acme/issue/ENG-1',
  team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
  state: { id: 'state-1', name: 'Todo' },
  parent: null,
  project: null,
  assignee: null,
  priority: 0,
  estimate: null,
  dueDate: null,
  labelIds: [],
  labels: []
}

const receiptDatabases: OrchestrationDb[] = []

type SaveIssueInternals = {
  resolveLinearAssignee(input: string, teamId: string, workspaceId: string): Promise<string>
  resolveLinearAgentState(input: string, states: unknown[]): unknown
  buildLinearSaveUpdate(
    params: { labels?: string[] },
    current: typeof issue,
    workspaceId: string
  ): Promise<{ labelIds?: string[] }>
}

type AdminInternals = SaveIssueInternals & {
  linearIssueUpdateTask(params: {
    input: string
    operation: 'projectMilestone'
    projectMilestone: string | null
    workspaceId: string
    writeId?: string
  }): Promise<unknown>
  buildLinearTaskUpdate(
    params: { operation: 'projectMilestone'; projectMilestone: string | null },
    current: Omit<typeof issue, 'project'> & {
      project: { id: string; name: string } | null
      projectMilestone?: { id: string; name: string } | null
    },
    workspaceId: string
  ): Promise<{ fields: { projectMilestoneId?: string | null } } | null>
  linearTaskFieldAlreadySet(
    operation: 'projectMilestone',
    current: Omit<typeof issue, 'project'> & {
      project: { id: string; name: string } | null
      projectMilestone?: { id: string; name: string } | null
    },
    update: { fields: { projectMilestoneId?: string | null } }
  ): boolean
  resolveLinearLabel<T extends { id: string; name: string }>(input: string, labels: T[]): T
  mapLinearReadFailure(error: unknown): Error & { code?: string }
  linearLabelUpdateDescription(params: {
    teamInput: string
    labelInput: string
    description: string
    workspaceId?: string
    writeId?: string
  }): Promise<unknown>
  resolveLinearTeamInput: ReturnType<typeof vi.fn>
  getLinearTeamLabelsForWrite: ReturnType<typeof vi.fn>
  runLinearAgentWrite: ReturnType<typeof vi.fn>
  readLinearAgentIssueWriteRecord: ReturnType<typeof vi.fn>
  notifyLinearLinkedIssueUpdated: ReturnType<typeof vi.fn>
  resolveLinearAgentWriteTarget: ReturnType<typeof vi.fn>
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const database of receiptDatabases.splice(0)) {
    database.close()
  }
})

function runtimeWithReceipts(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  const database = new OrchestrationDb(':memory:')
  receiptDatabases.push(database)
  runtime.setOrchestrationDb(database)
  return runtime
}

describe('Linear save issue', () => {
  it('resolves project milestones by exact id or unambiguous exact name and supports clear', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test-only access to public runtime mixin methods omitted from the facade type.
    const runtime = runtimeWithReceipts() as unknown as AdminInternals
    vi.spyOn(linearAdmin, 'listProjectMilestonesForAgent').mockResolvedValue([
      { id: 'milestone-1', name: 'Public beta' },
      { id: 'milestone-2', name: 'General availability' }
    ])
    const projectIssue = {
      ...issue,
      project: { id: 'project-1', name: 'Launch' },
      projectMilestone: null
    }

    await expect(
      runtime.buildLinearTaskUpdate(
        { operation: 'projectMilestone', projectMilestone: 'public beta' },
        projectIssue,
        'workspace-1'
      )
    ).resolves.toEqual({ fields: { projectMilestoneId: 'milestone-1' } })
    await expect(
      runtime.buildLinearTaskUpdate(
        { operation: 'projectMilestone', projectMilestone: null },
        projectIssue,
        'workspace-1'
      )
    ).resolves.toEqual({ fields: { projectMilestoneId: null } })
  })

  it('rejects absent and ambiguous exact milestone and label matches', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test-only access to public runtime mixin methods omitted from the facade type.
    const runtime = new OrcaRuntimeService() as unknown as AdminInternals
    vi.spyOn(linearAdmin, 'listProjectMilestonesForAgent').mockResolvedValue([
      { id: 'milestone-1', name: 'Launch' },
      { id: 'milestone-2', name: 'Launch' }
    ])
    const projectIssue = {
      ...issue,
      project: { id: 'project-1', name: 'Launch' },
      projectMilestone: null
    }

    await expect(
      runtime.buildLinearTaskUpdate(
        { operation: 'projectMilestone', projectMilestone: 'Missing' },
        projectIssue,
        'workspace-1'
      )
    ).rejects.toMatchObject({ code: 'linear_invalid_project' })
    await expect(
      runtime.buildLinearTaskUpdate(
        { operation: 'projectMilestone', projectMilestone: 'Launch' },
        projectIssue,
        'workspace-1'
      )
    ).rejects.toMatchObject({ code: 'linear_invalid_project' })
    expect(() =>
      runtime.resolveLinearLabel('Needs QA', [
        { id: 'label-1', name: 'Needs QA' },
        { id: 'label-2', name: 'Needs QA' }
      ])
    ).toThrowError(expect.objectContaining({ code: 'linear_invalid_label' }))
  })

  it('detects stale milestone readback and maps permission failures', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test-only access to public runtime mixin methods omitted from the facade type.
    const runtime = new OrcaRuntimeService() as unknown as AdminInternals
    expect(
      runtime.linearTaskFieldAlreadySet(
        'projectMilestone',
        { ...issue, projectMilestone: { id: 'old', name: 'Old' } },
        { fields: { projectMilestoneId: 'new' } }
      )
    ).toBe(false)
    expect(runtime.mapLinearReadFailure(new Error('403 forbidden'))).toMatchObject({
      code: 'linear_permission_denied'
    })
  })

  it('updates a label description and returns confirmed readback', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test-only access to public runtime mixin methods omitted from the facade type.
    const runtime = runtimeWithReceipts() as unknown as AdminInternals
    runtime.resolveLinearTeamInput = vi.fn(async () => ({
      id: 'team-1',
      key: 'ENG',
      name: 'Engineering',
      workspaceId: 'workspace-1'
    }))
    runtime.getLinearTeamLabelsForWrite = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 'label-1', name: 'Needs QA', color: '#fff', description: null }
      ])
      .mockResolvedValueOnce([
        {
          id: 'label-1',
          name: 'Needs QA',
          color: '#fff',
          description: 'Requires verification.'
        }
      ])
    runtime.runLinearAgentWrite = vi.fn(async (write: (signal: AbortSignal) => Promise<unknown>) =>
      write(new AbortController().signal)
    )
    vi.spyOn(linearAdmin, 'updateLabelDescriptionForAgent').mockImplementation(
      async (_labelId, _description, _workspaceId, readback) => {
        const label = await readback()
        if (!label) {
          throw new Error('missing label')
        }
        return label
      }
    )

    await expect(
      runtime.linearLabelUpdateDescription({
        teamInput: 'ENG',
        labelInput: 'Needs QA',
        description: 'Requires verification.',
        workspaceId: 'workspace-1',
        writeId: '11111111-1111-4111-8111-111111111111'
      })
    ).resolves.toEqual({
      label: {
        id: 'label-1',
        name: 'Needs QA',
        description: 'Requires verification.'
      },
      previousDescription: null,
      meta: {
        workspaceId: 'workspace-1',
        alreadySet: false,
        writeId: '11111111-1111-4111-8111-111111111111',
        deduplicated: false
      }
    })
  })

  it('deduplicates label-description replays and rejects changed payloads before mutation', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test-only access to public runtime mixin methods omitted from the facade type.
    const runtime = runtimeWithReceipts() as unknown as AdminInternals
    const initial = { id: 'label-1', name: 'Needs QA', color: '#fff', description: null }
    const updated = { ...initial, description: 'Requires verification.' }
    runtime.resolveLinearTeamInput = vi.fn(async () => ({
      id: 'team-1',
      key: 'ENG',
      name: 'Engineering',
      workspaceId: 'workspace-1'
    }))
    runtime.getLinearTeamLabelsForWrite = vi
      .fn()
      .mockResolvedValueOnce([initial])
      .mockResolvedValueOnce([updated])
      .mockResolvedValueOnce([updated])
      .mockResolvedValueOnce([updated])
      .mockResolvedValueOnce([updated])
    runtime.runLinearAgentWrite = vi.fn(async (write: (signal: AbortSignal) => Promise<unknown>) =>
      write(new AbortController().signal)
    )
    const update = vi
      .spyOn(linearAdmin, 'updateLabelDescriptionForAgent')
      .mockImplementation(async (_labelId, _description, _workspaceId, readback) => {
        const label = await readback()
        if (!label) {
          throw new Error('missing label')
        }
        return label
      })
    const request = {
      teamInput: 'ENG',
      labelInput: 'Needs QA',
      description: 'Requires verification.',
      workspaceId: 'workspace-1',
      writeId: '33333333-3333-4333-8333-333333333333'
    }

    await expect(runtime.linearLabelUpdateDescription(request)).resolves.toMatchObject({
      meta: { writeId: request.writeId, deduplicated: false }
    })
    await expect(runtime.linearLabelUpdateDescription(request)).resolves.toMatchObject({
      meta: { writeId: request.writeId, deduplicated: true }
    })
    await expect(
      runtime.linearLabelUpdateDescription({ ...request, description: 'Different intent' })
    ).rejects.toMatchObject({ code: 'linear_invalid_write_id' })
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('deduplicates milestone replays and rejects stale write identities before mutation', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test-only access to public runtime mixin methods omitted from the facade type.
    const runtime = runtimeWithReceipts() as unknown as AdminInternals
    const current = {
      ...issue,
      project: { id: 'project-1', name: 'Launch' },
      projectMilestone: null
    }
    const updated = {
      ...current,
      projectMilestone: { id: 'milestone-1', name: 'Public beta' }
    }
    const stale = {
      ...current,
      projectMilestone: { id: 'milestone-2', name: 'General availability' }
    }
    runtime.resolveLinearAgentWriteTarget = vi.fn(async () => ({
      issue: current,
      workspaceId: 'workspace-1'
    }))
    runtime.readLinearAgentIssueWriteRecord = vi
      .fn()
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(updated)
      .mockResolvedValueOnce(updated)
      .mockResolvedValueOnce(updated)
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(stale)
    runtime.notifyLinearLinkedIssueUpdated = vi.fn(async () => undefined)
    vi.spyOn(linearAdmin, 'listProjectMilestonesForAgent').mockResolvedValue([
      { id: 'milestone-1', name: 'Public beta' },
      { id: 'milestone-2', name: 'General availability' }
    ])
    const update = vi.spyOn(linearIssueMutations, 'updateIssueForAgent').mockResolvedValue(updated)
    const request = {
      input: 'ENG-1',
      operation: 'projectMilestone' as const,
      projectMilestone: 'Public beta',
      workspaceId: 'workspace-1',
      writeId: '44444444-4444-4444-8444-444444444444'
    }

    await expect(runtime.linearIssueUpdateTask(request)).resolves.toMatchObject({
      meta: { writeId: request.writeId, deduplicated: false }
    })
    await expect(runtime.linearIssueUpdateTask(request)).resolves.toMatchObject({
      meta: { writeId: request.writeId, deduplicated: true }
    })
    await expect(runtime.linearIssueUpdateTask(request)).rejects.toMatchObject({
      code: 'linear_invalid_write_id'
    })
    await expect(
      runtime.linearIssueUpdateTask({ ...request, projectMilestone: null })
    ).rejects.toMatchObject({ code: 'linear_invalid_write_id' })
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('mints and returns a durable receipt for milestone clear', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test-only access to public runtime mixin methods omitted from the facade type.
    const runtime = runtimeWithReceipts() as unknown as AdminInternals
    const current = {
      ...issue,
      project: { id: 'project-1', name: 'Launch' },
      projectMilestone: { id: 'milestone-1', name: 'Public beta' }
    }
    const cleared = { ...current, projectMilestone: null }
    runtime.resolveLinearAgentWriteTarget = vi.fn(async () => ({
      issue: current,
      workspaceId: 'workspace-1'
    }))
    runtime.readLinearAgentIssueWriteRecord = vi
      .fn()
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(cleared)
    runtime.notifyLinearLinkedIssueUpdated = vi.fn(async () => undefined)
    const update = vi.spyOn(linearIssueMutations, 'updateIssueForAgent').mockResolvedValue(cleared)

    await expect(
      runtime.linearIssueUpdateTask({
        input: 'ENG-1',
        operation: 'projectMilestone',
        projectMilestone: null,
        workspaceId: 'workspace-1'
      })
    ).resolves.toMatchObject({
      meta: {
        writeId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        deduplicated: false
      }
    })
    expect(update).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      name: 'set',
      initialMilestone: null,
      requestedMilestone: 'Public beta',
      confirmedMilestone: { id: 'milestone-1', name: 'Public beta' },
      staleMilestone: null
    },
    {
      name: 'clear',
      initialMilestone: { id: 'milestone-1', name: 'Public beta' },
      requestedMilestone: null,
      confirmedMilestone: null,
      staleMilestone: { id: 'milestone-1', name: 'Public beta' }
    }
  ])(
    'keeps the $name receipt pending when the final milestone read is stale',
    async ({ initialMilestone, requestedMilestone, confirmedMilestone, staleMilestone }) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test-only access to public runtime mixin methods omitted from the facade type.
      const runtime = runtimeWithReceipts() as unknown as AdminInternals
      const current = {
        ...issue,
        project: { id: 'project-1', name: 'Launch' },
        projectMilestone: initialMilestone
      }
      const confirmed = { ...current, projectMilestone: confirmedMilestone }
      const stale = { ...current, projectMilestone: staleMilestone }
      runtime.resolveLinearAgentWriteTarget = vi.fn(async () => ({
        issue: current,
        workspaceId: 'workspace-1'
      }))
      runtime.readLinearAgentIssueWriteRecord = vi
        .fn()
        .mockResolvedValueOnce(current)
        .mockResolvedValueOnce(stale)
        .mockResolvedValueOnce(stale)
        .mockResolvedValueOnce(stale)
      runtime.notifyLinearLinkedIssueUpdated = vi.fn(async () => undefined)
      vi.spyOn(linearAdmin, 'listProjectMilestonesForAgent').mockResolvedValue([
        { id: 'milestone-1', name: 'Public beta' }
      ])
      const update = vi
        .spyOn(linearIssueMutations, 'updateIssueForAgent')
        .mockResolvedValue(confirmed)
      const request = {
        input: 'ENG-1',
        operation: 'projectMilestone' as const,
        projectMilestone: requestedMilestone,
        workspaceId: 'workspace-1',
        writeId: '55555555-5555-4555-8555-555555555555'
      }

      await expect(runtime.linearIssueUpdateTask(request)).rejects.toMatchObject({
        code: 'linear_write_unconfirmed',
        data: { writeId: request.writeId }
      })
      await expect(runtime.linearIssueUpdateTask(request)).rejects.toMatchObject({
        code: 'linear_write_unconfirmed',
        data: { writeId: request.writeId }
      })
      expect(update).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps a confirmed milestone write pending when the final read fails', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test-only access to public runtime mixin methods omitted from the facade type.
    const runtime = runtimeWithReceipts() as unknown as AdminInternals
    const current = {
      ...issue,
      project: { id: 'project-1', name: 'Launch' },
      projectMilestone: null
    }
    const updated = {
      ...current,
      projectMilestone: { id: 'milestone-1', name: 'Public beta' }
    }
    runtime.resolveLinearAgentWriteTarget = vi.fn(async () => ({
      issue: current,
      workspaceId: 'workspace-1'
    }))
    runtime.readLinearAgentIssueWriteRecord = vi
      .fn()
      .mockResolvedValueOnce(current)
      .mockRejectedValueOnce(new Error('final read failed'))
      .mockResolvedValueOnce(updated)
      .mockResolvedValueOnce(updated)
    runtime.notifyLinearLinkedIssueUpdated = vi.fn(async () => undefined)
    vi.spyOn(linearAdmin, 'listProjectMilestonesForAgent').mockResolvedValue([
      { id: 'milestone-1', name: 'Public beta' }
    ])
    const update = vi.spyOn(linearIssueMutations, 'updateIssueForAgent').mockResolvedValue(updated)
    const request = {
      input: 'ENG-1',
      operation: 'projectMilestone' as const,
      projectMilestone: 'Public beta',
      workspaceId: 'workspace-1',
      writeId: '66666666-6666-4666-8666-666666666666'
    }

    await expect(runtime.linearIssueUpdateTask(request)).rejects.toMatchObject({
      code: 'linear_write_unconfirmed',
      data: { writeId: request.writeId }
    })
    await expect(runtime.linearIssueUpdateTask(request)).resolves.toMatchObject({
      current: { projectMilestone: { id: 'milestone-1', name: 'Public beta' } },
      meta: { writeId: request.writeId, deduplicated: true }
    })
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('does not let a local notification failure invalidate a confirmed milestone write', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test-only access to public runtime mixin methods omitted from the facade type.
    const runtime = runtimeWithReceipts() as unknown as AdminInternals
    const current = {
      ...issue,
      project: { id: 'project-1', name: 'Launch' },
      projectMilestone: null
    }
    const updated = {
      ...current,
      projectMilestone: { id: 'milestone-1', name: 'Public beta' }
    }
    runtime.resolveLinearAgentWriteTarget = vi.fn(async () => ({
      issue: current,
      workspaceId: 'workspace-1'
    }))
    runtime.readLinearAgentIssueWriteRecord = vi
      .fn()
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(updated)
      .mockResolvedValueOnce(updated)
      .mockResolvedValueOnce(updated)
    runtime.notifyLinearLinkedIssueUpdated = vi.fn(async () => {
      throw new Error('local notification failed')
    })
    vi.spyOn(linearAdmin, 'listProjectMilestonesForAgent').mockResolvedValue([
      { id: 'milestone-1', name: 'Public beta' }
    ])
    const update = vi.spyOn(linearIssueMutations, 'updateIssueForAgent').mockResolvedValue(updated)
    const request = {
      input: 'ENG-1',
      operation: 'projectMilestone' as const,
      projectMilestone: 'Public beta',
      workspaceId: 'workspace-1',
      writeId: '77777777-7777-4777-8777-777777777777'
    }

    await expect(runtime.linearIssueUpdateTask(request)).resolves.toMatchObject({
      meta: { writeId: request.writeId, deduplicated: false }
    })
    await expect(runtime.linearIssueUpdateTask(request)).resolves.toMatchObject({
      meta: { writeId: request.writeId, deduplicated: true }
    })
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('returns an unconfirmed receipt when label readback cannot prove the write', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test-only access to public runtime mixin methods omitted from the facade type.
    const runtime = runtimeWithReceipts() as unknown as AdminInternals
    runtime.resolveLinearTeamInput = vi.fn(async () => ({
      id: 'team-1',
      key: 'ENG',
      name: 'Engineering',
      workspaceId: 'workspace-1'
    }))
    runtime.getLinearTeamLabelsForWrite = vi.fn(async () => [
      { id: 'label-1', name: 'Needs QA', color: '#fff', description: null }
    ])
    runtime.runLinearAgentWrite = vi.fn(
      async (
        _write: (signal: AbortSignal) => Promise<unknown>,
        unconfirmed: (cause?: string) => Error
      ) => {
        throw unconfirmed('readback timed out')
      }
    )

    const request = {
      teamInput: 'ENG',
      labelInput: 'Needs QA',
      description: 'Requires verification.',
      workspaceId: 'workspace-1',
      writeId: '22222222-2222-4222-8222-222222222222'
    }
    await expect(runtime.linearLabelUpdateDescription(request)).rejects.toMatchObject({
      code: 'linear_write_unconfirmed',
      data: {
        cause: 'readback timed out',
        writeId: '22222222-2222-4222-8222-222222222222',
        nextSteps: [expect.stringContaining('--write-id=22222222-2222-4222-8222-222222222222')]
      }
    })
    await expect(runtime.linearLabelUpdateDescription(request)).rejects.toMatchObject({
      code: 'linear_write_unconfirmed',
      data: { writeId: request.writeId }
    })
    expect(runtime.runLinearAgentWrite).toHaveBeenCalledTimes(1)
  })

  it('pins the exact label description and deduplicates its unconfirmed replay', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test-only access to public runtime mixin methods omitted from the facade type.
    const runtime = runtimeWithReceipts() as unknown as AdminInternals
    const description = `Alice's "quoted" $HOME && $(do-not-run) | <review> \`tick\`\nnext line`
    const initial = { id: 'label-1', name: 'Needs QA', color: '#fff', description: null }
    const updated = { ...initial, description }
    runtime.resolveLinearTeamInput = vi.fn(async () => ({
      id: 'team-1',
      key: 'ENG',
      name: 'Engineering',
      workspaceId: 'workspace-1'
    }))
    runtime.getLinearTeamLabelsForWrite = vi
      .fn()
      .mockResolvedValueOnce([initial])
      .mockResolvedValueOnce([updated])
      .mockResolvedValueOnce([updated])
    runtime.runLinearAgentWrite = vi.fn(
      async (
        write: (signal: AbortSignal) => Promise<unknown>,
        unconfirmed: (cause?: string) => Error
      ) => {
        await write(new AbortController().signal)
        throw unconfirmed('readback timed out')
      }
    )
    const update = vi
      .spyOn(linearAdmin, 'updateLabelDescriptionForAgent')
      .mockResolvedValue(updated)
    const request = {
      teamInput: 'ENG',
      labelInput: 'Needs QA',
      description,
      workspaceId: 'workspace-1',
      writeId: '44444444-4444-4444-8444-444444444444'
    }

    await expect(runtime.linearLabelUpdateDescription(request)).rejects.toMatchObject({
      code: 'linear_write_unconfirmed',
      data: {
        writeId: request.writeId,
        retryCommandArgs: [
          'orca',
          'linear',
          'label',
          'description',
          'set',
          '--team=team-1',
          '--label=label-1',
          `--description=${description}`,
          '--workspace=workspace-1',
          '--write-id=44444444-4444-4444-8444-444444444444',
          '--json'
        ],
        nextSteps: [expect.stringContaining('Retry once with the pinned command:\n')]
      }
    })
    await expect(runtime.linearLabelUpdateDescription(request)).resolves.toMatchObject({
      label: { description },
      meta: { writeId: request.writeId, deduplicated: true }
    })
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith(
      'label-1',
      description,
      'workspace-1',
      expect.any(Function),
      expect.any(Object)
    )
  })

  it('restores an absent label description and deduplicates its unconfirmed replay', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test-only access to public runtime mixin methods omitted from the facade type.
    const runtime = runtimeWithReceipts() as unknown as AdminInternals
    const initial = {
      id: 'label-1',
      name: 'Needs QA',
      color: '#fff',
      description: 'Temporary description'
    }
    const restored = { ...initial, description: null }
    runtime.resolveLinearTeamInput = vi.fn(async () => ({
      id: 'team-1',
      key: 'ENG',
      name: 'Engineering',
      workspaceId: 'workspace-1'
    }))
    runtime.getLinearTeamLabelsForWrite = vi
      .fn()
      .mockResolvedValueOnce([initial])
      .mockResolvedValueOnce([restored])
      .mockResolvedValueOnce([restored])
    runtime.runLinearAgentWrite = vi.fn(
      async (
        write: (signal: AbortSignal) => Promise<unknown>,
        unconfirmed: (cause?: string) => Error
      ) => {
        await write(new AbortController().signal)
        throw unconfirmed('readback timed out')
      }
    )
    const update = vi
      .spyOn(linearAdmin, 'updateLabelDescriptionForAgent')
      .mockResolvedValue(restored)
    const request = {
      teamInput: 'ENG',
      labelInput: 'Needs QA',
      description: '',
      workspaceId: 'workspace-1',
      writeId: '55555555-5555-4555-8555-555555555555'
    }

    await expect(runtime.linearLabelUpdateDescription(request)).rejects.toMatchObject({
      code: 'linear_write_unconfirmed',
      data: {
        writeId: request.writeId,
        retryCommandArgs: expect.arrayContaining(['--description='])
      }
    })
    await expect(runtime.linearLabelUpdateDescription(request)).resolves.toMatchObject({
      label: { description: null },
      previousDescription: 'Temporary description',
      meta: { writeId: request.writeId, deduplicated: true }
    })
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith(
      'label-1',
      '',
      'workspace-1',
      expect.any(Function),
      expect.any(Object)
    )
  })

  it('delegates creates with the MCP-required team and title', async () => {
    const runtime = new OrcaRuntimeService()
    const create = vi.spyOn(runtime, 'linearIssueCreate').mockResolvedValue({
      issue,
      meta: { workspaceId: 'workspace-1', writeId: 'write-1', deduplicated: false }
    })

    await expect(
      runtime.linearSaveIssue({ team: 'ENG', title: 'New issue', workspaceId: 'workspace-1' })
    ).resolves.toMatchObject({ meta: { created: true } })

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        teamInput: 'ENG',
        title: 'New issue',
        workspaceId: 'workspace-1'
      })
    )
  })

  it('keeps team changes explicitly unsupported on updates', async () => {
    const runtime = new OrcaRuntimeService()

    await expect(
      runtime.linearSaveIssue({ input: 'ENG-1', team: 'OPS', title: 'Moved issue' })
    ).rejects.toMatchObject({
      code: 'linear_write_failed',
      message: 'Team can only be set when creating an issue.'
    })
  })

  it('rejects oversized descriptions before resolving an issue or calling Linear', async () => {
    const runtime = new OrcaRuntimeService()
    const resolveTarget = vi.fn()
    Object.assign(runtime, { resolveLinearAgentWriteTarget: resolveTarget })

    await expect(
      runtime.linearSaveIssue({
        input: 'ENG-1',
        description: 'x'.repeat(LINEAR_WRITE_BODY_CAP + 1)
      })
    ).rejects.toMatchObject({ code: 'linear_body_too_large' })
    expect(resolveTarget).not.toHaveBeenCalled()
  })

  it('does not send a mutation or confirmation read when every field is already set', async () => {
    const runtime = new OrcaRuntimeService()
    const runWrite = vi.fn()
    const notify = vi.fn().mockResolvedValue(undefined)
    Object.assign(runtime, {
      resolveLinearAgentWriteTarget: vi
        .fn()
        .mockResolvedValue({ issue, workspaceId: 'workspace-1' }),
      readLinearAgentIssueWriteRecord: vi.fn().mockResolvedValue(issue),
      buildLinearSaveUpdate: vi.fn().mockResolvedValue({ title: issue.title }),
      runLinearAgentWrite: runWrite,
      notifyLinearLinkedIssueUpdated: notify
    })

    await expect(
      runtime.linearSaveIssue({ input: issue.identifier, title: issue.title })
    ).resolves.toMatchObject({ issue, meta: { created: false } })

    expect(runWrite).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('workspace-1', issue.identifier)
  })

  it('accepts user UUIDs without listing every team member', async () => {
    const runtime = new OrcaRuntimeService() as unknown as SaveIssueInternals
    const listMembers = vi.spyOn(linearTeams, 'getTeamMembersOrThrow')
    const userId = '11111111-1111-4111-8111-111111111111'

    await expect(runtime.resolveLinearAssignee(userId, 'team-1', 'workspace-1')).resolves.toBe(
      userId
    )
    expect(listMembers).not.toHaveBeenCalled()
  })

  it('matches assignees by full name or email like Linear MCP', async () => {
    const runtime = new OrcaRuntimeService() as unknown as SaveIssueInternals
    vi.spyOn(linearTeams, 'getTeamMembersOrThrow').mockResolvedValue([
      {
        id: 'user-1',
        displayName: 'Ada',
        name: 'Ada Lovelace',
        email: 'ada@example.com'
      }
    ])

    await expect(
      runtime.resolveLinearAssignee('Ada Lovelace', 'team-1', 'workspace-1')
    ).resolves.toBe('user-1')
    await expect(
      runtime.resolveLinearAssignee('ADA@EXAMPLE.COM', 'team-1', 'workspace-1')
    ).resolves.toBe('user-1')
  })

  it('resolves workflow lifecycle types while preferring exact state names', () => {
    const runtime = new OrcaRuntimeService() as unknown as SaveIssueInternals
    const states = [
      { id: 'state-progress', name: 'In Progress', type: 'started' },
      { id: 'state-started', name: 'Started', type: 'unstarted' }
    ]

    expect(runtime.resolveLinearAgentState('started', states)).toBe(states[1])
    expect(runtime.resolveLinearAgentState('unstarted', states)).toBe(states[1])
  })

  it('clears labels without listing the team label catalog', async () => {
    const runtime = new OrcaRuntimeService() as unknown as SaveIssueInternals
    const listLabels = vi.spyOn(linearTeams, 'getTeamLabelsOrThrow')

    await expect(
      runtime.buildLinearSaveUpdate({ labels: [] }, issue, 'workspace-1')
    ).resolves.toEqual({ labelIds: [] })
    expect(listLabels).not.toHaveBeenCalled()
  })
})
