import {
  type getLinearIssueByUuidForAgent,
  type LinearIssueTaskUpdateRequest,
  type LinearIssueTaskUpdateResult,
  type LinearIssueSummary,
  type LinearLabelDescriptionUpdateRequest,
  type LinearLabelDescriptionUpdateResult,
  getLinearTeamLabelsOrThrow,
  linearError,
  sameStringSet,
  randomUUID,
  LinearAgentAccessError,
  updateLabelDescriptionForAgent
} from './runtime-linear-command-dependencies'
import { RuntimeLinearProjectWriteCommands } from './runtime-linear-project-write-commands'

export class RuntimeLinearLabelWriteCommands extends RuntimeLinearProjectWriteCommands {
  public async linearLabelUpdateDescription(
    params: LinearLabelDescriptionUpdateRequest
  ): Promise<LinearLabelDescriptionUpdateResult> {
    const team = await this.resolveLinearTeamInput(params.teamInput, params.workspaceId)
    const labels = await this.getLinearTeamLabelsForWrite(team.id, team.workspaceId)
    const label = this.resolveLinearLabel(params.labelInput, labels)
    const previousDescription = label.description ?? null
    const targetDescription = params.description.length === 0 ? null : params.description
    const alreadySet = previousDescription === targetDescription
    const writeId = params.writeId ?? randomUUID()
    const method = 'linear.labelUpdateDescription'
    const receipt = this.linearMutationReceipt(writeId, method, {
      workspaceId: team.workspaceId,
      teamId: team.id,
      labelId: label.id,
      description: params.description
    })
    const retryCommandArgs = [
      'orca',
      'linear',
      'label',
      'description',
      'set',
      `--team=${team.id}`,
      `--label=${label.id}`,
      `--description=${params.description}`,
      `--workspace=${team.workspaceId}`,
      `--write-id=${writeId}`,
      '--json'
    ]
    if (receipt.disposition === 'completed') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Completed receipts are written from this exact result contract below.
      const recorded = JSON.parse(
        receipt.receipt ?? 'null'
      ) as LinearLabelDescriptionUpdateResult | null
      const refreshed = await this.getLinearTeamLabelsForWrite(team.id, team.workspaceId)
      const observed = refreshed.find((candidate) => candidate.id === label.id)
      if (!recorded || !observed || (observed.description ?? null) !== targetDescription) {
        throw linearError(
          'linear_invalid_write_id',
          'The completed write receipt no longer matches the Linear label.'
        )
      }
      return {
        ...recorded,
        label: {
          id: observed.id,
          name: observed.name,
          description: observed.description ?? null
        },
        meta: { ...recorded.meta, writeId, deduplicated: true }
      }
    }
    if (receipt.disposition === 'pending') {
      const refreshed = await this.getLinearTeamLabelsForWrite(team.id, team.workspaceId)
      const observed = refreshed.find((candidate) => candidate.id === label.id)
      if (!observed || (observed.description ?? null) !== targetDescription) {
        throw this.linearUpdateUnconfirmed(
          writeId,
          team.workspaceId,
          null,
          'The original mutation is still pending and was not sent again.',
          retryCommandArgs
        )
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Pending receipts are written from the checkpoint contract below.
      const checkpoint = JSON.parse(receipt.receipt ?? 'null') as {
        previousDescription?: string | null
      } | null
      if (!checkpoint || checkpoint.previousDescription === undefined) {
        throw linearError('linear_invalid_write_id', 'The pending write receipt is incomplete.')
      }
      const result: LinearLabelDescriptionUpdateResult = {
        label: {
          id: observed.id,
          name: observed.name,
          description: observed.description ?? null
        },
        previousDescription: checkpoint.previousDescription,
        meta: { workspaceId: team.workspaceId, alreadySet: false, writeId, deduplicated: true }
      }
      try {
        this.completeMutationReceipt(writeId, method, receipt.payloadHash, JSON.stringify(result))
      } catch (error) {
        throw this.linearUpdateUnconfirmed(
          writeId,
          team.workspaceId,
          null,
          error instanceof Error ? error.message : undefined,
          retryCommandArgs
        )
      }
      return result
    }
    this.checkpointMutationReceipt(
      writeId,
      method,
      receipt.payloadHash,
      JSON.stringify({ previousDescription })
    )
    let updated = label
    let confirmed = alreadySet
    try {
      if (!alreadySet) {
        updated = await this.runLinearAgentWrite(
          (signal) =>
            updateLabelDescriptionForAgent(label.id, params.description, team.workspaceId, {
              signal
            }),
          (cause) =>
            this.linearUpdateUnconfirmed(writeId, team.workspaceId, null, cause, retryCommandArgs)
        )
        confirmed = true
      }
      const result: LinearLabelDescriptionUpdateResult = {
        label: {
          id: updated.id,
          name: updated.name,
          description: updated.description ?? null
        },
        previousDescription,
        meta: { workspaceId: team.workspaceId, alreadySet, writeId, deduplicated: false }
      }
      this.completeMutationReceipt(writeId, method, receipt.payloadHash, JSON.stringify(result))
      return result
    } catch (error) {
      if (
        confirmed &&
        !(error instanceof LinearAgentAccessError && error.code === 'linear_write_unconfirmed')
      ) {
        throw this.linearUpdateUnconfirmed(
          writeId,
          team.workspaceId,
          null,
          error instanceof Error ? error.message : undefined,
          retryCommandArgs
        )
      }
      if (!(error instanceof LinearAgentAccessError && error.code === 'linear_write_unconfirmed')) {
        this.discardMutationReceipt(writeId)
      }
      throw error
    }
  }

  public resolveLinearLabel<T extends { id: string; name: string }>(input: string, labels: T[]): T {
    const normalized = input.toLocaleLowerCase()
    const idMatch = labels.find((label) => label.id.toLocaleLowerCase() === normalized)
    if (idMatch) {
      return idMatch
    }
    const nameMatches = labels.filter((label) => label.name.toLocaleLowerCase() === normalized)
    if (nameMatches.length === 1) {
      return nameMatches[0]
    }
    throw linearError(
      'linear_invalid_label',
      nameMatches.length === 0
        ? `No label exactly matched "${input}".`
        : `Multiple labels exactly matched "${input}".`,
      { labels: labels.map(({ id, name }) => ({ id, name })) }
    )
  }

  public async resolveLinearLabelsForIssue(
    issue: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
    inputs: string[],
    workspaceId: string
  ): Promise<{ id: string; name: string }[]> {
    const labels = await this.getLinearTeamLabelsForWrite(issue.team.id, workspaceId)
    const resolved = inputs.map((input) => {
      const normalized = input.toLocaleLowerCase()
      const idMatch = labels.find((label) => label.id.toLocaleLowerCase() === normalized)
      if (idMatch) {
        return { id: idMatch.id, name: idMatch.name }
      }
      const nameMatches = labels.filter((label) => label.name.toLocaleLowerCase() === normalized)
      if (nameMatches.length === 1) {
        return { id: nameMatches[0].id, name: nameMatches[0].name }
      }
      throw linearError(
        'linear_invalid_label',
        nameMatches.length === 0
          ? `No label exactly matched "${input}".`
          : `Multiple labels exactly matched "${input}".`,
        {
          labels: labels.map((label) => ({ id: label.id, name: label.name })),
          nextSteps: ['Run `orca linear team labels --team <key-or-id> --json` and retry by id.']
        }
      )
    })
    return Array.from(new Map(resolved.map((label) => [label.id, label])).values())
  }

  public async resolveLinearLabelsForTeam(
    teamId: string,
    inputs: string[],
    workspaceId: string
  ): Promise<{ id: string; name: string }[]> {
    const labels = await this.getLinearTeamLabelsForWrite(teamId, workspaceId)
    const resolved = inputs.map((input) => this.resolveLinearLabel(input, labels))
    return Array.from(new Map(resolved.map((label) => [label.id, label])).values())
  }

  public linearTaskFieldAlreadySet(
    operation: LinearIssueTaskUpdateRequest['operation'],
    record: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
    update: {
      fields: {
        assigneeId?: string | null
        priority?: number
        estimate?: number | null
        dueDate?: string | null
        labelIds?: string[]
        projectMilestoneId?: string | null
      }
    }
  ): boolean {
    if (operation === 'assignee') {
      return (record.assignee?.id ?? null) === update.fields.assigneeId
    }
    if (operation === 'priority') {
      return record.priority === update.fields.priority
    }
    if (operation === 'estimate') {
      return (record.estimate ?? null) === update.fields.estimate
    }
    if (operation === 'dueDate') {
      return (record.dueDate ?? null) === update.fields.dueDate
    }
    if (operation === 'labels') {
      const recordLabelIds = record.labelIds ?? record.labels?.map((label) => label.id) ?? []
      return sameStringSet(recordLabelIds, update.fields.labelIds ?? [])
    }
    if (operation === 'projectMilestone') {
      return (record.projectMilestone?.id ?? null) === update.fields.projectMilestoneId
    }
    return false
  }

  public linearTaskUpdateResult(
    operation: LinearIssueTaskUpdateRequest['operation'],
    issue: LinearIssueSummary,
    workspaceId: string,
    previous: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
    current: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
    alreadySet: boolean
  ): LinearIssueTaskUpdateResult {
    return {
      issue: this.linearWriteIssueRef(issue),
      operation,
      previous: this.linearTaskResultFields(previous),
      current: this.linearTaskResultFields(current),
      meta: { workspaceId, alreadySet }
    }
  }

  public linearTaskResultFields(
    record: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>
  ): LinearIssueTaskUpdateResult['current'] {
    return {
      assignee: record.assignee ?? null,
      priority: record.priority ?? null,
      estimate: record.estimate ?? null,
      dueDate: record.dueDate ?? null,
      labels: record.labels ?? [],
      projectMilestone: record.projectMilestone ?? null
    }
  }
  public async getLinearTeamLabelsForWrite(
    teamId: string,
    workspaceId: string
  ): Promise<Awaited<ReturnType<typeof getLinearTeamLabelsOrThrow>>> {
    try {
      return await getLinearTeamLabelsOrThrow(teamId, workspaceId)
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
  }
}
